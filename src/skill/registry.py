"""Skill Registry — the closed-world set of executable skills.

Skills are the ONLY executable unit in Orca. LLM cannot invent new skills.
The Registry stores both metadata (for Planner) and handler functions (for Runtime).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── Types ────────────────────────────────────────────────────────────────────

# Handler signature: async def handler(args: dict, deps: SkillDeps) -> str
SkillHandler = Callable[[dict, Any], Coroutine[Any, Any, str]]


@dataclass
class SkillMetadata:
    """Immutable metadata for a single skill."""

    name: str
    description: str
    params: dict[str, dict] = field(default_factory=dict)
    """param_name → {type, required, enum?, description}

    Example:
    {
        "x": {"type": "int", "required": True, "description": "x坐标"},
        "y": {"type": "int", "required": True, "description": "y坐标"},
    }
    """

    output: str = "string"
    """Output type description. Currently all skills output string."""

    permission: str = "user"
    """Phase 1: all skills are 'user' level."""

    progress_message: str | None = None
    """Optional narration shown before execution. None = no narration."""

    handler: SkillHandler | None = None
    """Async handler function. Injected at registration time."""


# ── Registry ─────────────────────────────────────────────────────────────────


class SkillRegistry:
    """Closed-world registry of all executable skills.

    Both Planner (metadata) and Runtime (handlers) read from the same source.
    """

    def __init__(self):
        self._skills: dict[str, SkillMetadata] = {}

    # ── Registration ─────────────────────────────────────────────────────

    def register(self, meta: SkillMetadata) -> None:
        """Register or override a skill."""
        if meta.handler is None:
            raise ValueError(f"Skill '{meta.name}' registered without handler")
        self._skills[meta.name] = meta
        logger.debug("Registered skill: %s", meta.name)

    def register_many(self, *skills: SkillMetadata) -> None:
        for s in skills:
            self.register(s)

    # ── Lookup ───────────────────────────────────────────────────────────

    def get(self, name: str) -> SkillMetadata | None:
        return self._skills.get(name)

    def require(self, name: str) -> SkillMetadata:
        skill = self.get(name)
        if skill is None:
            raise KeyError(f"Skill '{name}' not found in registry")
        return skill

    def has(self, name: str) -> bool:
        return name in self._skills

    # ── Iteration ────────────────────────────────────────────────────────

    @property
    def names(self) -> set[str]:
        return set(self._skills.keys())

    def list(self) -> list[SkillMetadata]:
        return list(self._skills.values())

    # ── Planner helpers ──────────────────────────────────────────────────

    def skill_descriptions(self) -> str:
        """Format all skills as natural-language text for Planner's system prompt."""
        lines = []
        # Always put reply first
        reply = self._skills.get("reply")
        if reply:
            lines.append(self._format_one(reply))
        for skill in self._skills.values():
            if skill.name == "reply":
                continue
            lines.append(self._format_one(skill))
        return "\n\n".join(lines)

    @staticmethod
    def _format_one(skill: SkillMetadata) -> str:
        parts = [f"## {skill.name}"]
        parts.append(f"描述：{skill.description}")

        if skill.params:
            param_lines = []
            for pname, pinfo in skill.params.items():
                req = "（必填）" if pinfo.get("required") else "（可选）"
                e = f" 可选值: {pinfo['enum']}" if pinfo.get("enum") else ""
                param_lines.append(f"  - {pname}: {pinfo.get('description', '')}{req}{e}")
            parts.append("参数：\n" + "\n".join(param_lines))

        parts.append(f"输出：{skill.output}")
        return "\n".join(parts)

    # ── Schema for Validator ─────────────────────────────────────────────

    @property
    def schemas(self) -> dict[str, dict]:
        """Return schemas in validator-consumable format.

        {skill_name: {"params": {param_name: {type, required, enum}}}}
        """
        result = {}
        for name, skill in self._skills.items():
            result[name] = {"params": dict(skill.params)}
        return result
