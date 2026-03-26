"""
TD Automation - AI Engine
Self-learning trade analysis, signal scoring, and advisory bot.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "ai-engine"}


# Route modules will be added as we build each stage
# - /api/score-signal    → Score a trade signal (confidence 0-100)
# - /api/analyze-trade   → Post-trade analysis (what went right/wrong)
# - /api/weekly-report   → Generate weekly performance report
# - /api/ask-advisor     → Chat with AI advisor
# - /api/sentiment       → News sentiment analysis
# - /api/backtest        → Run strategy backtest
