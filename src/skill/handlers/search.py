"""Skill: search_web — search the web for real-time information."""

from src.core.search import search as web_search


async def handle(args: dict, deps) -> str:
    """Search the web.

    Args:
        query: Search query string.

    Output: formatted search result summary (string).
    """
    query = args["query"]
    result = await web_search(query)
    return result or "没有找到相关信息"
