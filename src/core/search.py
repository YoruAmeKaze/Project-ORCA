"""Web search module — fetches real-time information from the web."""

import logging
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

# Try multiple search backends in order
_SEARCH_BACKENDS = []


async def _search_bing(query: str, max_results: int = 5) -> list[dict]:
    """Search via Bing China (cn.bing.com)."""
    results = []
    url = f"https://cn.bing.com/search?q={quote(query)}&count={max_results}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")
            for item in soup.select(".b_algo")[:max_results]:
                h2 = item.select_one("h2 a")
                p = item.select_one(".b_caption p")
                link = item.select_one("h2 a")
                if h2:
                    results.append({
                        "title": h2.get_text(strip=True),
                        "body": p.get_text(strip=True)[:300] if p else "",
                        "url": link.get("href", "") if link else "",
                    })
    except Exception as e:
        logger.warning("Bing search failed: %s", e)
    return results


async def search(query: str, max_results: int = 5) -> str:
    """Search the web and return a formatted summary.

    Returns a plain-text summary of search results, or empty string if unavailable.
    """
    results = await _search_bing(query, max_results)

    if not results:
        return ""

    lines = [f"搜索结果（{query}）："]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}")
        if r["body"]:
            lines.append(f"   {r['body'][:200]}")
    return "\n".join(lines)
