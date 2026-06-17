"""Skill: capture_screenshot — capture the primary monitor."""

from src.vision.screenshot import capture_screenshot


async def handle(args: dict, deps) -> str:
    """Capture screenshot.

    Output: path to the saved image file (string).
    """
    _image_bytes, path = capture_screenshot()
    return path
