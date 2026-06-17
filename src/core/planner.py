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
from src.core.persona import ORCA_PERSONA_PROMPT
from src.skill.registry import SkillRegistry

logger = logging.getLogger(__name__)

# ── System prompt template ──────────────────────────────────────────────────

SYSTEM_PROMPT_HEADER = """你是 Orca 的规划器。根据用户的意图，从可用 skill 中选择合适的 skill 编排执行计划。

规则：
1. 只使用下面列出的 skill，不要 invent 不存在的 skill
2. 输出严格的 JSON，不要包含 markdown 代码块标记
3. 如果需要用户确认或信息不足，直接用 reply skill 告知用户
4. plan 的最后一步必须是 reply
5. 如果某步的结果需要被后面的步骤使用，给该步加一个 id，后面用 {{{{step.<id>.output}}}} 引用
6. 如果用户只是闲聊或问候，直接生成一步 reply 即可
7. 不需要用户输入即可完成的步骤，不要询问用户，直接执行

可用 skill：

{s kills}
"""


# ── Planner ──────────────────────────────────────────────────────────────────


class Planner:
    """Three-stage planner: match → filter → generate DSL."""

    def __init__(self, registry: SkillRegistry):
        self._registry = registry

    # ── Stage 1: Keyword matching ───────────────────────────────────────

    def _match_skills(self, user_message: str) -> list[str]:
        """Retrieve candidate skills by keyword matching.

        Phase 1: simple substring matching on skill names and descriptions.
        reply is always included (D-PLAN-02).
        """
        candidates = {"reply"}  # always included
        lower_msg = user_message.lower()

        for skill in self._registry.list():
            if skill.name == "reply":
                continue
            # Match against name
            if skill.name.lower() in lower_msg:
                candidates.add(skill.name)
                continue
            # Match against description keywords
            desc = skill.description.lower()
            # Simple: if any Chinese/English word from message appears in description
            msg_words = set(lower_msg.split())
            desc_words = set(desc.split())
            if msg_words & desc_words:
                candidates.add(skill.name)
                continue

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

    async def _generate_dsl(self, user_message: str, skills: list[str], history: str) -> str:
        """Call LLM to produce a DSL execution plan.

        Returns raw JSON string from LLM.
        """
        # Build skill descriptions for selected skills
        desc_lines = []
        for skill_name in skills:
            meta = self._registry.get(skill_name)
            if meta:
                desc_lines.append(self._registry._format_one(meta))

        skills_text = "\n\n".join(desc_lines) if desc_lines else "当前没有可用 skill。"

        system_prompt = (
            f"{ORCA_PERSONA_PROMPT}\n\n"
            f"{SYSTEM_PROMPT_HEADER.format(skills=skills_text)}"
        )

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
                content = data["choices"][0]["message"]["content"].strip()
                return content
        except httpx.HTTPError as e:
            logger.warning("Planner API error: %s", e)
            return json.dumps({
                "reasoning": "LLM 调用失败",
                "steps": [{"skill": "reply", "args": {"message": "嗯，出问题了，稍等一下。"}}],
            })
        except Exception as e:
            logger.warning("Planner failed: %s", e)
            return json.dumps({
                "reasoning": "规划器异常",
                "steps": [{"skill": "reply", "args": {"message": "嗯，出问题了，稍等一下。"}}],
            })

    # ── Full pipeline ───────────────────────────────────────────────────

    async def plan(self, user_message: str, history: str) -> tuple[str, list[str]]:
        """Run the full three-stage planning pipeline.

        Returns:
            (raw_dsl_json, candidate_skill_names)
        """
        logger.info("Planning for: %.80s", user_message)

        # Stage 1: Match
        candidates = self._match_skills(user_message)
        logger.debug("Stage 1 — matched skills: %s", candidates)

        # Stage 2: Filter
        filtered = self._filter_skills(candidates)
        logger.debug("Stage 2 — after filter: %s", filtered)

        # Stage 3: Generate
        raw_dsl = await self._generate_dsl(user_message, filtered, history)
        logger.debug("Stage 3 — raw DSL: %.150s", raw_dsl)

        return raw_dsl, filtered
