"""Validator — four-layer validation for execution plans.

Layers (in order):
  0. Safety review — LLM classifies plan as safe / warn / block
  1. Format check — valid JSON, has steps array, each step has skill field
  2. Reference check — {{step.<id>.output}} ids exist and are before current step
  3. Skill check — skill registered, params match schema
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from src.dsl.schema import Plan, REF_PATTERN, SkillCall, plan_from_json

logger = logging.getLogger(__name__)


# ── Validation result ───────────────────────────────────────────────────────


@dataclass
class SafetyResult:
    """Result of safety review (layer 0)."""
    verdict: str  # "safe" | "warn" | "block"
    reason: str = ""


@dataclass
class ValidationResult:
    """Aggregated validation outcome."""
    ok: bool
    layer: int = -1            # which layer failed (0-3); -1 = all passed
    message: str = ""          # human-readable failure reason
    plan: Plan | None = None   # parsed plan (available after layer 1 passes)

    # ── Factory helpers ──────────────────────────────────────────────────

    @classmethod
    def passed(cls, plan: Plan) -> ValidationResult:
        return cls(ok=True, plan=plan)

    @classmethod
    def failed(cls, layer: int, message: str) -> ValidationResult:
        return cls(ok=False, layer=layer, message=message)


# ── Validator ────────────────────────────────────────────────────────────────


class Validator:
    """Four-layer plan validator."""

    def __init__(self, skill_names: set[str], skill_schemas: dict[str, dict]):
        """skill_names: set of all registered skill names.
           skill_schemas: skill_name → {"params": {param_name: schema_dict}}
        """
        self._skill_names = skill_names
        self._schemas = skill_schemas

    # ── Layer 0: Safety review ──────────────────────────────────────────

    async def review_safety(self, plan_json: dict, user_message: str) -> SafetyResult:
        """Call LLM to classify the plan's safety.

        Returns safe / warn / block.
        In Phase 1 this is a stub that always returns safe.
        """
        # TODO: Phase 2 — implement real LLM-based safety review
        return SafetyResult(verdict="safe", reason="phase1-stub")

    # ── Layer 1: Format check ───────────────────────────────────────────

    @staticmethod
    def _extract_json(text: str) -> str | None:
        """Try to extract JSON from text that may contain extra content."""
        text = text.strip()
        # Direct parse first
        brace_start = text.find("{")
        brace_end = text.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            candidate = text[brace_start:brace_end + 1]
            try:
                json.loads(candidate)
                return candidate
            except json.JSONDecodeError:
                pass
        return None

    def check_format(self, raw: str) -> ValidationResult:
        """Validate JSON structure and required fields."""
        extracted = self._extract_json(raw)
        if extracted is None:
            return ValidationResult.failed(1, f"JSON 格式错误: 无法从输出中提取合法 JSON")

        try:
            data = json.loads(extracted)
        except json.JSONDecodeError as e:
            return ValidationResult.failed(1, f"JSON 格式错误: {e}")

        if not isinstance(data, dict):
            return ValidationResult.failed(1, "顶层必须是 JSON 对象")

        steps = data.get("steps")
        if not isinstance(steps, list) or len(steps) == 0:
            return ValidationResult.failed(1, "steps 必须是非空数组")

        for i, step in enumerate(steps):
            if not isinstance(step, dict):
                return ValidationResult.failed(1, f"steps[{i}] 必须是对象")
            if "skill" not in step:
                return ValidationResult.failed(1, f"steps[{i}] 缺少 skill 字段")

        # Check last step is reply (D-DSL-06)
        if steps[-1].get("skill") != "reply":
            return ValidationResult.failed(1, "plan 最后一步必须是 reply")

        try:
            plan = plan_from_json(data)
        except (KeyError, TypeError) as e:
            return ValidationResult.failed(1, f"plan 解析失败: {e}")

        return ValidationResult.passed(plan)

    # ── Layer 2: Reference check ────────────────────────────────────────

    def check_references(self, plan: Plan) -> ValidationResult:
        """Validate all {{step.<id>.output}} references.

        Accepts both explicit step ids AND skill names as reference targets.
        A step without an explicit id will use its skill name as its implicit id.
        """
        # Build set of valid reference targets: explicit ids + skill names for steps without ids
        valid_refs: set[str] = set()
        step_id_by_index: dict[int, str | None] = {}
        for i, s in enumerate(plan.steps):
            step_id_by_index[i] = s.id
            if s.id:
                valid_refs.add(s.id)
            else:
                # Skill name serves as implicit step id (matches Engine behavior)
                valid_refs.add(s.skill)

        for i, step in enumerate(plan.steps):
            for key, value in step.args.items():
                if not isinstance(value, str):
                    continue
                for ref_id in REF_PATTERN.findall(value):
                    # Check existence (supports both explicit ids and skill names)
                    if ref_id not in valid_refs:
                        msg = f"steps[{i}].args.{key} 引用了不存在的 step id: {ref_id}"
                        return ValidationResult.failed(2, msg)
                    # Check ordering: referenced step must come before current
                    ref_idx = self._find_step_index(plan.steps, ref_id)
                    if ref_idx is not None and ref_idx >= i:
                        msg = f"steps[{i}] 引用了尚未执行的 step: {ref_id}"
                        return ValidationResult.failed(2, msg)

        return ValidationResult.passed(plan)

    @staticmethod
    def _find_step_index(steps: list[SkillCall], ref_id: str) -> int | None:
        """Find the index of a step by its explicit id or skill name."""
        for i, s in enumerate(steps):
            if s.id == ref_id or (s.id is None and s.skill == ref_id):
                return i
        return None

    # ── Layer 3: Skill check ────────────────────────────────────────────

    def check_skills(self, plan: Plan) -> ValidationResult:
        """Validate skill existence and parameter schemas."""
        for i, step in enumerate(plan.steps):
            # Existence
            if step.skill not in self._skill_names:
                msg = f"steps[{i}]: skill '{step.skill}' 不存在"
                return ValidationResult.failed(3, msg)

            # Parameter types
            schema = self._schemas.get(step.skill, {})
            params_schema = schema.get("params", {})

            for param_name, param_rules in params_schema.items():
                if param_rules.get("required", False) and param_name not in step.args:
                    msg = f"steps[{i}].{step.skill}: 缺少必填参数 '{param_name}'"
                    return ValidationResult.failed(3, msg)

                if param_name in step.args:
                    value = step.args[param_name]
                    expected_type = param_rules.get("type", "string")

                    # Skip type check for {{...}} references (resolved at runtime)
                    if isinstance(value, str) and "{{" in value:
                        continue

                    if expected_type == "int":
                        # Accept int, float-like-int, and numeric strings
                        if isinstance(value, str) and value.strip().isdigit():
                            step.args[param_name] = int(value)
                        elif isinstance(value, float) and value == int(value):
                            step.args[param_name] = int(value)
                        elif not isinstance(value, int):
                            msg = f"steps[{i}].{step.skill}: 参数 '{param_name}' 应为数字"
                            return ValidationResult.failed(3, msg)

                    # Enum check
                    enum_vals = param_rules.get("enum")
                    if enum_vals and value not in enum_vals:
                        msg = f"steps[{i}].{step.skill}: 参数 '{param_name}' 值 '{value}' 不在允许范围内: {enum_vals}"
                        return ValidationResult.failed(3, msg)

        return ValidationResult.passed(plan)

    # ── Full validation pipeline ────────────────────────────────────────

    async def validate(self, raw: str, user_message: str) -> ValidationResult:
        """Run all four validation layers in order.

        Returns the first failure, or ValidationResult.passed on success.
        """
        # Layer 0: parse JSON first (needed for safety review)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # Can't even parse — format check will catch it
            data = {}

        # Layer 0: Safety
        safety = await self.review_safety(data, user_message)
        if safety.verdict == "block":
            return ValidationResult.failed(0, f"安全审查未通过: {safety.reason}")
        logger.info("Safety review: %s — %s", safety.verdict, safety.reason)

        # Layer 1: Format
        result = self.check_format(raw)
        if not result.ok:
            return result

        plan = result.plan

        # Layer 2: References
        result = self.check_references(plan)
        if not result.ok:
            return result

        # Layer 3: Skills
        result = self.check_skills(plan)
        if not result.ok:
            return result

        return ValidationResult.passed(plan)
