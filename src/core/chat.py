"""Chat response generator — natural conversation with Orca persona."""

import logging

import httpx

from src.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL
from src.core.persona import ORCA_PERSONA_PROMPT
from src.core.search import search

logger = logging.getLogger(__name__)


async def chat_response(user_message: str, history: str) -> str:
    """Generate a natural chat response using DeepSeek Flash.

    Args:
        user_message: The user's current message.
        history: Recent conversation history string.

    Returns:
        A natural reply in Orca's voice.
    """
    if not DEEPSEEK_API_KEY:
        return "嗯。"

    search_results = await search(user_message)

    messages = [
        {"role": "system", "content": ORCA_PERSONA_PROMPT},
    ]

    if search_results:
        messages.append({
            "role": "system",
            "content": f"以下是从网络搜索到的相关信息，如有用请引用：\n{search_results}",
        })

    if history:
        messages.append({"role": "user", "content": f"之前的对话：\n{history}"})
        messages.append({"role": "assistant", "content": "明白了。"})

    messages.append({"role": "user", "content": user_message})

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 500,
    }

    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(DEEPSEEK_API_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            logger.info("Chat response: %.80s", content)
            return content.strip()
    except Exception as e:
        logger.warning("Chat response failed: %s", e)
        return "嗯。"
