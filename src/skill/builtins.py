"""Built-in skills — factory that populates the SkillRegistry with all handlers.

Import this to get a fully populated registry for the Runtime.
"""

from src.skill.handlers import (
    action,
    analyze,
    luckin,
    refine,
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
            description=(
                "分析、查看、识别图片内容。可用于看图、看桌面、看屏幕、识别界面元素。\n"
                "用视觉模型分析指定图片的内容。\n"
                "image_path 的来源分三种情况：\n"
                "1. 用户意图涉及桌面/屏幕时——先调用 capture_screenshot 获取路径，再传给此 skill\n"
                "2. 用户发来图片时——直接用用户提供的图片路径\n"
                "3. 不确定图片来源时——用 reply skill 告知用户需要提供图片"
            ),
            params={
                "task": {
                    "type": "string",
                    "required": True,
                    "description": "分析任务描述",
                },
                "image_path": {
                    "type": "string",
                    "required": True,
                    "description": "图片文件路径，来源见 skill 描述",
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

        # ── refine ─────────────────────────────────────────────────────
        SkillMetadata(
            name="refine",
            description="将上一步的原始输出润色成 Orca 人设的自然语言。用于把视觉分析等原始结果转成适合回复用户的文本。",
            params={
                "raw_output": {
                    "type": "string",
                    "required": True,
                    "description": "需要润色的原始文本",
                },
            },
            output="string（润色后的文本）",
            progress_message=None,
            handler=refine.handle,
        ),

        # ── luckin_find_store ──────────────────────────────────────────
        SkillMetadata(
            name="luckin_find_store",
            keywords=["瑞幸", "咖啡", "门店", "查门店", "附近", "地址", "点单", "点咖啡", "想喝", "来一杯"],
            description=(
                "查找附近的瑞幸咖啡门店。"
                "传地点名（如\"重庆\"、\"解放碑\"）可指定位置。"
                "不传参数则自动通过 IP 定位你附近的门店。"
                "返回门店列表和门店ID供后续搜索菜单和下单使用。"
            ),
            params={
                "query": {
                    "type": "string",
                    "required": False,
                    "description": "城市名、区域名或门店名称。不传则自动搜索附近门店。如\"重庆\"、\"上海\"、\"王府井喜悦店\"",
                },
            },
            output="string（门店列表）",
            progress_message="正在查找门店…",
            handler=luckin.handle_find_store,
        ),

        # ── luckin_search_menu ─────────────────────────────────────────
        SkillMetadata(
            name="luckin_search_menu",
            keywords=["菜单", "饮品", "咖啡", "生椰拿铁", "拿铁", "美式", "点单", "搜", "喝"],
            description=(
                "搜索瑞幸咖啡门店的菜单，按饮品名称查找商品。"
                "需要先有门店ID（通过 luckin_find_store 获取）。"
                "注意：搜索结果中的 SKU 是产品级 SKU，不要直接用于下单。"
                "必须先调 luckin_get_product_detail 获取 variant 级 SKU。"
            ),
            params={
                "dept_id": {
                    "type": "int",
                    "required": True,
                    "description": "门店ID（数字），从 luckin_find_store 结果中提取",
                },
                "query": {
                    "type": "string",
                    "required": True,
                    "description": "饮品名称关键词",
                },
            },
            output="string（商品列表）",
            progress_message="正在搜索饮品…",
            handler=luckin.handle_search_menu,
        ),

        # ── luckin_preview_order ──────────────────────────────────────
        SkillMetadata(
            name="luckin_preview_order",
            keywords=["预览", "看看订单", "多少钱"],
            description=(
                "预览瑞幸咖啡订单，显示商品明细和价格。"
                "下单前调用，需要门店ID和商品信息。"
                "注意：sku_code 必须使用 luckin_get_product_detail 返回的 variant 级 SKU，"
                "不可用 luckin_search_menu 返回的产品级 SKU。"
            ),
            params={
                "dept_id": {"type": "int", "required": True, "description": "门店ID"},
                "product_id": {"type": "int", "required": True, "description": "商品ID"},
                "sku_code": {"type": "string", "required": True, "description": "variant 级 SKU（从 luckin_get_product_detail 获取）"},
                "amount": {"type": "int", "required": False, "description": "数量，默认1"},
            },
            output="string（订单预览）",
            progress_message="正在预览订单…",
            handler=luckin.handle_preview_order,
        ),

        # ── luckin_create_order ────────────────────────────────────────
        SkillMetadata(
            name="luckin_create_order",
            keywords=["下单", "点单", "买", "点咖啡", "来一杯", "要一杯"],
            description=(
                "创建瑞幸咖啡订单并完成支付。"
                "需要先通过 luckin_find_store 获取门店ID，"
                "通过 luckin_search_menu + luckin_get_product_detail 获取 variant SKU。"
                "下单前建议先调用 luckin_preview_order 预览。"
            ),
            params={
                "dept_id": {"type": "int", "required": True, "description": "门店ID"},
                "product_id": {"type": "int", "required": True, "description": "商品ID"},
                "sku_code": {"type": "string", "required": True, "description": "variant 级 SKU（从 luckin_get_product_detail 获取）"},
                "amount": {"type": "int", "required": False, "description": "数量，默认1"},
            },
            output="string（下单结果）",
            progress_message="正在下单…",
            handler=luckin.handle_create_order,
        ),

        # ── luckin_get_product_detail ──────────────────────────────────
        SkillMetadata(
            name="luckin_get_product_detail",
            keywords=["详情", "规格", "选项", "冰", "热", "糖度", "杯型", "看", "看看"],
            description=(
                "查看瑞幸咖啡饮品的详细信息和规格选项（冰/热、糖度、杯型）。"
                "返回 variant 级 SKU 编码，预览和下单必须使用此 SKU，不可用产品级 SKU。"
                "需要先有门店ID和商品ID（通过 luckin_search_menu 获取商品ID）。"
            ),
            params={
                "dept_id": {"type": "int", "required": True, "description": "门店ID"},
                "product_id": {"type": "int", "required": True, "description": "商品ID，从 luckin_search_menu 结果中提取"},
            },
            output="string（商品详情 + 规格选项 + variant SKU）",
            progress_message="正在查询商品详情…",
            handler=luckin.handle_get_product_detail,
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
