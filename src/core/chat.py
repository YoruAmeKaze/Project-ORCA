"""Chat response generator — natural conversation with Orca persona."""

import json
import logging

import httpx

from src.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL
from src.core.persona import ORCA_PERSONA_PROMPT

logger = logging.getLogger(__name__)


async def chat_response(user_message: str, history: str) -> str:
    """Generate a natural chat response using DeepSeek Flash.

    Args:
        user_message: The user's current message.
        history: Recent conversation history (formatted string).

    Returns:
        A natural reply in Orca's voice.
    """
    if not DEEPSEEK_API_KEY:
        return "嗯。"

    messages = [
        {"role": "system", "content": ORCA_PERSONA_PROMPT},
    ]

    if history:
        messages.append({"role": "user", "content": f"之前的对话：\n{history}"})
        messages.append({"role": "assistant", "content": "收到，我知道上下文了。"})

    messages.append({"role": "user", "content": user_message})

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 300,
    }

    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(DEEPSEEK_API_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            logger.info("Chat response: %.80s", content)
            return content.strip()
    except Exception as e:
        logger.warning("Chat response failed: %s", e)
        return "嗯。"
