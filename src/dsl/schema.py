"""DSL data models — Plan and SkillCall.

A Plan is a linear sequence of SkillCalls produced by the Planner,
validated by the Validator, and executed by the Runtime.

Rules (from decisions.md):
- JSON format, LLM outputs JSON
- Reference: {{step.<id>.output}} — no expressions, no computation
- Fail-fast: one step fails, whole plan stops
- Last step must be reply
- Step id optional; Runtime auto-generates _step_N keys
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


# ── Reference pattern ──────────────────────────────────────────────────────

REF_PATTERN = re.compile(r"\{\{step\.(\w+)\.output\}\}")


def parse_references(value: str) -> list[str]:
    """Extract all referenced step ids from a string.

    Example: "{{step.capture.output}}" → ["capture"]
    """
    return REF_PATTERN.findall(value)


def has_references(value: str) -> bool:
    """Check if a string contains any references."""
    return bool(REF_PATTERN.search(value))


# ── Data models ─────────────────────────────────────────────────────────────


@dataclass
class SkillCall:
    """A single step in a Plan."""

    skill: str
    args: dict[str, Any] = field(default_factory=dict)
    id: str | None = None  # optional; Runtime fills _step_N if absent


@dataclass
class Plan:
    """A complete execution plan produced by the Planner."""

    reasoning: str = ""  # LLM's thinking (not validated, for debug/audit)
    steps: list[SkillCall] = field(default_factory=list)

    # ── Validation helpers ───────────────────────────────────────────────

    def step_ids(self) -> set[str]:
        """Return all explicit step IDs (not auto-generated)."""
        return {s.id for s in self.steps if s.id is not None}

    def referenced_ids(self) -> set[str]:
        """Return all step IDs referenced across all args."""
        refs: set[str] = set()
        for step in self.steps:
            for value in step.args.values():
                if isinstance(value, str):
                    refs.update(parse_references(value))
        return refs

    def last_step(self) -> SkillCall | None:
        return self.steps[-1] if self.steps else None


# ── Plan from JSON ─────────────────────────────────────────────────────────


def plan_from_json(data: dict) -> Plan:
    """Deserialize a Plan from the JSON structure produced by the LLM.

    Expected format:
    {
        "reasoning": "...",
        "steps": [
            {"skill": "name", "args": {...}},
            {"id": "step1", "skill": "name", "args": {...}}
        ]
    }
    """
    reasoning = data.get("reasoning", "")
    steps_data = data.get("steps", [])

    steps = []
    for item in steps_data:
        steps.append(SkillCall(
            skill=item["skill"],
            args=item.get("args", {}),
            id=item.get("id"),
        ))

    return Plan(reasoning=reasoning, steps=steps)
