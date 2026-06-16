"""Desktop screenshot utility with error handling."""

import logging
import tempfile
from pathlib import Path

import pyautogui

logger = logging.getLogger(__name__)


def capture_screenshot(save_to: str | Path | None = None) -> tuple[bytes, str]:
    """Capture the primary monitor screenshot.

    Args:
        save_to: Optional file path to save the screenshot. Auto-generates if None.

    Returns:
        (image_bytes, file_path_or_label)

    Raises:
        RuntimeError: If screenshot fails.
    """
    try:
        img = pyautogui.screenshot()
    except Exception as e:
        raise RuntimeError(f"Screenshot failed: {e}") from e

    if save_to:
        path = Path(save_to)
        path.parent.mkdir(parents=True, exist_ok=True)
    else:
        path = Path(tempfile.mktemp(suffix=".png"))

    try:
        img.save(path, format="PNG")
    except Exception as e:
        raise RuntimeError(f"Failed to save screenshot to {path}: {e}") from e

    # Read back as bytes for API transmission
    with open(path, "rb") as f:
        data = f.read()

    logger.info("Screenshot captured: %s (%d bytes)", path, len(data))
    return data, str(path)
