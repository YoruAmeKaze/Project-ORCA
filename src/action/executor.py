"""Action executor — translates parsed commands into pyautogui operations."""

import logging
import time

import pyautogui

from src.action.validator import validate_action, validate_coordinates

logger = logging.getLogger(__name__)

# Safety: pyautogui will throw on out-of-screen coordinates
pyautogui.FAILSAFE = True


async def execute(action: str, params: dict) -> str:
    """Execute a desktop action and return a human-readable result message.

    Args:
        action: One of click / double_click / right_click / type / scroll / move / screenshot / none
        params: Action-specific parameters (x, y, text, etc.)

    Returns:
        A Chinese result message to be sent back to the user.
    """
    # Validate
    vr = validate_action(action, params)
    if not vr.valid:
        logger.warning("Action validation failed: %s", vr.message)
        return f"操作校验失败: {vr.message}"

    logger.info("Executing: %s %s", action, params)

    try:
        # Coordinate validation
        x = params.get("x")
        y = params.get("y")
        if x is not None and y is not None:
            cr = validate_coordinates(int(x), int(y))
            if not cr.valid:
                logger.warning("Coordinate validation failed: %s", cr.message)
                return f"坐标校验失败: {cr.message}"

        # Dispatch
        if action in ("click", "double_click", "right_click", "move"):
            x, y = int(x), int(y)

            if action == "click":
                pyautogui.click(x, y)
            elif action == "double_click":
                pyautogui.doubleClick(x, y)
            elif action == "right_click":
                pyautogui.rightClick(x, y)
            elif action == "move":
                pyautogui.moveTo(x, y)

            return f"已执行 {action} 在坐标 ({x}, {y})"

        elif action == "type":
            text = params.get("text", "")
            pyautogui.write(text, interval=0.05)
            return f"已输入: {text[:40]}{'...' if len(text) > 40 else ''}"

        elif action == "scroll":
            clicks = params.get("clicks", params.get("dy", 1))
            pyautogui.scroll(int(clicks))
            direction = "向下" if clicks < 0 else "向上"
            return f"已滚动 {direction} {abs(clicks)} 格"

        elif action == "screenshot":
            return "截图已获取，请稍等"

        elif action == "none":
            return "不需要执行桌面操作"

        else:
            return f"未知操作: {action}"

    except pyautogui.FailSafeException:
        logger.error("FailSafe triggered — mouse at corner")
        return "安全机制触发：鼠标移动到屏幕角落，操作已取消"
    except Exception as e:
        logger.error("Action execution failed: %s", e)
        return f"操作执行失败: {e}"
