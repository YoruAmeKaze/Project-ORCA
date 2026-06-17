"""Skill: analyze_image — analyze a screenshot with vision model."""

from src.vision.interpreter import analyze_screenshot


async def handle(args: dict, deps) -> str:
    """Analyze an image file.

    Args:
        task: Description of what to look for.
        image_path: Path to the image file on disk.

    Output: text analysis result (string).
    """
    task = args["task"]
    image_path = args["image_path"]

    # Read the image file bytes
    with open(image_path, "rb") as f:
        image_bytes = f.read()

    result = await analyze_screenshot(image_bytes, task)
    return result or "无法分析该图片"
