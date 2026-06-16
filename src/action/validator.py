"""Action validation — sanity-check coordinates and parameters before execution.

Many failure cases come from LLM hallucinating coordinates outside the visible
screen area, or proposing actions that don't match the params. This module
catches those before pyautogui acts on them.
"""

import logging
from dataclasses import dataclass

import pyautogui

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    valid: bool
    message: str = ""


def get_screen_size() -> tuple[int, int]:
    """Return (width, height) of the primary monitor."""
    w, h = pyautogui.size()
    return w, h


def validate_coordinates(x: int, y: int) -> ValidationResult:
    """Check that (x, y) falls within the visible screen area."""
    w, h = get_screen_size()
    if x < 0 or y < 0:
        return ValidationResult(False, f"坐标 ({x}, {y}) 为负数，无效")
    if x > w or y > h:
        return ValidationResult(
            False,
            f"坐标 ({x}, {y}) 超出屏幕范围 ({w}x{h})",
        )
    return ValidationResult(True)


def validate_action(action: str, params: dict) -> ValidationResult:
    """Validate an action type along with its required params."""
    required_for = {
        "click": ["x", "y"],
        "double_click": ["x", "y"],
        "right_click": ["x", "y"],
        "move": ["x", "y"],
        "type": ["text"],
        "scroll": [],      # dx/dy or clicks — optional
        "screenshot": [],
        "none": [],
    }

    if action not in required_for:
        return ValidationResult(False, f"未知操作类型: {action}")

    # Check required params
    for key in required_for[action]:
        if key not in params:
            return ValidationResult(False, f"操作 {action} 缺少必要参数: {key}")

    # Validate coordinates if present
    for coord_key in ("x", "y"):
        if coord_key in params:
            val = params[coord_key]
            if not isinstance(val, (int, float)):
                return ValidationResult(False, f"{coord_key} 不是有效的数字: {val}")

    return ValidationResult(True)
