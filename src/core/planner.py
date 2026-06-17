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

SYSTEM_PROMPT_HEADER = """你是 Orca 的规划器。根据用户的意图，从可用 skill 中选择合适的 skill 编排执行计划。

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
3. 如果需要用户确认或信息不足，直接用 reply skill 告知用户
4. plan 的最后一步必须是 reply
5. 如果某步的结果需要被后面的步骤引用，给该步加一个 id。被引用的 step 必须有 id
6. 引用格式严格为 {{{{step.<实际的id>.output}}}}，不能用 skill 名称代替 id
7. 如果用户只是闲聊或问候，直接生成一步 reply 即可
8. 不需要用户输入即可完成的步骤，不要询问用户，直接执行
9. args 是一个对象，参数直接放在 args 里面，不要放在 step 的顶层

正确示例（闲聊）：
{"ack": "嗯，在呢。", "reasoning": "用户只是打招呼，直接回复", "steps": [{"skill": "reply", "args": {"message": "嗯，还行。"}}]}

正确示例（多步——截图→分析→润色→回复）：
{"ack": "看一下你的桌面。", "reasoning": "用户想看桌面，截图、分析、润色后回复", "steps": [{"id": "cap", "skill": "capture_screenshot", "args": {}, "narration": "截个图看看。"}, {"id": "ana", "skill": "analyze_image", "args": {"task": "描述桌面内容", "image_path": "{{step.cap.output}}", "narration": "分析一下这张图。"}}, {"id": "ref", "skill": "refine", "args": {"raw_output": "{{step.ana.output}}", "narration": "把结果整理一下。"}}, {"skill": "reply", "args": {"message": "{{step.ref.output}}"}}]}

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

    def _match_skills(self, user_message: str) -> list[str]:
        """Retrieve candidate skills by keyword matching.

        Phase 1: substring matching on skill names and descriptions.
        Supports both English and Chinese: checks if any meaningful segment
        of the user message appears in the skill's name or description.
        reply is always included (D-PLAN-02).
        """
        candidates = {"reply"}  # always included
        lower_msg = user_message.lower()

        for skill in self._registry.list():
            if skill.name == "reply":
                continue

            # Match against skill name (English)
            if skill.name.lower() in lower_msg:
                candidates.add(skill.name)
                continue

            # Match against description (supports Chinese)
            desc = skill.description.lower() + " " + " ".join(skill.params.keys())
            msg_segs = _segment_message(lower_msg)
            desc_segs = _segment_message(desc)
            # Check if any segment from message appears in description
            msg_matches_desc = any(
                seg in desc
                for seg in msg_segs
                if len(seg) >= 2 or ('\u4e00' <= seg <= '\u9fff' and seg not in "的了是在有我")
            )
            # Check if any segment from description appears in message (reverse)
            # Allow single Chinese chars for better recall
            desc_matches_msg = any(
                seg in lower_msg
                for seg in desc_segs
                if len(seg) >= 2 or ('\u4e00' <= seg <= '\u9fff' and seg not in "的了是在有我")
            )
            if msg_matches_desc or desc_matches_msg:
                candidates.add(skill.name)
                continue

        # Post-processing: implicit skill associations
        # If analyze_image is selected, also offer refine
        if "analyze_image" in candidates:
            candidates.add("refine")

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

    async def _generate_dsl(self, user_message: str, skills: list[str], history: str) -> tuple[str, str]:
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

        messages = [
            {"role": "system", "content": system_prompt},
        ]

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

    async def plan(self, user_message: str, history: str) -> tuple[str, str, list[str]]:
        """Run the full three-stage planning pipeline.

        Returns:
            (ack_message, raw_dsl_json, candidate_skill_names)
        """
        logger.info("Planning for: %.80s", user_message)

        # Stage 1: Match
        candidates = self._match_skills(user_message)
        logger.debug("Stage 1 — matched skills: %s", candidates)

        # Stage 2: Filter
        filtered = self._filter_skills(candidates)
        logger.debug("Stage 2 — after filter: %s", filtered)

        # Stage 3: Generate
        raw_dsl, ack_msg = await self._generate_dsl(user_message, filtered, history)
        logger.debug("Stage 3 — raw DSL: %.150s", raw_dsl)
        logger.debug("Stage 3 — ACK: %s", ack_msg)

        return ack_msg, raw_dsl, filtered
