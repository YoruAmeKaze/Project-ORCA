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


def _int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# --- Ollama ---
OLLAMA_HOST: str = _str("OLLAMA_HOST", "http://localhost:11434") or "http://localhost:11434"
OLLAMA_VL_MODEL: str = _str("OLLAMA_VL_MODEL", "qwen2.5vl:7b") or "qwen2.5vl:7b"

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
