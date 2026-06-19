"""Orchestrator — routes messages through the Planner → Validator → Runtime pipeline.

New architecture (Plan-then-Execute):
  Planner(LLM) → DSL → Validator → Runtime → Skill 执行 → 回复
"""

import asyncio
import json
import logging

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
        from src.tasks.luckin_mcp import LuckinMCPClient

        self._luckin_mcp = LuckinMCPClient()
        self._deps = SkillDeps(feishu=self.feishu, luckin_mcp=self._luckin_mcp)
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
                await self._process_new(sender_id, content)
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

    # ── Active task: helpers ───────────────────────────────────────────

    @staticmethod
    def _format_active_task(active_task: dict | None) -> str:
        """Format active_task as a human-readable context block for Planner injection.

        Output format: task header → known values (可直接用作字面量) → option lists.
        """
        if not active_task:
            return ""
        lines = []
        task_type = active_task.get("task_type", "unknown")
        stage = active_task.get("stage", "in_progress")
        lines.append(f"当前有未完成任务：{task_type}，进度：{stage}")

        ctx = active_task.get("context", {})

        # ── Known values (可直接用作字面量，不用 {{step.x.output}} 引用) ──
        known = []
        if ctx.get("selected_dept_name") and ctx.get("selected_dept_id"):
            known.append(f"门店名称：{ctx['selected_dept_name']}")
            known.append(f"门店ID：{ctx['selected_dept_id']}")
        elif ctx.get("selected_dept_id"):
            known.append(f"门店ID：{ctx['selected_dept_id']}")
        if known:
            lines.append("当前已知信息（可直接用作参数值，不用引用上一步 output）：")
            for k in known:
                lines.append(f"  · {k}")

        # ── Option lists for user to choose from ────────────────────────
        if ctx.get("store_list"):
            store_summary = "\n".join(
                f"  {i+1}. {s.get('deptName','?')} [dept_id: {s.get('deptId','?')}]"
                for i, s in enumerate(ctx["store_list"])
            )
            lines.append(f"附近门店列表：\n{store_summary}")
        if ctx.get("menu_items"):
            menu_summary = "\n".join(
                f"  {i+1}. {s.get('productName','?')} [ID:{s.get('productId','?')}]"
                for i, s in enumerate(ctx["menu_items"])
            )
            lines.append(f"当前菜单列表：\n{menu_summary}")

        return "\n".join(lines)

    @staticmethod
    def _sync_task_context(active_task: dict | None, session_state: dict) -> dict:
        """Sync relevant keys from session_state into active_task.context.

        Handler-written session_state (selected_dept_id, store_list, etc.)
        is pulled into the task context so the Planner sees it next turn.
        """
        if not active_task or not session_state:
            return (active_task or {}).get("context", {})
        ctx = dict(active_task.get("context", {}))
        for k in ("selected_dept_id", "selected_dept_name", "store_list", "menu_items", "specs_shown"):
            if k in session_state:
                ctx[k] = session_state[k]
        return ctx

    # ── New architecture (Plan-then-Execute) ─────────────────────────────

    async def _process_new(self, sender_id: str, content: str) -> str:
        self._init_new_arch()

        conv = self.history.get_or_create(sender_id)

        # ── Build planner context: session_state + active_task ──────────
        planner_ctx = dict(self._deps.session_state or {})
        if conv.active_task:
            active_task_str = self._format_active_task(conv.active_task)
            if active_task_str:
                planner_ctx["_active_task"] = active_task_str
            planner_ctx["_task_type"] = conv.active_task.get("task_type")
            planner_ctx["_stage"] = conv.active_task.get("stage")

        # Step 1: Planner (generates both ACK and DSL)
        ctx = conv.recent_context(4)
        ack_msg, raw_dsl, candidates = await self._planner.plan(
            content, ctx, planner_ctx
        )

        # Step 0: ACK — only for non-trivial plans (multi-step or action)
        ack_sent = False
        if not self._is_simple_chat(raw_dsl):
            await self.feishu.send_text(sender_id, ack_msg)
            ack_sent = True

        # Step 2: Validator (with retry)
        result = await self._validator.validate(raw_dsl, content)
        if not result.ok:
            # Layer 1 or 3 failure → one retry with error feedback
            if result.layer in (1, 3):
                logger.info("Validation (layer %d) failed, retrying once: %s", result.layer, result.message)
                hint = "格式有误" if result.layer == 1 else "参数有误"
                await self.feishu.send_text(sender_id, f"{hint}，重新规划…")
                # Feed the validation error back to LLM so it can correct
                retry_ctx = dict(planner_ctx)
                retry_ctx["_last_error"] = f"上一次的输出不是合法 JSON：{result.message}。请只输出 JSON，不要包含任何其他文字。"
                ack_msg, raw_dsl, candidates = await self._planner.plan(
                    content, ctx, retry_ctx
                )
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

        # Step 4: Update active_task from plan metadata
        if plan.task_type:
            task_context = self._sync_task_context(conv.active_task, self._deps.session_state)
            conv.active_task = {
                "task_type": plan.task_type,
                "stage": plan.stage or "in_progress",
                "context": task_context,
            }
            logger.info("active_task: %s / %s (ctx: %s)",
                        plan.task_type, conv.active_task["stage"], list(task_context.keys()))
        else:
            if conv.active_task:
                logger.info("active_task cleared — no task_type in DSL")
            conv.active_task = None

        # Step 5: Record history
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

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def close(self):
        """Release resources: close HTTP clients, etc."""
        if hasattr(self, "_luckin_mcp") and self._luckin_mcp is not None:
            try:
                await self._luckin_mcp.close()
                logger.info("LuckinMCPClient closed")
            except Exception as e:
                logger.warning("Failed to close LuckinMCPClient: %s", e)
