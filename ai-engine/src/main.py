"""
TD Automation - AI Engine
Self-learning trade analysis, signal scoring, and advisory bot.
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes.scoring import router as scoring_router
from .routes.sentiment import router as sentiment_router
from .routes.analysis import router as analysis_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

app = FastAPI(
    title="TD Automation AI Engine",
    description="AI-powered trade analysis, scoring, and self-learning engine",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API route modules
app.include_router(scoring_router, prefix="/api", tags=["scoring"])
app.include_router(sentiment_router, prefix="/api", tags=["sentiment"])
app.include_router(analysis_router, prefix="/api", tags=["analysis"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "ai-engine"}


# Remaining route modules (to be added in future stages):
# - /api/weekly-report   → Generate weekly performance report
# - /api/ask-advisor     → Chat with AI advisor
# - /api/backtest        → Run strategy backtest
