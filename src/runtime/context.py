"""RuntimeContext — pure data container for session state during execution.

External dependencies (FeishuClient, etc.) are NOT stored here.
They are injected into the Engine at construction time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.dsl.schema import Plan


@dataclass
class RuntimeContext:
    """Mutable state maintained during plan execution.

    Attributes:
        session_id: The user/session identifier (e.g. Feishu open_id).
        outputs: Step outputs keyed by step id or auto-generated _step_N.
                 Runtime writes here after each step; Engine reads for ref resolution.
        plan: The Plan currently being executed.
    """

    session_id: str
    outputs: dict[str, Any] = field(default_factory=dict)
    plan: Plan | None = None
