"""Feishu (Lark) API client — authentication and message sending."""

import json
import logging
import time

import httpx

logger = logging.getLogger(__name__)

BASE_URL = "https://open.feishu.cn/open-apis"


class FeishuClient:
    """Handles Feishu API authentication and message sending."""

    def __init__(self, app_id: str, app_secret: str):
        self._app_id = app_id
        self._app_secret = app_secret
        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._http = httpx.AsyncClient(timeout=10.0)

    # ── Auth ──────────────────────────────────────────────────────────

    async def _ensure_token(self) -> str:
        """Get a valid tenant_access_token, refreshing if expired."""
        if self._token and time.time() < self._token_expires_at - 60:
            return self._token

        logger.info("Refreshing Feishu tenant_access_token...")
        resp = await self._http.post(
            f"{BASE_URL}/auth/v3/tenant_access_token/internal",
            json={"app_id": self._app_id, "app_secret": self._app_secret},
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("code") != 0:
            raise RuntimeError(f"Feishu auth failed: {data.get('msg', 'unknown')}")

        self._token = data["tenant_access_token"]
        self._token_expires_at = time.time() + data.get("expire", 7200)
        logger.info("Feishu token refreshed, expires in %ds", data.get("expire", 7200))
        return self._token

    # ── Send message ───────────────────────────────────────────────

    async def reply_text(self, message_id: str, text: str) -> bool:
        """Reply to a message in the same conversation thread.

        Args:
            message_id: The message_id from the incoming event.
            text: Plain text to send.

        Returns:
            True if the API call succeeded.
        """
        token = await self._ensure_token()
        payload = {
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        try:
            resp = await self._http.post(
                f"{BASE_URL}/im/v1/messages/{message_id}/reply",
                json=payload,
                headers=headers,
            )
            body = resp.json()
            if body.get("code") != 0:
                logger.error("Feishu reply failed: %s", body.get("msg"))
                return False
            logger.info("Feishu reply sent: %.60s", text)
            return True
        except httpx.HTTPError as e:
            logger.error("Feishu reply HTTP error: %s", e)
            return False

    async def send_text(self, open_id: str, text: str) -> bool:
        """Send a new message to a user by open_id."""
        token = await self._ensure_token()
        payload = {
            "receive_id": open_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        try:
            resp = await self._http.post(
                f"{BASE_URL}/im/v1/messages?receive_id_type=open_id",
                json=payload,
                headers=headers,
            )
            body = resp.json()
            if body.get("code") != 0:
                logger.error("Feishu send failed: %s", body.get("msg"))
                return False
            logger.info("Feishu message sent to %s: %.60s", open_id, text)
            return True
        except httpx.HTTPError as e:
            logger.error("Feishu send HTTP error: %s", e)
            return False

    # ── Image ─────────────────────────────────────────────────────

    async def _upload_image(self, image_bytes: bytes) -> str | None:
        """Upload an image to Feishu and return the image_key."""
        token = await self._ensure_token()
        headers = {"Authorization": f"Bearer {token}"}

        try:
            resp = await self._http.post(
                f"{BASE_URL}/im/v1/images",
                headers=headers,
                data={"image_type": "message"},
                files={"image": ("screenshot.png", image_bytes, "image/png")},
            )
            body = resp.json()
            if body.get("code") != 0:
                logger.error("Feishu image upload failed: %s", body.get("msg"))
                return None
            image_key = body["data"]["image_key"]
            logger.info("Feishu image uploaded: %s", image_key)
            return image_key
        except httpx.HTTPError as e:
            logger.error("Feishu image upload HTTP error: %s", e)
            return None

    async def send_image(self, open_id: str, image_bytes: bytes) -> bool:
        """Send an image as a new message to a user."""
        image_key = await self._upload_image(image_bytes)
        if not image_key:
            return False

        token = await self._ensure_token()
        payload = {
            "receive_id": open_id,
            "msg_type": "image",
            "content": json.dumps({"image_key": image_key}),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        try:
            resp = await self._http.post(
                f"{BASE_URL}/im/v1/messages?receive_id_type=open_id",
                json=payload,
                headers=headers,
            )
            body = resp.json()
            if body.get("code") != 0:
                logger.error("Feishu image send failed: %s", body.get("msg"))
                return False
            logger.info("Feishu image sent to %s: %s", open_id, image_key)
            return True
        except httpx.HTTPError as e:
            logger.error("Feishu image send HTTP error: %s", e)
            return False

    async def close(self):
        await self._http.aclose()
