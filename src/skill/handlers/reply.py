"""Skill: reply — send final response to the user."""


async def handle(args: dict, deps) -> str:
    """Send the final message to the user.

    Output: null (terminal action).
    """
    message = args.get("message", "")
    await deps.feishu.send_text(deps.session_id, message)
    return ""  # null — terminal action
