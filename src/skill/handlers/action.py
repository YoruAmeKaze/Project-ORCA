"""Skills: desktop mouse/keyboard actions.

Each skill is a single atomic operation:
  click, double_click, right_click, move_mouse, type_text, scroll
"""

import logging
from dataclasses import dataclass

import pyautogui

logger = logging.getLogger(__name__)

pyautogui.FAILSAFE = True


# ── Coordinate validation (inlined from old src/action/validator.py) ──────────


@dataclass
class _ValidationResult:
    valid: bool
    message: str = ""


def get_screen_size() -> tuple[int, int]:
    """Return (width, height) of the primary monitor."""
    w, h = pyautogui.size()
    return w, h


def validate_coordinates(x: int, y: int) -> _ValidationResult:
    """Check that (x, y) falls within the visible screen area."""
    w, h = get_screen_size()
    if x < 0 or y < 0:
        return _ValidationResult(False, f"坐标 ({x}, {y}) 为负数，无效")
    if x > w or y > h:
        return _ValidationResult(
            False,
            f"坐标 ({x}, {y}) 超出屏幕范围 ({w}x{h})",
        )
    return _ValidationResult(True)


async def handle_click(args: dict, deps) -> str:
    """Click at screen coordinates."""
    x, y = int(args["x"]), int(args["y"])
    _validate_xy(x, y)
    pyautogui.click(x, y)
    return f"已点击 ({x}, {y})"


async def handle_double_click(args: dict, deps) -> str:
    """Double-click at screen coordinates."""
    x, y = int(args["x"]), int(args["y"])
    _validate_xy(x, y)
    pyautogui.doubleClick(x, y)
    return f"已双击 ({x}, {y})"


async def handle_right_click(args: dict, deps) -> str:
    """Right-click at screen coordinates."""
    x, y = int(args["x"]), int(args["y"])
    _validate_xy(x, y)
    pyautogui.rightClick(x, y)
    return f"已右键点击 ({x}, {y})"


async def handle_move_mouse(args: dict, deps) -> str:
    """Move mouse to screen coordinates."""
    x, y = int(args["x"]), int(args["y"])
    _validate_xy(x, y)
    pyautogui.moveTo(x, y)
    return f"已移动鼠标到 ({x}, {y})"


async def handle_type_text(args: dict, deps) -> str:
    """Type text at the current cursor position."""
    text = args["text"]
    pyautogui.write(text, interval=0.05)
    return f"已输入: {text[:40]}{'...' if len(text) > 40 else ''}"


async def handle_scroll(args: dict, deps) -> str:
    """Scroll the mouse wheel."""
    clicks = int(args["clicks"])
    direction = args.get("direction", "down")

    # pyautogui.scroll: positive = up, negative = down
    scroll_amount = abs(clicks)
    if direction == "down":
        scroll_amount = -scroll_amount

    pyautogui.scroll(scroll_amount)
    return f"已滚动 {direction} {clicks} 格"


def _validate_xy(x: int, y: int) -> None:
    """Validate coordinates, raises ValueError if out of screen."""
    cr = validate_coordinates(x, y)
    if not cr.valid:
        raise ValueError(cr.message)
