"""Skill: refine — polish raw analysis results into natural Orca voice."""

import logging

import httpx

from src.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL
from src.core.persona import ORCA_PERSONA_PROMPT

logger = logging.getLogger(__name__)

REFINE_INSTRUCTION = (
    "\n\n---\n"
    "请用上面的人设将以下原始内容改写成 Orca 会说的话——"
    "简短、自然，保留关键信息，去掉多余的技术细节让普通用户能看懂。\n"
    "直接输出改写后的结果，不要加任何前缀或解释。\n\n"
)


async def handle(args: dict, deps) -> str:
    """Polish raw output into natural language.

    Args:
        raw_output: The raw text to polish (e.g. from analyze_image).

    Output: polished text in Orca's voice (string).
    """
    raw = args.get("raw_output", "")
    if not raw:
        return ""

    messages = [
        {"role": "system", "content": f"{ORCA_PERSONA_PROMPT}\n{REFINE_INSTRUCTION}"},
        {"role": "user", "content": raw},
    ]

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": 0.5,
        "max_tokens": 500,
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
            content = data["choices"][0]["message"]["content"].strip()
            logger.info("Refine result: %.80s", content)
            return content
    except Exception as e:
        logger.warning("Refine failed: %s", e)
        return raw  # fallback to raw
