"""Project Orca — Phase 1 entry point.

FastAPI application that:
- Hosts the Feishu event subscription webhook
- Routes messages through the Orchestrator
- Spawns uvicorn on the configured host:port

Usage:
    python -m src.main
    # or
    uvicorn src.main:app --host 0.0.0.0 --port 8000
"""

import logging

import uvicorn
from fastapi import FastAPI

from src.config import FEISHU_APP_ID, FEISHU_APP_SECRET, HOST, LOG_LEVEL, PORT
from src.core.orchestrator import Orchestrator
from src.feishu.client import FeishuClient
from src.router.feishu import init_routes, router as feishu_router

# --- Logging ---
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)

logger = logging.getLogger(__name__)

# --- App ---
app = FastAPI(title="Project Orca", version="2.1.1", description="Phase 2 — Plan-then-Execute Architecture")

app.include_router(feishu_router)


@app.on_event("startup")
async def startup():
    """Initialize shared services on app startup."""
    if not FEISHU_APP_ID or not FEISHU_APP_SECRET:
        logger.error("FEISHU_APP_ID or FEISHU_APP_SECRET not configured")
        return

    feishu = FeishuClient(app_id=FEISHU_APP_ID, app_secret=FEISHU_APP_SECRET)
    orchestrator = Orchestrator(feishu=feishu)
    init_routes(orchestrator)
    logger.info("Orca started — listening on %s:%s", HOST, PORT)


@app.on_event("shutdown")
async def shutdown():
    logger.info("Orca shutting down")


# --- CLI entry ---

if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host=HOST,
        port=PORT,
        reload=True,
        log_level=LOG_LEVEL.lower(),
    )
