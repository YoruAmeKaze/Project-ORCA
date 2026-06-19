"""Runtime Engine — deterministic sequential executor for DSL plans.

Executes steps one by one, resolves references, dispatches to SkillRegistry handlers.
No reasoning, no branching. Pure execution.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from src.dsl.schema import Plan, REF_PATTERN, SkillCall
from src.runtime.context import RuntimeContext
from src.skill.registry import SkillRegistry

logger = logging.getLogger(__name__)


@dataclass
class StepResult:
    """Result of executing a single step."""
    step_id: str
    skill: str
    ok: bool
    output: str = ""
    error: str = ""


@dataclass
class ExecutionResult:
    """Result of executing a complete plan."""
    ok: bool
    results: list[StepResult] = field(default_factory=list)
    final_message: str = ""  # The reply content to send to the user


# ── Dependencies container ──────────────────────────────────────────────────


@dataclass
class SkillDeps:
    """External dependencies injected into skill handlers.

    Skills receive this object and can access:
    - feishu: For sending messages (used by reply handler)
    - session_id: Current user/session identifier
    - Any future dependencies (db, http client, etc.)

    session_state: Cross-turn session context for multi-turn workflows.
                   Persists across Plan executions within the same session.
                   Examples: {"selected_dept_id": 610287, "store_list": [...]}
    """
    feishu: Any = None      # FeishuClient
    session_id: str = ""    # Current user's open_id
    luckin_mcp: Any = None  # LuckinMCPClient (injected by Orchestrator)
    session_state: dict = field(default_factory=dict)  # Cross-turn state


# ── Engine ──────────────────────────────────────────────────────────────────


class Engine:
    """Deterministic DSL executor.

    Usage:
        engine = Engine(registry, deps)
        result = await engine.execute(plan, session_id)
    """

    def __init__(self, registry: SkillRegistry, deps: SkillDeps):
        self._registry = registry
        self._deps = deps

    # ── Public API ──────────────────────────────────────────────────────

    async def execute(self, plan: Plan, session_id: str) -> ExecutionResult:
        """Execute a plan step by step.

        Args:
            plan: The validated execution plan.
            session_id: User/session identifier.

        Returns:
            ExecutionResult with step-level outcomes.
        """
        ctx = RuntimeContext(session_id=session_id, plan=plan)
        results: list[StepResult] = []

        for i, step in enumerate(plan.steps):
            step_id = step.id or step.skill
            # Deduplicate: if same skill appears twice, append _N
            if step_id in ctx.outputs:
                step_id = f"{step.skill}_{i}"
            logger.info("Executing step %s: %s", step_id, step.skill)

            try:
                # Step 1: Resolve references in args (with int param coercion)
                skill_meta = self._registry.require(step.skill)
                int_params = {p for p, s in skill_meta.params.items() if s.get("type") == "int"}
                resolved_args = self._resolve_refs(step.args, ctx, int_params)

                # Step 2: Look up skill handler
                if skill_meta.handler is None:
                    raise RuntimeError(f"Skill '{step.skill}' has no handler")

                # Step 3: Emit narration or fallback progress message
                msg = step.narration or skill_meta.progress_message
                if msg and self._deps.feishu:
                    await self._deps.feishu.send_text(session_id, msg)

                # Step 4: Execute handler
                output = await skill_meta.handler(resolved_args, self._deps)

                # Step 5: Store output
                ctx.outputs[step_id] = output

                results.append(StepResult(
                    step_id=step_id,
                    skill=step.skill,
                    ok=True,
                    output=output,
                ))

                # Step 6: If this was reply, we're done
                if step.skill == "reply":
                    return ExecutionResult(ok=True, results=results, final_message=output)

            except Exception as e:
                logger.error("Step %s failed: %s", step_id, e)
                error_msg = f"步骤 '{step_id}' ({step.skill}) 执行失败: {e}"
                results.append(StepResult(
                    step_id=step_id,
                    skill=step.skill,
                    ok=False,
                    error=error_msg,
                ))

                # Fail-fast: auto-reply with error
                if self._deps.feishu:
                    await self._deps.feishu.send_text(session_id, error_msg)

                return ExecutionResult(ok=False, results=results)

        # Should never reach here if last step is reply (validated)
        logger.warning("Plan executed without reply step — possible validation gap")
        return ExecutionResult(ok=False, results=results, final_message="plan 缺少 reply 步骤")

    # ── Reference resolution ────────────────────────────────────────────

    def _resolve_refs(self, args: dict, ctx: RuntimeContext, int_params: set[str] | None = None) -> dict:
        """Replace {{step.<id>.output}} with actual values from ctx.outputs.

        For int_params, tries to extract a numeric value from the resolved text
        (e.g. "店名 [dept_id: 12345]" → 12345).
        """
        resolved = {}
        for key, value in args.items():
            if isinstance(value, str):
                resolved[key] = REF_PATTERN.sub(
                    lambda m: self._resolve_one(m, ctx), value
                )
            else:
                resolved[key] = value

            # Post-process: extract number from text for int params
            if int_params and key in int_params and isinstance(resolved[key], str):
                text = resolved[key]
                # First try: pure number
                if text.strip().isdigit():
                    resolved[key] = int(text)
                else:
                    # Try: dept_id: 12345 or ID: 12345 or [数字]
                    m = re.search(r'(?:dept_id|ID|id)[：:]\s*(\d+)', text)
                    if m:
                        resolved[key] = int(m.group(1))
                    else:
                        # Try: any number in the text
                        nums = re.findall(r'\d+', text)
                        if nums:
                            resolved[key] = int(nums[0])
        return resolved

    def _resolve_one(self, match: re.Match, ctx: RuntimeContext) -> str:
        """Resolve a single {{step.<id>.output}} reference."""
        ref_id = match.group(1)
        if ref_id not in ctx.outputs:
            raise RuntimeError(
                f"引用解析失败: step '{ref_id}' 尚未执行或无输出"
            )
        output = ctx.outputs[ref_id]
        if not isinstance(output, str):
            output = str(output)
        return output
