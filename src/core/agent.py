"""ReAct Agent — DeepSeek drives a tool-calling loop.

DeepSeek reasons, calls tools (Qwen vision / desktop actions / messages),
gets results, and repeats until it produces a final response.
"""

import json
import logging
from collections.abc import Callable

import httpx

from src.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL
from src.core.persona import ORCA_PERSONA_PROMPT

logger = logging.getLogger(__name__)

MAX_LOOPS = 10

# ── Tool definitions (sent to DeepSeek API) ─────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "analyze_screenshot",
            "description": "用视觉模型分析当前屏幕截图。可描述桌面内容、查找UI元素位置坐标。",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "要视觉模型做什么，例如：描述桌面上有什么窗口、找到浏览器地址栏的坐标"
                    }
                },
                "required": ["task"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "execute_action",
            "description": "执行桌面鼠标或键盘操作",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["click", "double_click", "right_click", "type", "scroll", "move"],
                    },
                    "x": {"type": "number", "description": "x坐标"},
                    "y": {"type": "number", "description": "y坐标"},
                    "text": {"type": "string", "description": "type操作时输入的文字"},
                    "clicks": {"type": "number", "description": "scroll操作滚动格数"},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_message",
            "description": "在思考过程中给用户发一条中间消息，让对方知道你在干什么",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "消息内容，自然一些"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "搜索网络获取实时信息，回答用户问题时如果需要最新信息可以调用",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "luckin_lookup",
            "description": "查询瑞幸咖啡门店和菜单信息。输入饮品名称或门店名称，自动查找附近门店和商品信息。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要查询的内容，如饮品名'生椰拿铁'或门店名'望京店'"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "luckin_order",
            "description": "通过瑞幸 CLI 下单。必须先调用 luckin_lookup 获取门店ID和商品ID后再使用。参数用JSON格式传入，包含dept_id/items/lat/lng字段",
            "parameters": {
                "type": "object",
                "properties": {
                    "params": {"type": "string", "description": "JSON 字符串，包含: dept_id(门店ID), items(商品列表，每个含product_id/sku_code/amount), lat(纬度), lng(经度), coupon(可选券码)"},
                },
                "required": ["params"],
            },
        },
    },
]


INSTRUCTIONS = (
    "你可以使用以下工具来完成任务。每次先思考再决定下一步。\n"
    "- analyze_screenshot: 需要看图时调用（查看桌面、找坐标）\n"
    "- execute_action: 要操作电脑时调用（点击、打字、滚动）\n"
    "- send_message: 处理过程中给用户发消息，让对方了解进度\n"
    "- search_web: 需要实时信息时搜索网络\n"
    "- luckin_lookup: 查询瑞幸咖啡的门店和饮品信息\n"
    "- luckin_order: 通过瑞幸 CLI 下单（先 luckin_lookup 再下单）\n\n"
    "点咖啡流程：先 luckin_lookup 查饮品和门店 → 发消息让用户确认 → 再 luckin_order 下单。\n"
    "思考过程如果有话说，通过 send_message 发给用户。\n"
    "任务完成后，直接回复用户，不要再调工具。"
)


# ── Agent loop ────────────────────────────────────────────────────────────


async def run(
    user_message: str,
    history: str,
    *,
    on_send: Callable[[str], None],
    on_screenshot: Callable[[str], str],
    on_action: Callable[[str, dict], str],
    on_search: Callable[[str], str] | None = None,
    on_luckin_lookup: Callable[[str], str] | None = None,
    on_luckin_order: Callable[[str], str] | None = None,
) -> str:
    """Run the ReAct agent loop.

    Args:
        user_message: The user's message.
        history: Recent conversation history.
        on_send: Callback to send a message to the user.
        on_screenshot: Callback to analyze screenshot, returns text result.
        on_action: Callback to execute desktop action, returns result text.

    Returns:
        The final response text.
    """
    messages = [
        {"role": "system", "content": f"{ORCA_PERSONA_PROMPT}\n\n{INSTRUCTIONS}"},
    ]
    if history:
        messages.append({"role": "user", "content": f"之前的对话：\n{history}"})
        messages.append({"role": "assistant", "content": "知道了。"})
    messages.append({"role": "user", "content": user_message})

    headers = {"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"}

    for turn in range(MAX_LOOPS):
        logger.info("Agent turn %d/%d", turn + 1, MAX_LOOPS)

        payload = {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto",
            "temperature": 0.3,
            "max_tokens": 1000,
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(DEEPSEEK_API_URL, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                msg = data["choices"][0]["message"]
                finish = data["choices"][0].get("finish_reason", "stop")
        except httpx.HTTPError as e:
            logger.warning("Agent API %s: %s", e.response.status_code, e.response.text[:300])
            return "嗯，出问题了，稍等一下。"
        except Exception as e:
            logger.warning("Agent API call failed: %s", e)
            return "嗯，出问题了，稍等一下。"

        # ── Extract content (intermediate message) ──
        content = msg.get("content", "").strip()
        tool_calls = msg.get("tool_calls", [])

        # ── No tool calls → final response ──
        if not tool_calls:
            logger.info("Agent finished: %.80s", content)
            return content if content else "好了。"

        # Assistant message with tool_calls goes FIRST
        messages.append(msg)

        # Send intermediate message content (if any)
        if content:
            await on_send(content)

        # ── Execute tool calls ──
        for tc in tool_calls:
            func = tc.get("function", {})
            name = func.get("name", "")
            try:
                args = json.loads(func.get("arguments", "{}"))
            except json.JSONDecodeError:
                args = {}

            logger.info("Agent calls %s(%s)", name, args)

            if name == "send_message":
                await on_send(args.get("text", ""))
                result = "已发送"

            elif name == "analyze_screenshot":
                result = await on_screenshot(args.get("task", "描述桌面"))
                logger.info("Screenshot result: %.80s", result)

            elif name == "execute_action":
                action = args.get("action", "none")
                params = {k: v for k, v in args.items() if k != "action"}
                result = await on_action(action, params)
                logger.info("Action result: %s", result)

            elif name == "search_web" and on_search:
                result = await on_search(args.get("query", ""))
                logger.info("Search result: %.80s", result)

            elif name == "luckin_lookup" and on_luckin_lookup:
                result = await on_luckin_lookup(args.get("query", ""))
                logger.info("Luckin lookup: %.80s", result)

            elif name == "luckin_order" and on_luckin_order:
                result = await on_luckin_order(args.get("params", "{}"))
                logger.info("Luckin order: %.80s", result)

            else:
                result = f"未知工具: {name}"

            # Add tool result to conversation
            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": result,
            })

    logger.warning("Agent hit max loops")
    return "搞太久了，先到这儿吧。"
