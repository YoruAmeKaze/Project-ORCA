"""Short-term conversation context manager.

Maintains the current dialogue history for context-aware responses.
In Phase 1, this is an in-memory buffer per conversation.
"""

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)


@dataclass
class Turn:
    role: Literal["user", "assistant"]
    content: str
    action: str | None = None  # The action executed (if any)


@dataclass
class Conversation:
    """A single dialogue session identified by the WeChat sender."""

    sender: str
    turns: list[Turn] = field(default_factory=list)
    max_turns: int = 10
    active_task: dict | None = None  # Cross-plan state: {task_type, stage, context}

    def add_turn(self, role: Literal["user", "assistant"], content: str, action: str | None = None):
        self.turns.append(Turn(role=role, content=content, action=action))
        if len(self.turns) > self.max_turns:
            self.turns.pop(0)

    def recent_context(self, n: int = 5) -> str:
        """Return the last N turns as a formatted text for the LLM."""
        lines = []
        for t in self.turns[-n:]:
            prefix = "用户" if t.role == "user" else "Orca"
            lines.append(f"{prefix}: {t.content}")
        return "\n".join(lines)

    def last_action(self) -> str | None:
        """Return the action from the last assistant turn, if any."""
        for t in reversed(self.turns):
            if t.role == "assistant" and t.action:
                return t.action
        return None


class HistoryManager:
    """Manages multiple conversations, keyed by sender ID."""

    def __init__(self):
        self._conversations: dict[str, Conversation] = {}

    def get_or_create(self, sender: str) -> Conversation:
        if sender not in self._conversations:
            self._conversations[sender] = Conversation(sender=sender)
        return self._conversations[sender]

    def add_turn(
        self,
        sender: str,
        role: Literal["user", "assistant"],
        content: str,
        action: str | None = None,
    ):
        conv = self.get_or_create(sender)
        conv.add_turn(role, content, action)
        logger.debug("History [%s]: added %s turn", sender, role)

    def clear(self, sender: str):
        if sender in self._conversations:
            del self._conversations[sender]
            logger.info("History cleared for %s", sender)
