"""
API route modules for the TD Automation AI Engine.
"""

from .scoring import router as scoring_router
from .sentiment import router as sentiment_router
from .analysis import router as analysis_router

__all__ = ["scoring_router", "sentiment_router", "analysis_router"]
