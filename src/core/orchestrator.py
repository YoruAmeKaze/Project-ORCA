"""Orchestrator — drives the ReAct agent loop."""

import logging

from src.action.executor import execute
from src.core.agent import run as agent_run
from src.core.history import HistoryManager
from src.core.search import search as web_search
from src.feishu.client import FeishuClient
from src.vision.interpreter import analyze_screenshot
from src.vision.screenshot import capture_screenshot

logger = logging.getLogger(__name__)


class Orchestrator:
    def __init__(self, feishu: FeishuClient):
        self.feishu = feishu
        self.history = HistoryManager()

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

        ctx = self.history.get_or_create(sender_id).recent_context(4)
        reply = await agent_run(
            content,
            ctx,
            on_send=_on_send,
            on_screenshot=_on_screenshot,
            on_action=_on_action,
            on_search=_on_search,
        )

        # Send final reply (if agent didn't already send via send_message)
        if reply:
            await self.feishu.send_text(sender_id, reply)

        self.history.add_turn(sender_id, "assistant", reply, action="agent")
        logger.info("Final reply: %.80s", reply)
        return reply
