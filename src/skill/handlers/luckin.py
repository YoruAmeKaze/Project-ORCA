"""Skills: Luckin Coffee ordering via MCP."""

import json
import logging

import httpx

from src.config import LUCKIN_LAT, LUCKIN_LNG
from src.tasks.luckin_mcp import LuckinMCPClient

logger = logging.getLogger(__name__)


# ── Geolocation helpers ──────────────────────────────────────────────────


# Fallback city→coords table (used when Nominatim is unreachable, e.g. from China)
_CITY_COORDS: dict[str, tuple[float, float]] = {
    "北京": (39.9042, 116.4074), "上海": (31.2304, 121.4737),
    "广州": (23.1291, 113.2644), "深圳": (22.5431, 114.0579),
    "重庆": (29.4316, 106.5553), "成都": (30.5728, 104.0668),
    "杭州": (30.2741, 120.1551), "武汉": (30.5928, 114.3055),
    "西安": (34.3416, 108.9398), "南京": (32.0603, 118.7969),
    "长沙": (28.2282, 112.9388), "苏州": (31.2990, 120.5853),
    "天津": (39.3434, 117.3616), "郑州": (34.7466, 113.6253),
    "东莞": (23.0208, 113.7518), "青岛": (36.0671, 120.3826),
    "沈阳": (41.8057, 123.4315), "宁波": (29.8683, 121.5440),
    "昆明": (25.0389, 102.7183), "合肥": (31.8206, 117.2272),
    "福州": (26.0745, 119.2965), "厦门": (24.4798, 118.0894),
    "济南": (36.6512, 116.9970), "大连": (38.9140, 121.6147),
    "哈尔滨": (45.8038, 126.5350), "贵阳": (26.6470, 106.6302),
    "南宁": (22.8170, 108.3665), "南昌": (28.6820, 115.8582),
    "太原": (37.8706, 112.5483), "长春": (43.8171, 125.3235),
    "石家庄": (38.0428, 114.5149), "兰州": (36.0611, 103.8343),
    "海口": (20.0440, 110.1999),
}

# Chinese location suffix indicators — if query contains any of these, it's likely a place name
_LOCATION_SUFFIXES = ["市", "区", "县", "镇", "乡", "路", "街", "道", "大学", "学院",
                       "大厦", "广场", "公园", "酒店", "小区", "花园", "中心", "馆",
                       "桥", "站", "机场", "港", "山", "江", "湖", "海"]


async def _geocode(query: str) -> tuple[float, float] | None:
    """Convert a place name to (lat, lng) via hardcoded city table.

    If the query doesn't look like a Chinese location, returns None immediately.
    """
    if not query or not query.strip():
        return None
    q = query.strip()

    # Quick check: does this look like a Chinese location?
    has_suffix = any(s in q for s in _LOCATION_SUFFIXES)
    is_known_city = q in _CITY_COORDS or any(city in q for city in _CITY_COORDS)
    if not has_suffix and not is_known_city:
        return None

    # Look up in hardcoded city table
    for city_name, (clat, clng) in _CITY_COORDS.items():
        if city_name in q:
            logger.info("Geocode: %s -> (%s, %s)", city_name, clat, clng)
            return (clat, clng)

    return None


async def _amap_ip_geolocate() -> tuple[float, float, str] | None:
    """Auto-detect location via 高德 IP定位 API.

    Returns (lat, lng, city_name) or None.
    Requires AMAP_API_KEY in .env.
    """
    from src.config import AMAP_API_KEY
    if not AMAP_API_KEY:
        logger.warning("AMAP_API_KEY not configured")
        return None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                "https://restapi.amap.com/v3/ip",
                params={"key": AMAP_API_KEY},
            )
            data = resp.json()
            if data.get("status") == "1":
                city = data.get("city", data.get("province", ""))
                # rectangle format: "minLng,minLat;maxLng,maxLat"
                rect = data.get("rectangle", "")
                if rect and ";" in rect:
                    parts = rect.split(";")
                    min_lng, min_lat = parts[0].split(",")
                    max_lng, max_lat = parts[1].split(",")
                    lat = (float(min_lat) + float(max_lat)) / 2
                    lng = (float(min_lng) + float(max_lng)) / 2
                    logger.info("AMap locate: %s -> (%s, %s)", city, lat, lng)
                    return (lat, lng, city)
            logger.warning("AMap locate failed: %s", data.get("info", ""))
    except Exception as e:
        logger.warning("AMap locate error: %s", e)
    return None

async def handle_find_store(args: dict, deps) -> str:
    """查找附近的瑞幸咖啡门店.

    自动定位逻辑：
    1. query 有地点名 → 城市表查坐标
    2. query 为空 → 高德 IP 定位

    Args:
        query: 城市名、区域名或门店名称（可选，不传则自动定位）
    """
    client = deps.luckin_mcp
    dept_name = args.get("query")
    lat = lng = None

    # Strategy 1: query provided → geocode the place name
    if dept_name:
        coords = await _geocode(dept_name)
        if coords:
            lat, lng = coords
            logger.info("Geocoded \"%s\" -> (%s, %s)", dept_name, lat, lng)

    # Strategy 2: no query → try LUCKIN_LAT/LNG from .env first
    if lat is None or lng is None:
        if LUCKIN_LAT is not None and LUCKIN_LNG is not None:
            lat, lng = LUCKIN_LAT, LUCKIN_LNG
            logger.info("Using .env location: (%s, %s)", lat, lng)

    # Strategy 3: fall back to IP geolocation
    if lat is None or lng is None:
        ip_result = await _amap_ip_geolocate()
        if ip_result:
            lat, lng, city = ip_result
            logger.info("Auto-located: %s (%s, %s)", city, lat, lng)

    # Fallback: both failed
    if lat is None or lng is None:
        return "无法确定位置。请告诉我城市名，如「重庆」或「上海」。"

    stores = await client.query_shop_list(lat, lng, dept_name)
    if not stores:
        # Clear stale store state
        deps.session_state.pop("selected_dept_id", None)
        deps.session_state.pop("store_list", None)
        return "附近没有找到瑞幸门店"

    # ── Persist store data to session_state for multi-turn flow ──────────
    deps.session_state["store_list"] = [
        {
            "deptId": s.get("deptId", ""),
            "deptName": s.get("deptName", "未知"),
            "address": s.get("address", ""),
            "distance": s.get("distance", ""),
        }
        for s in stores[:10]
    ]

    # Single store → show full detail and auto-select
    if len(stores) == 1 or args.get("query"):
        s = stores[0]
        name = s.get("deptName", "未知")
        addr = s.get("address", "地址未知")
        work_time = f"{s.get('workTimeStart', '?')}-{s.get('workTimeEnd', '?')}"
        status = s.get("workStatus", "")
        dist = s.get("distance", "")
        dept_id = s.get("deptId", "")

        # Auto-select when query narrows to one store
        if dept_id:
            deps.session_state["selected_dept_id"] = int(dept_id) if isinstance(dept_id, (int, str)) else dept_id
            deps.session_state["selected_dept_name"] = name
            logger.info("session_state: selected store %s (dept_id=%s)", name, dept_id)

        lines = [f"📍 {name}  [dept_id: {dept_id}]"]
        lines.append(f"   地址：{addr}")
        if dist:
            lines.append(f"   距离：{dist}km")
        lines.append(f"   营业：{work_time}")
        if status:
            lines.append(f"   状态：{status}")
        return "\n".join(lines)

    # Multiple stores → list with dept_id for next-turn extraction
    # Clear any previous single-store selection
    deps.session_state.pop("selected_dept_id", None)
    deps.session_state.pop("selected_dept_name", None)

    lines = [f"找到 {len(stores)} 家门店："]
    for i, s in enumerate(stores[:5]):
        name = s.get("deptName", "未知")
        dept_id = s.get("deptId", "")
        addr = s.get("address", "")
        dist = s.get("distance", "")
        status = s.get("workStatus", "")
        dist_str = f"({dist}km)" if dist else ""
        lines.append(f"  {i + 1}. {name}  [dept_id: {dept_id}]")
        lines.append(f"    {addr}  {dist_str} {status}")
    return "\n".join(lines)


async def handle_search_menu(args: dict, deps) -> str:
    """搜索瑞幸咖啡菜单中的饮品.

    Args:
        dept_id: 门店ID
        query: 饮品名称关键词
    """
    client = deps.luckin_mcp
    dept_id = int(args["dept_id"])
    query = args.get("query", "")

    # Confirm store selection in session_state
    deps.session_state["selected_dept_id"] = dept_id
    if not deps.session_state.get("selected_dept_name"):
        deps.session_state["selected_dept_name"] = f"门店#{dept_id}"
    logger.info("session_state: confirmed store dept_id=%s via search_menu", dept_id)

    # Empty query → search broadly for popular items
    search_query = query if query else "咖啡"
    products = await client.search_product(dept_id, search_query)
    if not products and query:
        return f"未找到与「{query}」相关的商品"
    if not products:
        return "该门店暂无可用商品"

    # Save structured menu items to session_state for LLM reference
    menu_items = [
        {
            "productId": p.get("productId", p.get("id", "")),
            "productName": p.get("productName", p.get("name", "未知")),
            "skuCode": p.get("skuCode", ""),
            "price": p.get("salePrice", p.get("price", "")),
        }
        for p in products[:10]
    ]
    deps.session_state["menu_items"] = menu_items
    logger.info("session_state: saved %d menu_items", len(menu_items))

    title = f"菜单（{query}）：" if query else "菜单："
    lines = [title]
    shown = 0
    max_show = 12
    for p in products[:max_show]:
        name = p.get("productName", p.get("name", "未知"))
        pid = p.get("productId", p.get("id", ""))
        price = p.get("salePrice", p.get("price", ""))
        sku = p.get("skuCode", "")
        lines.append(f"  · {name}  ¥{price}  [ID:{pid} SKU:{sku}]")
        shown += 1
    if len(products) > max_show:
        lines.append(f"  …还有 {len(products) - max_show} 款，仅显示前{max_show}条")
    return "\n".join(lines)


async def handle_preview_order(args: dict, deps) -> str:
    """预览瑞幸咖啡订单.

    Args:
        dept_id: 门店ID
        product_id: 商品ID
        sku_code: SKU编码
        amount: 数量（默认1）
    """
    # 下单前必须展示过商品规格或用户给出了具体规格
    if not deps.session_state.get("specs_shown"):
        return "请先查看商品规格（luckin_get_product_detail）或说明你要的温度、糖度和杯型再下单。"

    client = deps.luckin_mcp
    items = [{
        "productId": int(args["product_id"]),
        "skuCode": args["sku_code"],
        "amount": int(args.get("amount", 1)),
    }]
    result = await client.preview_order(int(args["dept_id"]), items)
    return _format_preview(result)


def _format_preview(data: dict) -> str:
    """Format order preview dict into readable Chinese text."""
    if not data:
        return "订单预览暂无数据"

    lines = [" 订单预览："]

    # Extract product list — try multiple possible keys
    product_list = (
        data.get("productList")
        or data.get("products")
        or data.get("list")
        or data.get("items")
        or []
    )
    if isinstance(product_list, list) and product_list:
        for p in product_list:
            name = (
                p.get("productName")
                or p.get("name")
                or p.get("itemName")
                or "未知商品"
            )
            qty = p.get("quantity") or p.get("amount") or p.get("qty") or 1
            price = (
                p.get("salePrice")
                or p.get("price")
                or p.get("unitPrice")
                or p.get("totalPrice")
                or ""
            )
            sku = p.get("skuCode") or p.get("sku") or ""
            price_str = f"  ¥{price}" if price else ""
            sku_str = f"  [{sku}]" if sku else ""
            lines.append(f"  · {name} ×{qty}{price_str}{sku_str}")
    else:
        # Fallback: show raw data keys
        lines.append(f"  商品信息: {str(data)[:200]}")

    # Extract total
    total = (
        data.get("totalAmount")
        or data.get("total")
        or data.get("orderAmount")
        or data.get("totalPrice")
    )
    if total is not None:
        lines.append(f"  ───────")
        lines.append(f"  合计：¥{total}")

    # Any additional notes
    note = data.get("remark") or data.get("note") or data.get("message")
    if note:
        lines.append(f"  备注：{note}")

    return "\n".join(lines)


async def handle_create_order(args: dict, deps) -> str:
    """创建瑞幸咖啡订单.

    Args:
        dept_id: 门店ID
        product_id: 商品ID
        sku_code: SKU编码
        amount: 数量（默认1）
        latitude: 纬度
        longitude: 经度
    """
    client = deps.luckin_mcp
    dept_id = int(args["dept_id"])
    items = [{
        "productId": int(args["product_id"]),
        "skuCode": args["sku_code"],
        "amount": int(args.get("amount", 1)),
    }]
    # Use .env coordinates as default (matches find_store/search_menu)
    default_lat = LUCKIN_LAT or 39.9042
    default_lng = LUCKIN_LNG or 116.4074
    lat = float(args.get("latitude", default_lat))
    lng = float(args.get("longitude", default_lng))

    result = await client.create_order(dept_id, items, lat, lng)

    # Debug: log full response for troubleshooting
    logger.warning("create_order RAW response: %s", json.dumps(result, ensure_ascii=False)[:1000])

    # Check for top-level error or API failure
    err = result.get("error") or result.get("errMsg") or result.get("message")
    if err:
        return f"下单失败: {err}"
    if result.get("success") is False:
        return f"下单失败: {result.get('msg', '未知错误')}"

    # Try to extract order identifiers from various possible response structures
    # Common patterns: flat keys, nested "data" object, or result wrapper
    data_payload = result.get("data") or result.get("result") or result
    if isinstance(data_payload, dict):
        order_id = (
            data_payload.get("orderId")
            or data_payload.get("order_id")
            or data_payload.get("orderID")
            or result.get("orderId")
            or result.get("order_id")
            or result.get("orderID")
            or ""
        )
        pick_code = (
            data_payload.get("pickCode")
            or data_payload.get("pick_code")
            or data_payload.get("pickCode")
            or data_payload.get("pickUpCode")
            or result.get("pickCode")
            or result.get("pick_code")
            or result.get("pickUpCode")
            or ""
        )
        success = data_payload.get("success") or result.get("success") or True
    else:
        order_id = result.get("orderId") or result.get("order_id") or ""
        pick_code = result.get("pickCode") or result.get("pick_code") or ""
        success = True

    if not order_id and not pick_code:
        # Last resort: check for success indicators in the response
        text = str(result)
        if any(kw in text for kw in ("成功", "下单", "orderId", "pickCode")):
            logger.warning("create_order: found success keyword but no structured fields. Raw: %.200s", text)
            return f"下单成功（详情：{text[:200]}）"
        # Truly unrecognizable response
        raise RuntimeError(f"下单返回结构无法识别: {str(result)[:300]}")

    msg = "✅ 下单成功！"
    if order_id:
        msg += f"\n订单号: {order_id}"
    if pick_code:
        msg += f"\n取餐码: {pick_code}"

    # Additional info from response
    amount = data_payload.get("totalAmount") or data_payload.get("total") or data_payload.get("payAmount")
    if amount is not None:
        msg += f"\n金额: ¥{amount}"
    estimate = data_payload.get("estimateWait") or data_payload.get("waitTime") or data_payload.get("makeTime")
    if estimate is not None:
        msg += f"\n预计等待: {estimate}分钟"

    return msg


async def handle_switch_product(args: dict, deps) -> str:
    """切换瑞幸咖啡商品规格选项，获取 variant SKU.

    Args:
        dept_id: 门店ID
        product_id: 商品ID
        sku_code: 当前产品级 SKU
        attribute_id: 属性组ID（如 17=温度, 18=糖度, 64=杯型），从 get_product_detail 结果中获取
        sub_attribute_id: 属性值ID（如 57=冰, 59=少少甜），从 get_product_detail 结果中获取
        amount: 数量，默认1
    """
    client = deps.luckin_mcp
    result = await client.switch_product(
        dept_id=int(args["dept_id"]),
        product_id=int(args["product_id"]),
        sku_code=args["sku_code"],
        attribute_id=int(args["attribute_id"]),
        sub_attribute_id=int(args["sub_attribute_id"]),
        amount=int(args.get("amount", 1)),
    )
    data = result.get("data") or result
    name = data.get("productName") or data.get("name") or "未知"
    sku = data.get("skuCode") or ""
    lines = [f"🔄 {name}"]
    if sku:
        lines.append(f"  SKU：{sku}")
    # Show updated attributes with selection marks
    attrs = data.get("productAttrs") or []
    for attr in attrs[:6]:
        attr_name = attr.get("attributeName") or "?"
        subs = attr.get("productSubAttrs") or []
        opts = [s.get("attributeName", "?") + (" ✓" if s.get("selected") else "") for s in subs[:8]]
        lines.append(f"  {attr_name}：{'、'.join(opts)}")
    return "\n".join(lines)


async def handle_query_order(args: dict, deps) -> str:
    """查询瑞幸咖啡订单详情.

    Args:
        order_id: 订单ID（字符串）
    """
    client = deps.luckin_mcp
    result = await client.query_order_detail(args["order_id"])
    data = result.get("data") or result
    status = data.get("orderStatusName", "未知")
    order_id = data.get("orderId", "")
    pay_amount = data.get("orderPayAmount", "")
    take_code = ""
    code_info = data.get("takeMealCodeInfo") or {}
    if code_info.get("code"):
        take_code = code_info["code"]
    lines = [f"📋 订单 {order_id}"]
    lines.append(f"  状态：{status}")
    if pay_amount:
        lines.append(f"  金额：¥{pay_amount}")
    if take_code:
        lines.append(f"  取餐码：{take_code}")
    # Product info
    products = data.get("productInfoList") or data.get("orderCommodityList") or []
    for p in products[:5]:
        pname = p.get("name") or p.get("commodityName") or "?"
        qty = p.get("amount", 1)
        lines.append(f"  · {pname} ×{qty}")
    return "\n".join(lines)


async def handle_cancel_order(args: dict, deps) -> str:
    """取消瑞幸咖啡订单.

    Args:
        order_id: 订单ID（字符串）
    """
    client = deps.luckin_mcp
    result = await client.cancel_order(args["order_id"])
    data = result.get("data") or result
    if data is True:
        return "✅ 订单已取消"
    return f"取消失败: {result.get('msg', '未知错误')}"


async def handle_get_product_detail(args: dict, deps) -> str:
    """查询瑞幸咖啡商品详情（含规格选项）.

    用户搜索饮品后，调用此 skill 查看具体规格（冰/热、糖度、杯型、SKU编码等），方便确认后再下单.

    Args:
        dept_id: 门店ID
        product_id: 商品ID
    """
    client = deps.luckin_mcp
    dept_id = int(args["dept_id"])
    product_id = int(args["product_id"])

    result = await client.get_product_detail(dept_id, product_id)
    logger.warning("get_product_detail RAW: %s", json.dumps(result, ensure_ascii=False)[:1000])
    logger.debug("get_product_detail raw: %s", json.dumps(result, ensure_ascii=False)[:500])

    # API wraps result in {"code":0, "data":{...}}
    data = result.get("data") or result
    if not data:
        return "未找到该商品详情"

    name = (
        data.get("productName")
        or data.get("name")
        or data.get("itemName")
        or "未知商品"
    )
    price = (
        data.get("salePrice")
        or data.get("price")
        or data.get("minPrice")
        or ""
    )
    desc = data.get("description") or data.get("desc") or ""
    sku_code = data.get("skuCode") or data.get("sku") or ""

    deps.session_state["specs_shown"] = True
    logger.info("session_state: specs_shown=True for product %s", product_id)

    lines = [f"📄 {name}"]
    if price:
        lines.append(f"  价格：¥{price}")
    if desc:
        lines.append(f"  说明：{desc[:100]}")
    if sku_code:
        lines.append(f"  SKU：{sku_code}")

    # Extract spec options from productAttrs (MCP API format)
    product_attrs = data.get("productAttrs") or []
    if isinstance(product_attrs, list) and product_attrs:
        for attr in product_attrs[:6]:
            attr_name = attr.get("attributeName") or "?"
            sub_attrs = attr.get("productSubAttrs") or []
            if sub_attrs:
                options = []
                for sa in sub_attrs[:8]:
                    opt_name = sa.get("attributeName") or "?"
                    if sa.get("selected"):
                        options.append(f"{opt_name} ✓")
                    else:
                        options.append(opt_name)
                lines.append(f"  {attr_name}：" + "、".join(options))
    else:
        keys = list(data.keys())[:10]
        if keys:
            lines.append("  原始字段：" + "、".join(keys))

    return "\n".join(lines)
