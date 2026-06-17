"""Runtime Engine — deterministic sequential executor for DSL plans.

Executes steps one by one, resolves references, dispatches to SkillRegistry handlers.
No reasoning, no branching. Pure execution.
"""

from __future__ import annotations

import logging
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
    """
    feishu: Any = None      # FeishuClient
    session_id: str = ""    # Current user's open_id


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
            step_id = step.id or f"_step_{i}"
            logger.info("Executing step %s: %s", step_id, step.skill)

            try:
                # Step 1: Resolve references in args
                resolved_args = self._resolve_refs(step.args, ctx)

                # Step 2: Look up skill handler
                skill_meta = self._registry.require(step.skill)
                if skill_meta.handler is None:
                    raise RuntimeError(f"Skill '{step.skill}' has no handler")

                # Step 3: Emit progress message if configured
                if skill_meta.progress_message and self._deps.feishu:
                    await self._deps.feishu.send_text(
                        session_id, skill_meta.progress_message
                    )

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

    def _resolve_refs(self, args: dict, ctx: RuntimeContext) -> dict:
        """Replace {{step.<id>.output}} with actual values from ctx.outputs."""
        resolved = {}
        for key, value in args.items():
            if isinstance(value, str):
                resolved[key] = REF_PATTERN.sub(
                    lambda m: self._resolve_one(m, ctx), value
                )
            else:
                resolved[key] = value
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
