"""Vision-language model integration.

Calls Ollama VL model for visual understanding of the desktop screenshot.
Falls back to DeepSeek API (text-only) if Ollama is unavailable or the
VL model is not loaded.

Expected output format from the LLM:

    {
      "action": "click" | "double_click" | "right_click" | "type" | "scroll"
                | "screenshot" | "move" | "none",
      "params": {
        "x": 100,
        "y": 200,
        "text": "hello",         // for type action
        "clicks": 3,             // for scroll action
        "dx": 0, "dy": -1        // for scroll direction
      },
      "reason": "用户想点击浏览器地址栏"
    }

If the user's intent is not a desktop action (e.g. a question), action= "none".
"""

import base64
import json
import logging
from typing import Any

import httpx

from src.config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_API_URL,
    DEEPSEEK_MODEL,
    OLLAMA_HOST,
    OLLAMA_VL_MODEL,
)
from src.core.persona import ORCA_PERSONA_PROMPT

logger = logging.getLogger(__name__)

# --- Constants ---

ACTION_SYSTEM_INSTRUCTION = (
    "你是一个桌面操作助手。你需要根据用户指令和当前屏幕截图，"
    "判断用户想做什么操作。"
    "\n\n"
    "请返回 JSON 格式（不要包含其他文字）：\n"
    '{"action": "<action_type>", "params": {...}, "reason": "<为什么这样判断>"}\n\n'
    "action_type 可选值：\n"
    "- click: 鼠标点击，params 需要 x, y 坐标\n"
    "- double_click: 双击，params 需要 x, y 坐标\n"
    "- right_click: 右键，params 需要 x, y 坐标\n"
    "- type: 键盘输入，params 需要 text 内容\n"
    "- scroll: 滚动，params 需要 dx, dy（方向）或 clicks（格数）\n"
    "- move: 移动鼠标，params 需要 x, y 坐标\n"
    "- screenshot: 用户只想看截图，不需要执行操作\n"
    "- none: 用户不是在操作桌面（如闲聊/问题），不需要操作\n\n"
    "如果是点击操作，请根据截图中的 UI 布局估算坐标位置。坐标采用整个屏幕的绝对坐标。"
)

FALLBACK_SYSTEM_PROMPT = (
    "你是 Project Orca，一个桌面操作助手。"
    "用户发送了一条指令，但由于视觉模型不可用，你只能根据文字猜测意图。\n"
    f"{ACTION_SYSTEM_INSTRUCTION}"
)


def _encode_image(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


# --- Ollama VL ---


async def _ollama_vl_infer(
    user_message: str,
    image_bytes: bytes,
) -> dict[str, Any] | None:
    """Call Ollama vision model with screenshot + user message."""
    b64 = _encode_image(image_bytes)

    payload = {
        "model": OLLAMA_VL_MODEL,
        "messages": [
            {
                "role": "system",
                "content": f"{ORCA_PERSONA_PROMPT}\n\n{ACTION_SYSTEM_INSTRUCTION}",
            },
            {
                "role": "user",
                "content": user_message,
                "images": [b64],
            },
        ],
        "stream": False,
        "options": {"temperature": 0.1},
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        logger.warning("Ollama VL timed out (15s) — model unloaded or slow CPU")
        return None
    except httpx.HTTPError as e:
        logger.warning("Ollama VL call failed: %s", e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("Ollama returned invalid JSON: %s", e)
        return None

    content = data.get("message", {}).get("content", "")
    return _parse_action(content)


# --- DeepSeek API fallback (text-only) ---


async def _deepseek_fallback(user_message: str) -> dict[str, Any] | None:
    """Fallback to DeepSeek API when Ollama VL is unavailable.

    Text-only — no screenshot context.
    """
    if not DEEPSEEK_API_KEY:
        logger.warning("DeepSeek API key not configured, skipping fallback")
        return None

    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": FALLBACK_SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }

    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                DEEPSEEK_API_URL,
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.warning("DeepSeek API call failed: %s", e)
        return None
    except json.JSONDecodeError as e:
        logger.warning("DeepSeek returned invalid JSON: %s", e)
        return None

    content = data["choices"][0]["message"]["content"]
    return _parse_action(content)


# --- Parsing ---


def _parse_action(raw: str) -> dict[str, Any] | None:
    """Extract JSON action from LLM response.

    Handles cases where the model wraps JSON in markdown code fences
    or includes extra text.
    """
    # Strip markdown code fences
    text = raw.strip()
    if text.startswith("```"):
        # Find first and last ```
        lines = text.splitlines()
        # Remove opening ```
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        # Remove closing ```
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    # Try to find and parse a JSON object
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "action" in parsed:
            return parsed
    except json.JSONDecodeError:
        pass

    # Try to find {...} somewhere in the text
    brace_start = text.find("{")
    brace_end = text.rfind("}")
    if brace_start != -1 and brace_end > brace_start:
        try:
            parsed = json.loads(text[brace_start : brace_end + 1])
            if isinstance(parsed, dict) and "action" in parsed:
                return parsed
        except json.JSONDecodeError:
            pass

    logger.warning("Failed to parse action from LLM response: %.120s", raw)
    return None


# --- Public API ---


async def interpret(
    user_message: str,
    image_bytes: bytes,
) -> dict[str, Any]:
    """Interpret user intent from screenshot + message.

    Pipeline:
    1. Try Ollama VL model
    2. If that fails, try DeepSeek API (text-only, no image)
    3. If both fail, return a safe no-op

    Returns a dict with at least "action" key.
    """
    logger.info("Interpreting: user_message=%.60s", user_message)

    # Try Ollama VL first
    result = await _ollama_vl_infer(user_message, image_bytes)
    if result is not None:
        logger.info("Ollama VL succeeded: action=%s reason=%.60s", result.get("action"), result.get("reason", ""))
        return result

    # Fallback to DeepSeek
    logger.info("Ollama VL failed, trying DeepSeek fallback")
    result = await _deepseek_fallback(user_message)
    if result is not None:
        logger.info("DeepSeek fallback succeeded: action=%s", result.get("action"))
        return result

    # Both failed — safe no-op
    logger.warning("Both Ollama VL and DeepSeek fallback failed")
    return {
        "action": "none",
        "params": {},
        "reason": "视觉模型和 API 兜底均不可用",
    }
