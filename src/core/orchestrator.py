"""Core orchestrator — ties together screenshot → vision → action → reply."""

import logging

from src.action.executor import execute
from src.core.chat import chat_response
from src.core.history import HistoryManager
from src.feishu.client import FeishuClient
from src.vision.interpreter import interpret
from src.vision.screenshot import capture_screenshot

logger = logging.getLogger(__name__)


class Orchestrator:
    """Processes an incoming message end-to-end."""

    def __init__(self, feishu: FeishuClient):
        self.feishu = feishu
        self.history = HistoryManager()

    async def process_message(self, sender_id: str, message_id: str, content: str) -> str:
        """Process one incoming message.

        Pipeline: screenshot → vision → action → reply

        Args:
            sender_id: Feishu open_id of the sender.
            message_id: Feishu message_id to reply to.
            content: Text content of the message.

        Returns:
            Summary for logging.
        """
        logger.info("Processing message from %s: %.80s", sender_id, content)

        # 1. Store user message in history
        self.history.add_turn(sender_id, "user", content)

        # 2. Screenshot
        try:
            image_bytes, _path = capture_screenshot()
        except RuntimeError as e:
            error_msg = f"截图失败: {e}"
            logger.error(error_msg)
            await self._reply(sender_id, error_msg)
            return error_msg

        # 3. Vision interpretation
        action_result = await interpret(
            user_message=content,
            image_bytes=image_bytes,
        )
        action = action_result.get("action", "none")
        params = action_result.get("params", {})
        reason = action_result.get("reason", "")

        logger.info("Interpreted: action=%s reason=%.80s", action, reason)

        # 4. Handle screenshot — send the actual image
        if action == "screenshot":
            await self.feishu.send_image(sender_id, image_bytes)
            logger.info("Screenshot image sent to %s", sender_id)
            self.history.add_turn(sender_id, "assistant", "[发送截图]", action=action)
            return "screenshot_sent"

        # 5. Chat mode — no desktop action, have a natural conversation
        if action == "none":
            ctx = self.history.get_or_create(sender_id).recent_context(4)
            reply = await chat_response(content, ctx)
            await self._reply(sender_id, reply)
            self.history.add_turn(sender_id, "assistant", reply, action=action)
            logger.info("Chat reply to %s: %.80s", sender_id, reply)
            return reply

        # 6. Execute desktop operations
        execution_result = await execute(action, params)

        # 6. Build and send reply (as new message, not threaded reply)
        reply = self._build_reply(action, params, execution_result, reason)
        await self._reply(sender_id, reply)

        # 7. Store assistant response
        self.history.add_turn(sender_id, "assistant", reply, action=action)

        logger.info("Sent to %s: %.80s", sender_id, reply)
        return reply

    async def _reply(self, open_id: str, content: str):
        """Send a new message to the user (not a threaded reply)."""
        await self.feishu.send_text(open_id, content)

    def _build_reply(
        self,
        action: str,
        params: dict,
        execution_result: str,
        reason: str,
    ) -> str:
        """Compose the reply message."""
        if "失败" in execution_result or "校验失败" in execution_result:
            return f"操作没成功: {execution_result}"

        return execution_result
