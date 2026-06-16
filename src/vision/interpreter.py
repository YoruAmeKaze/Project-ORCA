"""Qwen3.7-Plus vision API — analyze screenshots with structured results."""

import base64
import json
import logging
import re

import httpx

from src.config import QWEN_API_KEY, QWEN_API_URL, QWEN_VL_MODEL

logger = logging.getLogger(__name__)


def _encode_image(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


def _needs_coordinates(task: str) -> bool:
    """Detect if the task asks for a location/coordinate."""
    keywords = ["坐标", "位置", "在哪", "哪里", "定位", "找到"]
    return any(k in task for k in keywords)


async def analyze_screenshot(image_bytes: bytes, task: str) -> str:
    """Analyze screenshot with Qwen3.7-Plus.

    For coordinate tasks, Qwen returns structured JSON.
    For describe tasks, Qwen returns natural text.

    Returns:
        Analysis text (may include structured coordinate data).
    """
    if not QWEN_API_KEY:
        return ""

    # Enhance task prompt for coordinate requests
    if _needs_coordinates(task):
        enhanced_task = (
            f"{task}\n\n"
            '请直接返回 JSON 格式，不要包含其他文字：\n'
            '{"x": 数字, "y": 数字, "description": "简要描述"}\n'
            "坐标基于整个屏幕的绝对像素坐标。"
        )
    else:
        enhanced_task = task

    b64 = _encode_image(image_bytes)
    payload = {
        "model": QWEN_VL_MODEL,
        "messages": [
            {"role": "system", "content": enhanced_task},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": enhanced_task},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            },
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }
    headers = {"Authorization": f"Bearer {QWEN_API_KEY}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(QWEN_API_URL, json=payload, headers=headers)
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()

            # Try to extract structured coordinates
            if _needs_coordinates(task):
                coord = _parse_coordinates(raw)
                if coord:
                    result = f"目标位置坐标为 ({coord['x']}, {coord['y']})，{coord.get('description', '')}"
                    logger.info("Qwen coord: %s", result)
                    return result

            logger.info("Qwen: %.100s", raw)
            return raw

    except httpx.TimeoutException:
        logger.warning("Qwen timed out")
        return "视觉分析超时"
    except httpx.HTTPError as e:
        logger.warning("Qwen HTTP error: %s", e)
        return ""
    except Exception as e:
        logger.warning("Qwen failed: %s", type(e).__name__)
        return ""


def _parse_coordinates(text: str) -> dict | None:
    """Try to parse {"x": N, "y": N} from text."""
    # Try direct JSON parse
    text = text.strip()
    if text.startswith("{"):
        try:
            data = json.loads(text)
            if "x" in data and "y" in data:
                return {"x": int(data["x"]), "y": int(data["y"]), "description": data.get("description", "")}
        except (json.JSONDecodeError, ValueError):
            pass

    # Try regex for coordinates in text
    m = re.search(r'x["\']?\s*[:=]\s*(\d+)', text)
    n = re.search(r'y["\']?\s*[:=]\s*(\d+)', text)
    if m and n:
        return {"x": int(m.group(1)), "y": int(n.group(1)), "description": text[:100]}

    return None
