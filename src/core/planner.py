"""Planner — converts user intent into structured DSL execution plan.

Three-stage pipeline:
  1. Keyword matching — retrieve candidate skills from registry
  2. Constraint filtering — permission + environment checks (Phase 1: stub)
  3. LLM decision + DSL generation — single LLM call produces the Plan
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from src.config import DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL
from src.skill.registry import SkillRegistry

logger = logging.getLogger(__name__)

# ── System prompt template ──────────────────────────────────────────────────

SYSTEM_PROMPT_HEADER = """你是 Orca 的规划器，负责把用户需求转成执行计划。

reply 的 message 内容按 Orca 的语气写：简短、技术宅室友感、话不多但不冷漠。不说客套话，不反问撑场子。

重要：只输出 JSON，不要包含任何其他文字、解释、markdown 代码块标记。

输出格式严格遵循以下 JSON schema：
{
    "ack": "可选。当 plan 需要实际执行（多步或操作）时，简短告知用户正在处理。纯闲聊不需要此字段。",
    "reasoning": "你的思考过程",
    "steps": [
        {
            "id": "可选，被后续步骤引用时需要",
            "skill": "skill名称",
            "args": {
                "参数名": "参数值"
            },
            "narration": "可选。执行该 step 前发给用户的中文进度提示，简短自然，贴合人设"
        }
    ]
}

规则：
1. 只使用下面列出的 skill，不要 invent 不存在的 skill
2. 输出严格的 JSON，不要包含 markdown 代码块标记
3. plan 的最后一步必须是 reply
4. 如果某步的结果需要被后面的步骤引用，可以用 skill 名称作为隐式 id：{{{{step.<skill名>.output}}}}。如果该步有显式 id（如 {{id: "store"}}），则用显式 id：{{{{step.store.output}}}}
5. 如果用户只是闲聊或问候，直接生成一步 reply 即可
6. args 是一个对象，参数直接放在 args 里面，不要放在 step 的顶层
7. 信息不足时先用 skill 尝试，失败再用 reply 告知。例如用户说"想喝咖啡"，先调 luckin_find_store 查门店（不传参数自动 IP 定位），不要问"你在哪个城市"
8. 需要用户选择时才问，比如查出门店列表后问用户去哪家
9. 如果用户已经选了门店（说门店名/编号/这家），直接搜菜单或下单，不要再调 luckin_find_store。同理，用户选了饮品后直接下单，不走回头路
10. 持续性任务（如点咖啡）的 DSL 必须加顶层 task_type 和 stage 字段。task_type 标记任务类型（如"luckin_order"），stage 标记当前进度（如"store_listed"、"store_selected"、"menu_shown"、"detail_shown"）。闲聊/一次性操作不需要这两个字段

正确示例（闲聊）：
{"ack": "嗯，在呢。", "reasoning": "用户只是打招呼，直接回复", "steps": [{"skill": "reply", "args": {"message": "嗯，还行。"}}]}

正确示例（多步——截图→分析→润色→回复）：
{"ack": "看一下你的桌面。", "reasoning": "用户想看桌面，截图、分析、润色后回复", "steps": [{"id": "cap", "skill": "capture_screenshot", "args": {}, "narration": "截个图看看。"}, {"id": "ana", "skill": "analyze_image", "args": {"task": "描述桌面内容", "image_path": "{{step.cap.output}}", "narration": "分析一下这张图。"}}, {"id": "ref", "skill": "refine", "args": {"raw_output": "{{step.ana.output}}", "narration": "把结果整理一下。"}}, {"skill": "reply", "args": {"message": "{{step.ref.output}}"}}]}

正确示例（点咖啡——查门店，reply 引用 luckin_find_store 的输出展示门店列表）：
{"task_type": "luckin_order", "stage": "store_listed", "ack": "看看附近。", "reasoning": "用户想喝咖啡，先查门店让用户选", "steps": [{"skill": "luckin_find_store", "args": {}, "narration": "找找附近的门店。"}, {"skill": "reply", "args": {"message": "{{step.luckin_find_store.output}}\n想去哪家？"}}]}

正确示例（点咖啡——用户选了门店但没说喝什么，query 传空字符串展示全部商品）：
{"task_type": "luckin_order", "stage": "store_selected", "ack": "看看菜单。", "reasoning": "用户选了店但没说喝什么，搜全部饮品让用户挑", "steps": [{"skill": "luckin_search_menu", "args": {"dept_id": 610287, "query": ""}, "narration": "看看有什么喝的。"}, {"skill": "reply", "args": {"message": "这家店有这些，看看想喝哪个？\n{{step.luckin_search_menu.output}}"}}]}

正确示例（点咖啡——用户指定了饮品名后搜）：
{"task_type": "luckin_order", "stage": "menu_searching", "ack": "搜一下。", "reasoning": "用户点了饮品名，搜匹配的", "steps": [{"skill": "luckin_search_menu", "args": {"dept_id": 610287, "query": "拿铁"}, "narration": "搜一下。"}, {"skill": "reply", "args": {"message": "找到了：\n{{step.luckin_search_menu.output}}"}}]}

正确示例（点咖啡——用户指定了商品后下单）：
{"task_type": "luckin_order", "stage": "ordering", "ack": "下单了。", "reasoning": "用户选好了门店和商品，直接下单", "steps": [{"skill": "luckin_preview_order", "args": {"dept_id": 12345, "product_id": 678, "sku_code": "SKU001"}, "narration": "先预览一下。"}, {"skill": "luckin_create_order", "args": {"dept_id": 12345, "product_id": 678, "sku_code": "SKU001"}, "narration": "下单中。"}, {"skill": "reply", "args": {"message": "好了，取餐码 886。"}}]}

正确示例（多轮——用户说"第一家"，从 session_state 的 store_list 中取 dept_id）：
{"task_type": "luckin_order", "stage": "store_selected", "ack": "好的。", "reasoning": "用户选了第一家门店，从 session_state.store_list 取 dept_id=610287，搜菜单", "steps": [{"skill": "luckin_search_menu", "args": {"dept_id": 610287, "query": ""}, "narration": "看看这家店有什么喝的。"}, {"skill": "reply", "args": {"message": "这家店有这些，看看想喝哪个？\n{{step.luckin_search_menu.output}}"}}]}

正确示例（多轮——用户说"喝生椰拿铁"，已有 selected_dept_id，直接搜该店菜单）：
{"task_type": "luckin_order", "stage": "menu_searching", "ack": "搜一下。", "reasoning": "用户已有选中门店 dept_id=610287，搜生椰拿铁", "steps": [{"skill": "luckin_search_menu", "args": {"dept_id": 610287, "query": "生椰拿铁"}, "narration": "搜一下。"}, {"skill": "reply", "args": {"message": "找到了：\n{{step.luckin_search_menu.output}}"}}]}

正确示例（多轮——用户在菜单中说"就第一个"，搜到商品列表后看详情取 SKU）：
{"task_type": "luckin_order", "stage": "detail_shown", "ack": "看看详情。", "reasoning": "用户选了第一个商品，调商品详情取 SKU 规格", "steps": [{"skill": "luckin_get_product_detail", "args": {"dept_id": 610287, "product_id": 1262}, "narration": "看看这杯的规格。"}, {"skill": "reply", "args": {"message": "这杯的规格如下，要什么温度杯型？\n{{step.luckin_get_product_detail.output}}"}}]}

可用 skill：

{skills}
"""


# ── Helper: Chinese-aware message segmentation ──────────────────────────────


def _segment_message(msg: str) -> list[str]:
    """Split a message into meaningful segments for keyword matching.

    For English: split by whitespace.
    For Chinese: extract 2-4 character sliding windows + single Chinese chars.
    """
    parts = msg.split()
    if len(parts) > 1:
        return parts
    segments = []
    # 2-4 char spans
    for length in (4, 3, 2):
        for i in range(len(msg) - length + 1):
            seg = msg[i:i + length]
            if not seg.isdigit():
                segments.append(seg)
    # Single Chinese characters (non-common)
    for ch in msg:
        if '\u4e00' <= ch <= '\u9fff' and ch not in "的了是在有我":
            segments.append(ch)
    return segments


def _strip_markdown_json(text: str) -> str:
    """Strip markdown code block markers from LLM output.

    Handles ```json ... ```, ``` ... ```, and plain JSON.
    """
    text = text.strip()
    # Remove ```json ... ``` or ``` ... ```
    if text.startswith("```"):
        # Find the end of the first line (language specifier)
        first_nl = text.find("\n")
        if first_nl != -1:
            text = text[first_nl + 1:]
        # Remove trailing ```
        if text.endswith("```"):
            text = text[:-3]
        elif "```" in text:
            text = text[:text.rfind("```")]
    return text.strip()


# ── Planner ──────────────────────────────────────────────────────────────────


class Planner:
    """Three-stage planner: match → filter → generate DSL."""

    def __init__(self, registry: SkillRegistry):
        self._registry = registry

    # ── Stage 1: Keyword matching ───────────────────────────────────────

    def _match_skills(self, user_message: str, session_state: dict | None = None) -> list[str]:
        """Retrieve candidate skills by keyword matching.

        Phase 1: substring matching on skill names and descriptions.
        Supports both English and Chinese: checks if any meaningful segment
        of the user message appears in the skill's name or description.
        reply is always included (D-PLAN-02).

        If session_state has selected_dept_id, luckin_find_store is excluded
        since the user has already chosen a store (rule 9).
        """
        # ── Context-based exclusion ─────────────────────────────────────
        has_selected_store = bool(
            session_state and session_state.get("selected_dept_id")
        )
        excluded = set()
        if has_selected_store:
            excluded.add("luckin_find_store")

        candidates = {"reply"}  # always included
        lower_msg = user_message.lower()

        for skill in self._registry.list():
            if skill.name == "reply":
                continue
            if skill.name in excluded:
                continue

            # Priority 1: keywords match (fast, precise)
            if skill.keywords:
                kw_combined = "".join(skill.keywords).lower()
                if any(kw in lower_msg for kw in skill.keywords):
                    candidates.add(skill.name)
                    continue

            # Priority 2: skill name match (English)
            if skill.name.lower() in lower_msg:
                candidates.add(skill.name)
                continue

            # Priority 3: description + params segment match (Chinese)
            desc = skill.description.lower() + " " + " ".join(skill.params.keys())
            msg_segs = _segment_message(lower_msg)
            desc_segs = _segment_message(desc)
            msg_matches_desc = any(
                seg in desc
                for seg in msg_segs
                if len(seg) >= 2 or ('\u4e00' <= seg <= '\u9fff' and seg not in "的了是在有我")
            )
            desc_matches_msg = any(
                seg in lower_msg
                for seg in desc_segs
                if len(seg) >= 2 or ('\u4e00' <= seg <= '\u9fff' and seg not in "的了是在有我")
            )
            if msg_matches_desc or desc_matches_msg:
                candidates.add(skill.name)
                continue

        # ── Post-processing: implicit skill associations ────────────────

        # analyze_image → needs refine
        if "analyze_image" in candidates:
            candidates.add("refine")

        # Session with store_list + user confirms store → add search_menu
        if session_state and session_state.get("store_list"):
            store_confirm_keywords = ["第", "一", "二", "三", "四", "五",
                                      "这家", "那家", "就它", "就这个",
                                      "对", "好", "可以", "行", "嗯"]
            if any(kw in user_message for kw in store_confirm_keywords):
                candidates.add("luckin_search_menu")
                logger.debug("Session has store_list + confirm keywords: added luckin_search_menu")

        return list(candidates)

    # ── Stage 2: Constraint filtering ───────────────────────────────────

    def _filter_skills(self, candidates: list[str]) -> list[str]:
        """Filter candidates by hard constraints.

        Phase 1:
        - Permission: all skills are "user" level, no filtering needed
        - Environment: no adapter-dependent skills yet
        """
        # Phase 1 stub — no filtering
        return candidates

    # ── Stage 3: LLM DSL generation ─────────────────────────────────────

    async def _generate_dsl(self, user_message: str, skills: list[str], history: str,
                            session_state: dict | None = None) -> tuple[str, str]:
        """Call LLM to produce a DSL execution plan and ACK message.

        Returns:
            (raw_dsl_json_string, ack_message)
        """
        # Build skill descriptions for selected skills
        desc_lines = []
        for skill_name in skills:
            meta = self._registry.get(skill_name)
            if meta:
                desc_lines.append(self._registry._format_one(meta))

        skills_text = "\n\n".join(desc_lines) if desc_lines else "当前没有可用 skill。"

        # Use string replacement to avoid .format() conflicts with JSON braces
        system_prompt = SYSTEM_PROMPT_HEADER.replace('{skills}', skills_text)

        # ── Inject session_state + active_task (multi-turn context) ─────
        session_lines = []
        if session_state:
            # Priority 1: active_task from Orchestrator (cross-plan task tracking)
            active_task_str = session_state.pop("_active_task", None)
            if active_task_str:
                session_lines.append(active_task_str)

            # Priority 2: session_state details (handler-written cross-turn data)
            selected_dept_id = session_state.get("selected_dept_id")
            selected_dept_name = session_state.get("selected_dept_name")
            store_list = session_state.get("store_list")

            if selected_dept_id:
                name_hint = f"（{selected_dept_name}）" if selected_dept_name else ""
                session_lines.append(
                    f"已选中门店 dept_id={selected_dept_id}{name_hint}"
                )
                session_lines.append(
                    "规则 9 适用：用户已选门店，直接搜索菜单或下单，不要调 luckin_find_store。"
                )
            if store_list:
                store_summary = "\n".join(
                    f"  {i+1}. {s.get('deptName', '?')} [dept_id: {s.get('deptId', '?')}]"
                    for i, s in enumerate(store_list)
                )
                session_lines.append(f"附近门店列表：\n{store_summary}")

        session_prompt = "\n".join(session_lines)

        messages = [
            {"role": "system", "content": system_prompt},
        ]

        if session_prompt:
            messages.append({"role": "user", "content": session_prompt})
            messages.append({"role": "assistant", "content": "已了解当前会话状态。"})

        if history:
            messages.append({"role": "user", "content": f"之前的对话：\n{history}"})
            messages.append({"role": "assistant", "content": "知道了。"})

        messages.append({"role": "user", "content": user_message})

        payload = {
            "model": DEEPSEEK_MODEL,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 2000,
            # No tools/function_calling — LLM outputs DSL as JSON text
        }

        headers = {
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(DEEPSEEK_API_URL, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                raw = data["choices"][0]["message"]["content"].strip()
                logger.debug("Raw LLM output: %.300s", raw)
                cleaned = _strip_markdown_json(raw) or raw
                ack_msg = self._extract_ack(cleaned)
                return cleaned, ack_msg
        except httpx.HTTPError as e:
            logger.warning("Planner API error: %s", e)
            dsl = json.dumps({
                "reasoning": "LLM 调用失败",
                "steps": [{"skill": "reply", "args": {"message": "嗯，出问题了，稍等一下。"}}],
            })
            return dsl, "出问题了，稍等一下。"
        except Exception as e:
            logger.warning("Planner failed: %s", e)
            dsl = json.dumps({
                "reasoning": "规划器异常",
                "steps": [{"skill": "reply", "args": {"message": "嗯，出问题了，稍等一下。"}}],
            })
            return dsl, "出问题了，稍等一下。"

    @staticmethod
    def _extract_ack(dsl_json: str) -> str:
        """Extract ack message from DSL JSON, with fallback."""
        try:
            data = json.loads(dsl_json)
            ack = data.get("ack", "")
            if ack and isinstance(ack, str):
                return ack
        except (json.JSONDecodeError, KeyError):
            pass
        return "好的，正在处理。"

    # ── Full pipeline ───────────────────────────────────────────────────

    async def plan(self, user_message: str, history: str,
                   session_state: dict | None = None) -> tuple[str, str, list[str]]:
        """Run the full three-stage planning pipeline.

        Args:
            user_message: The user's latest message.
            history: Recent conversation turns as formatted text.
            session_state: Cross-turn context (selected_dept_id, store_list, etc.).

        Returns:
            (ack_message, raw_dsl_json, candidate_skill_names)
        """
        logger.info("Planning for: %.80s", user_message)
        if session_state and session_state.get("selected_dept_id"):
            logger.info("Session has selected store: dept_id=%s",
                        session_state["selected_dept_id"])

        # Stage 1: Match (with session context to skip luckin_find_store)
        candidates = self._match_skills(user_message, session_state)
        logger.debug("Stage 1 — matched skills: %s", candidates)

        # Stage 2: Filter
        filtered = self._filter_skills(candidates)
        logger.debug("Stage 2 — after filter: %s", filtered)

        # Stage 3: Generate (with session context injected into prompt)
        raw_dsl, ack_msg = await self._generate_dsl(
            user_message, filtered, history, session_state
        )
        logger.debug("Stage 3 — raw DSL: %.150s", raw_dsl)
        logger.debug("Stage 3 — ACK: %s", ack_msg)

        return ack_msg, raw_dsl, filtered
