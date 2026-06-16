"""Feishu webhook router — receives event subscription callbacks."""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Request

from src.core.orchestrator import Orchestrator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feishu", tags=["feishu"])

# Global refs set during app startup
_orchestrator: Orchestrator | None = None

# ── Deduplication ────────────────────────────────────────────────────────────
# Feishu may deliver the same event_id more than once.
# Keep a sliding window of recently processed event_ids.
_processed_ids: dict[str, float] = {}  # event_id → timestamp
_DEDUP_WINDOW = 60  # seconds


def _is_duplicate(event_id: str) -> bool:
    """Check and mark an event_id. Returns True if already seen."""
    now = time.time()
    # Clean expired entries
    expired = [eid for eid, ts in _processed_ids.items() if now - ts > _DEDUP_WINDOW]
    for eid in expired:
        _processed_ids.pop(eid, None)

    if event_id in _processed_ids:
        return True
    _processed_ids[event_id] = now
    return False


# ── Routes ───────────────────────────────────────────────────────────────────


def init_routes(orchestrator: Orchestrator):
    """Inject shared dependencies into the router module."""
    global _orchestrator
    _orchestrator = orchestrator


@router.post("/webhook")
async def feishu_webhook(request: Request):
    """Receive event callbacks from Feishu Open Platform."""
    body = await request.json()

    # --- Challenge verification ---
    if "challenge" in body and "event" not in body:
        challenge = body.get("challenge", "")
        logger.info("Feishu challenge: %s", challenge[:30])
        return {"challenge": challenge}

    # --- Event dispatch ---
    header = body.get("header", {})
    event_type = header.get("event_type", "")
    event_id = header.get("event_id", "")

    # Deduplicate
    if event_id and _is_duplicate(event_id):
        logger.info("Duplicate event ignored: %s", event_id[:30])
        return {"code": 0, "msg": "duplicate"}

    if event_type == "im.message.receive_v1":
        # Fire-and-forget — Feishu gets 200 immediately, processing runs in background
        asyncio.ensure_future(_handle_message(body.get("event", {})))
        return {"code": 0, "msg": "ok"}

    logger.info("Unhandled event type: %s", event_type)
    return {"code": 0, "msg": "ignored"}


async def _handle_message(event: dict):
    """Process an incoming message event from Feishu."""
    if _orchestrator is None:
        logger.error("Orchestrator not initialized")
        return

    sender = event.get("sender", {})
    sender_id = sender.get("sender_id", {})
    open_id = sender_id.get("open_id", "")
    message = event.get("message", {})
    message_id = message.get("message_id", "")
    message_type = message.get("message_type", "")
    chat_type = message.get("chat_type", "")

    if chat_type != "p2p":
        logger.info("Ignoring non-p2p message: chat_type=%s", chat_type)
        return

    if message_type != "text":
        logger.info("Ignoring non-text message: message_type=%s", message_type)
        return

    try:
        content = json.loads(message.get("content", "{}"))
        text = content.get("text", "").strip()
    except (json.JSONDecodeError, KeyError):
        logger.warning("Failed to parse message content: %s", message.get("content", ""))
        return

    if not text:
        logger.warning("Empty text content, skipping")
        return

    logger.info("Message from %s: %.80s", open_id, text)

    await _orchestrator.process_message(
        sender_id=open_id,
        message_id=message_id,
        content=text,
    )


@router.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "alive", "orchestrator": _orchestrator is not None}
