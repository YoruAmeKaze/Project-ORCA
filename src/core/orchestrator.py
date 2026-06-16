"""Orchestrator — drives the ReAct agent loop."""

import json
import logging

from src.action.executor import execute
from src.core.agent import run as agent_run
from src.core.history import HistoryManager
from src.core.search import search as web_search
from src.feishu.client import FeishuClient
from src.tasks.luckin import LuckinClient, LuckinError
from src.vision.interpreter import analyze_screenshot
from src.vision.screenshot import capture_screenshot

logger = logging.getLogger(__name__)


class Orchestrator:
    def __init__(self, feishu: FeishuClient):
        self.feishu = feishu
        self.history = HistoryManager()
        self.luckin = LuckinClient()

    async def process_message(self, sender_id: str, message_id: str, content: str) -> str:
        logger.info("Processing message from %s: %.80s", sender_id, content)
        self.history.add_turn(sender_id, "user", content)

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
        async def _on_luckin_lookup(query: str) -> str:
            try:
                if not await self.luckin.check_login():
                    return "请先登录瑞幸 CLI：在终端执行「luckin login」完成手机验证"
                # Try as store query first (if looks like coordinates or store name)
                # Otherwise search menu — for now use a default Beijing location
                # In production, get user's real location
                lat, lng = 39.9042, 116.4074  # default: Beijing
                stores = await self.luckin.find_store(lat, lng, query)
                if stores:
                    lines = [f"找到 {len(stores)} 家门店："]
                    for s in stores[:5]:
                        lines.append(f"  · {s.name} (ID: {s.dept_id})")
                    return "\n".join(lines)

                # No store match → try product search with first available store
                # Get first nearby store
                stores = await self.luckin.find_store(lat, lng)
                if stores:
                    dept_id = stores[0].dept_id
                    products = await self.luckin.get_menu(dept_id, query)
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

        # Callback: luckin order
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

                # Preview first
                preview = await self.luckin.preview_order(dept_id, items)
                await self.feishu.send_text(sender_id, f"订单预览已生成，正在下单...")

                # Create order
                result = await self.luckin.create_order(
                    dept_id=dept_id,
                    lat=lat,
                    lng=lng,
                    items=items,
                    coupon=coupon,
                )

                if result.success:
                    msg = f"下单成功！"
                    if result.order_id:
                        msg += f" 订单号: {result.order_id}"
                    if result.pick_code:
                        msg += f" 取餐码: {result.pick_code}"
                    return msg
                else:
                    return f"下单失败: {result.message}"
            except LuckinError as e:
                return f"瑞幸下单失败: {e}"
            except KeyError as e:
                return f"下单参数缺少必要字段: {e}"

        ctx = self.history.get_or_create(sender_id).recent_context(4)
        reply = await agent_run(
            content,
            ctx,
            on_send=_on_send,
            on_screenshot=_on_screenshot,
            on_action=_on_action,
            on_search=_on_search,
            on_luckin_lookup=_on_luckin_lookup,
            on_luckin_order=_on_luckin_order,
        )

        # Send final reply (if agent didn't already send via send_message)
        if reply:
            await self.feishu.send_text(sender_id, reply)

        self.history.add_turn(sender_id, "assistant", reply, action="agent")
        logger.info("Final reply: %.80s", reply)
        return reply
