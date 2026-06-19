"""Configuration management — loads from .env or environment variables."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
_env_file = Path(__file__).resolve().parent.parent / ".env"
if _env_file.exists():
    load_dotenv(_env_file)


def _str(key: str, default: str | None = None) -> str | None:
    return os.environ.get(key, default)


def _float(key: str, default: float | None = None) -> float | None:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# --- Qwen (visual understanding) ---
QWEN_API_KEY: str | None = _str("QWEN_API_KEY")
QWEN_API_URL: str = _str("QWEN_API_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions") or "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
QWEN_VL_MODEL: str = _str("QWEN_VL_MODEL", "qwen3.7-plus") or "qwen3.7-plus"

# --- Luckin MCP ---
LUCKIN_MCP_TOKEN: str | None = _str("LUCKIN_MCP_TOKEN")
LUCKIN_MCP_URL: str = _str("LUCKIN_MCP_URL", "https://gwmcp.lkcoffee.com/order/user/mcp") or "https://gwmcp.lkcoffee.com/order/user/mcp"

# --- AMap (高德) IP定位 ---
AMAP_API_KEY: str | None = _str("AMAP_API_KEY")

# --- Luckin default location (overrides IP geolocation if set) ---
LUCKIN_LAT: float | None = _float("LUCKIN_LAT")
LUCKIN_LNG: float | None = _float("LUCKIN_LNG")

# --- DeepSeek (fallback) ---
DEEPSEEK_API_KEY: str | None = _str("DEEPSEEK_API_KEY")
DEEPSEEK_API_URL: str = _str("DEEPSEEK_API_URL", "https://api.deepseek.com/v1/chat/completions") or "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL: str = _str("DEEPSEEK_MODEL", "deepseek-v4-flash") or "deepseek-v4-flash"

# --- Feishu ---
FEISHU_APP_ID: str | None = _str("FEISHU_APP_ID")
FEISHU_APP_SECRET: str | None = _str("FEISHU_APP_SECRET")

# --- Server ---
HOST: str = _str("HOST", "0.0.0.0") or "0.0.0.0"
PORT: int = _int("PORT", 8000)

# --- Logging ---
LOG_LEVEL: str = _str("LOG_LEVEL", "INFO") or "INFO"

# --- Paths ---
PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
LOG_DIR: Path = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
