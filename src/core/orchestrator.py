"""Orchestrator — routes messages through the Planner → Validator → Runtime pipeline.

Phase 2 migration: controlled by USE_NEW_ARCH config flag.
- USE_NEW_ARCH=true: 新架构 (DSL + Skill Registry + Runtime)
- USE_NEW_ARCH=false: 旧架构 (ReAct loop)
"""

import asyncio
import json
import logging

from src.config import USE_NEW_ARCH
from src.core.history import HistoryManager
from src.feishu.client import FeishuClient

logger = logging.getLogger(__name__)


class Orchestrator:
    def __init__(self, feishu: FeishuClient):
        self.feishu = feishu
        self.history = HistoryManager()

        # Lazy init for new architecture components
        self._planner = None
        self._validator = None
        self._registry = None
        self._engine = None

        # ── Serial lock (D-ORC-04) ──────────────────────────────────────
        self._lock = asyncio.Lock()
        self._pending: list[tuple[str, str]] = []  # (sender_id, content)
        self._busy = False

    # ── Lazy initializers (new arch) ─────────────────────────────────────

    def _init_new_arch(self):
        if self._registry is not None:
            return

        from src.skill.builtins import create_registry
        from src.skill.registry import SkillRegistry
        from src.core.planner import Planner
        from src.dsl.validator import Validator
        from src.runtime.engine import Engine, SkillDeps

        self._registry = create_registry()
        self._planner = Planner(self._registry)
        self._validator = Validator(
            skill_names=self._registry.names,
            skill_schemas=self._registry.schemas,
        )
        self._deps = SkillDeps(feishu=self.feishu)
        self._engine = Engine(self._registry, self._deps)

    # ── Message processing ──────────────────────────────────────────────

    async def process_message(self, sender_id: str, message_id: str, content: str) -> str:
        logger.info("Processing message from %s: %.80s", sender_id, content)
        self.history.add_turn(sender_id, "user", content)

        if self._busy:
            logger.info("Orchestrator busy, queuing message from %s", sender_id)
            self._pending.append((sender_id, content))
            return "queued"

        await self._process_with_lock(sender_id, content)
        return "ok"

    async def _process_with_lock(self, sender_id: str, content: str) -> None:
        """Process a message, holding the serial lock.
        
        After finishing, processes the next queued message if any.
        """
        self._busy = True
        try:
            async with self._lock:
                if USE_NEW_ARCH:
                    await self._process_new(sender_id, content)
                else:
                    await self._process_old(sender_id, content)
        finally:
            self._busy = False

        # Process next queued message
        if self._pending:
            next_sender, next_content = self._pending.pop(0)
            asyncio.create_task(self._process_with_lock(next_sender, next_content))

    @staticmethod
    def _is_simple_chat(raw_dsl: str) -> bool:
        """Check if the DSL is just a single reply step (pure chat, no ACK needed)."""
        try:
            data = json.loads(raw_dsl)
            steps = data.get("steps", [])
            return len(steps) == 1 and steps[0].get("skill") == "reply"
        except (json.JSONDecodeError, KeyError, TypeError):
            return False

    # ── New architecture (Plan-then-Execute) ─────────────────────────────

    async def _process_new(self, sender_id: str, content: str) -> str:
        self._init_new_arch()

        # Step 1: Planner (generates both ACK and DSL)
        ctx = self.history.get_or_create(sender_id).recent_context(4)
        ack_msg, raw_dsl, candidates = await self._planner.plan(content, ctx)

        # Step 0: ACK — only for non-trivial plans (multi-step or action)
        ack_sent = False
        if not self._is_simple_chat(raw_dsl):
            await self.feishu.send_text(sender_id, ack_msg)
            ack_sent = True

        # Step 2: Validator (with retry)
        result = await self._validator.validate(raw_dsl, content)
        if not result.ok:
            # Layer 1 failure → one retry
            if result.layer == 1:
                logger.info("Format validation failed, retrying once: %s", result.message)
                await self.feishu.send_text(sender_id, f"格式有误，重新规划…")
                ack_msg, raw_dsl, candidates = await self._planner.plan(content, ctx)
                # Re-check ACK for retried plan (only if not sent already)
                if not ack_sent and not self._is_simple_chat(raw_dsl):
                    await self.feishu.send_text(sender_id, ack_msg)
                    ack_sent = True
                result = await self._validator.validate(raw_dsl, content)

            if not result.ok:
                error_msg = f"规划校验未通过: {result.message}"
                logger.error(error_msg)
                await self.feishu.send_text(sender_id, error_msg)
                self.history.add_turn(sender_id, "assistant", error_msg, action="plan_error")
                return error_msg

        plan = result.plan
        logger.info("Plan validated: %d steps", len(plan.steps))

        # Step 3: Runtime
        self._deps.session_id = sender_id
        exec_result = await self._engine.execute(plan, sender_id)

        # Step 4: Record history
        if exec_result.results:
            last = exec_result.results[-1]
            self.history.add_turn(
                sender_id, "assistant",
                exec_result.final_message or last.output,
                action="execute",
            )
        else:
            self.history.add_turn(sender_id, "assistant", "没有执行任何操作", action="execute")

        if exec_result.final_message:
            logger.info("Final reply: %.80s", exec_result.final_message)
        return exec_result.final_message

    # ── Old architecture (ReAct loop) ────────────────────────────────────

    async def _process_old(self, sender_id: str, content: str) -> str:
        """Original ReAct-based message processing."""
        from src.action.executor import execute
        from src.core.agent import run as agent_run
        from src.core.search import search as web_search
        from src.tasks.luckin import LuckinClient, LuckinError
        from src.vision.interpreter import analyze_screenshot
        from src.vision.screenshot import capture_screenshot

        # Callback: send a message to the user during processing
        async def _on_send(text: str):
            await self.feishu.send_text(sender_id, text)

        # Callback: take screenshot and analyze with Qwen
        async def _on_screenshot(task: str) -> str:
            try:
                image_bytes, _path = capture_screenshot()
            except RuntimeError as e:
                return f"截图失败: {e}"
            return await analyze_screenshot(image_bytes, task)

        # Callback: execute desktop action
        async def _on_action(action: str, params: dict) -> str:
            return await execute(action, params)

        # Callback: search web
        async def _on_search(query: str) -> str:
            return await web_search(query) or "没有找到相关信息"

        # Callback: luckin lookup (store / menu)
        luckin = LuckinClient()

        async def _on_luckin_lookup(query: str) -> str:
            try:
                if not await luckin.check_login():
                    return "请先登录瑞幸 CLI：在终端执行「luckin login」完成手机验证"
                lat, lng = 39.9042, 116.4074
                stores = await luckin.find_store(lat, lng, query)
                if stores:
                    lines = [f"找到 {len(stores)} 家门店："]
                    for s in stores[:5]:
                        lines.append(f"  · {s.name} (ID: {s.dept_id})")
                    return "\n".join(lines)
                stores = await luckin.find_store(lat, lng)
                if stores:
                    dept_id = stores[0].dept_id
                    products = await luckin.get_menu(dept_id, query)
                    if products:
                        lines = [f"在 {stores[0].name} 找到相关商品："]
                        for p in products[:10]:
                            sku = f" [{p.sku_code}]" if p.sku_code else ""
                            price = f" ¥{p.price}" if p.price else ""
                            lines.append(f"  · {p.name}{price}{sku}")
                        return "\n".join(lines)
                return f"未找到与「{query}」相关的门店或商品"
            except LuckinError as e:
                return f"瑞幸查询失败: {e}"

        async def _on_luckin_order(params_json: str) -> str:
            try:
                params = json.loads(params_json)
            except json.JSONDecodeError:
                return "下单参数格式错误，需要 JSON 字符串"
            try:
                dept_id = params["dept_id"]
                items_data = params["items"]
                lat = params.get("lat", 39.9042)
                lng = params.get("lng", 116.4074)
                coupon = params.get("coupon")

                from src.tasks.luckin import OrderItem
                items = [OrderItem(
                    product_id=i["product_id"],
                    sku_code=i["sku_code"],
                    amount=i.get("amount", 1),
                ) for i in items_data]

                preview = await luckin.preview_order(dept_id, items)
                await self.feishu.send_text(sender_id, f"订单预览已生成，正在下单...")
                result = await luckin.create_order(
                    dept_id=dept_id, lat=lat, lng=lng, items=items, coupon=coupon,
                )
                if result.success:
                    msg = f"下单成功！"
                    if result.order_id:
                        msg += f" 订单号: {result.order_id}"
                    if result.pick_code:
                        msg += f" 取餐码: {result.pick_code}"
                    return msg
                return f"下单失败: {result.message}"
            except LuckinError as e:
                return f"瑞幸下单失败: {e}"
            except KeyError as e:
                return f"下单参数缺少必要字段: {e}"

        ctx = self.history.get_or_create(sender_id).recent_context(4)
        reply = await agent_run(
            content, ctx,
            on_send=_on_send,
            on_screenshot=_on_screenshot,
            on_action=_on_action,
            on_search=_on_search,
            on_luckin_lookup=_on_luckin_lookup,
            on_luckin_order=_on_luckin_order,
        )

        if reply:
            await self.feishu.send_text(sender_id, reply)

        self.history.add_turn(sender_id, "assistant", reply, action="agent")
        logger.info("Final reply: %.80s", reply)
        return reply
