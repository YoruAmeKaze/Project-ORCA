"""Built-in skills — factory that populates the SkillRegistry with all handlers.

Import this to get a fully populated registry for the Runtime.
"""

from src.skill.handlers import (
    action,
    analyze,
    reply,
    screenshot,
    search,
)
from src.skill.registry import SkillMetadata, SkillRegistry


def create_registry() -> SkillRegistry:
    """Create and populate the SkillRegistry with all Phase 1 built-in skills."""
    registry = SkillRegistry()

    registry.register_many(
        # ── reply (must be first) ──────────────────────────────────────
        SkillMetadata(
            name="reply",
            description="回复用户消息。plan 的最后一步必须使用此 skill。",
            params={
                "message": {
                    "type": "string",
                    "required": True,
                    "description": "回复内容",
                },
            },
            output="null",
            progress_message=None,
            handler=reply.handle,
        ),

        # ── capture_screenshot ─────────────────────────────────────────
        SkillMetadata(
            name="capture_screenshot",
            description="截取当前桌面屏幕，返回图片文件路径。",
            params={},
            output="string（图片文件路径）",
            progress_message="正在截图…",
            handler=screenshot.handle,
        ),

        # ── analyze_image ──────────────────────────────────────────────
        SkillMetadata(
            name="analyze_image",
            description="用视觉模型分析指定图片的内容，可用于查找 UI 元素坐标或描述桌面状态。",
            params={
                "task": {
                    "type": "string",
                    "required": True,
                    "description": "分析任务描述",
                },
                "image_path": {
                    "type": "string",
                    "required": True,
                    "description": "图片文件路径",
                },
            },
            output="string（文字分析结果）",
            progress_message="正在分析图片…",
            handler=analyze.handle,
        ),

        # ── click ──────────────────────────────────────────────────────
        SkillMetadata(
            name="click",
            description="在屏幕指定坐标处点击鼠标左键。",
            params={
                "x": {"type": "int", "required": True, "description": "x 坐标"},
                "y": {"type": "int", "required": True, "description": "y 坐标"},
            },
            progress_message=None,
            handler=action.handle_click,
        ),

        # ── double_click ───────────────────────────────────────────────
        SkillMetadata(
            name="double_click",
            description="在屏幕指定坐标处双击鼠标左键。",
            params={
                "x": {"type": "int", "required": True, "description": "x 坐标"},
                "y": {"type": "int", "required": True, "description": "y 坐标"},
            },
            progress_message=None,
            handler=action.handle_double_click,
        ),

        # ── right_click ────────────────────────────────────────────────
        SkillMetadata(
            name="right_click",
            description="在屏幕指定坐标处点击鼠标右键。",
            params={
                "x": {"type": "int", "required": True, "description": "x 坐标"},
                "y": {"type": "int", "required": True, "description": "y 坐标"},
            },
            progress_message=None,
            handler=action.handle_right_click,
        ),

        # ── move_mouse ─────────────────────────────────────────────────
        SkillMetadata(
            name="move_mouse",
            description="将鼠标移动到屏幕指定坐标。",
            params={
                "x": {"type": "int", "required": True, "description": "x 坐标"},
                "y": {"type": "int", "required": True, "description": "y 坐标"},
            },
            progress_message=None,
            handler=action.handle_move_mouse,
        ),

        # ── type_text ──────────────────────────────────────────────────
        SkillMetadata(
            name="type_text",
            description="在当前光标位置输入文字。",
            params={
                "text": {
                    "type": "string",
                    "required": True,
                    "description": "要输入的文字",
                },
            },
            progress_message="正在输入…",
            handler=action.handle_type_text,
        ),

        # ── scroll ─────────────────────────────────────────────────────
        SkillMetadata(
            name="scroll",
            description="滚动鼠标滚轮。",
            params={
                "clicks": {
                    "type": "int",
                    "required": True,
                    "description": "滚动格数",
                },
                "direction": {
                    "type": "string",
                    "required": False,
                    "enum": ["up", "down"],
                    "description": "滚动方向，默认 down",
                },
            },
            progress_message=None,
            handler=action.handle_scroll,
        ),

        # ── search_web ─────────────────────────────────────────────────
        SkillMetadata(
            name="search_web",
            description="搜索网络获取实时信息，适用于查询当前新闻、天气、价格等。",
            params={
                "query": {
                    "type": "string",
                    "required": True,
                    "description": "搜索关键词",
                },
            },
            output="string（搜索结果摘要）",
            progress_message="正在搜索…",
            handler=search.handle,
        ),
    )

    return registry
