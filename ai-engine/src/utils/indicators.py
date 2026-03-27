"""
Technical indicator calculations for the TD Automation AI Engine.
Uses numpy/pandas for efficient computation.
"""

import numpy as np
import pandas as pd
from typing import List, Dict, Optional


def calculate_rsi(closes: List[float], period: int = 14) -> List[float]:
    """Calculate Relative Strength Index.

    Args:
        closes: List of closing prices.
        period: RSI lookback period (default 14).

    Returns:
        List of RSI values. First `period` values will be NaN.
    """
    if len(closes) < period + 1:
        return [float("nan")] * len(closes)

    prices = np.array(closes, dtype=float)
    deltas = np.diff(prices)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    rsi_values = [float("nan")] * period
    if avg_loss == 0:
        rsi_values.append(100.0)
    else:
        rs = avg_gain / avg_loss
        rsi_values.append(100.0 - 100.0 / (1.0 + rs))

    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            rsi_values.append(100.0)
        else:
            rs = avg_gain / avg_loss
            rsi_values.append(100.0 - 100.0 / (1.0 + rs))

    return rsi_values


def calculate_ema(values: List[float], period: int) -> List[float]:
    """Calculate Exponential Moving Average.

    Args:
        values: List of price values.
        period: EMA period.

    Returns:
        List of EMA values. First `period - 1` values will be NaN.
    """
    if len(values) < period:
        return [float("nan")] * len(values)

    series = pd.Series(values, dtype=float)
    ema = series.ewm(span=period, adjust=False).mean()
    result = ema.tolist()
    # Mark initial values as NaN for consistency
    for i in range(period - 1):
        result[i] = float("nan")
    return result


def calculate_sma(values: List[float], period: int) -> List[float]:
    """Calculate Simple Moving Average.

    Args:
        values: List of price values.
        period: SMA period.

    Returns:
        List of SMA values. First `period - 1` values will be NaN.
    """
    if len(values) < period:
        return [float("nan")] * len(values)

    series = pd.Series(values, dtype=float)
    sma = series.rolling(window=period).mean()
    return sma.tolist()


def calculate_atr(candles: List[dict], period: int = 14) -> List[float]:
    """Calculate Average True Range.

    Args:
        candles: List of candle dicts with 'high', 'low', 'close' keys.
        period: ATR lookback period (default 14).

    Returns:
        List of ATR values. First `period` values will be NaN.
    """
    if len(candles) < 2:
        return [float("nan")] * len(candles)

    highs = np.array([c["high"] for c in candles], dtype=float)
    lows = np.array([c["low"] for c in candles], dtype=float)
    closes = np.array([c["close"] for c in candles], dtype=float)

    true_ranges = [float("nan")]  # First candle has no previous close
    for i in range(1, len(candles)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        true_ranges.append(tr)

    atr_values: List[float] = [float("nan")] * period
    if len(candles) > period:
        # Initial ATR is SMA of true ranges
        valid_trs = [tr for tr in true_ranges[1 : period + 1] if not np.isnan(tr)]
        if valid_trs:
            current_atr = np.mean(valid_trs)
            atr_values.append(float(current_atr))

            for i in range(period + 1, len(candles)):
                current_atr = (current_atr * (period - 1) + true_ranges[i]) / period
                atr_values.append(float(current_atr))

    # Pad if needed
    while len(atr_values) < len(candles):
        atr_values.append(float("nan"))

    return atr_values


def calculate_vwap(candles: List[dict]) -> float:
    """Calculate Volume Weighted Average Price for the given candles.

    Args:
        candles: List of candle dicts with 'high', 'low', 'close', 'volume' keys.

    Returns:
        VWAP value as a float. Returns NaN if no volume data.
    """
    if not candles:
        return float("nan")

    total_volume = 0.0
    cumulative_tp_volume = 0.0

    for c in candles:
        typical_price = (c["high"] + c["low"] + c["close"]) / 3.0
        volume = c.get("volume", 0)
        cumulative_tp_volume += typical_price * volume
        total_volume += volume

    if total_volume == 0:
        return float("nan")

    return cumulative_tp_volume / total_volume


def calculate_bollinger_bands(
    closes: List[float], period: int = 20, std_dev: float = 2.0
) -> Dict[str, List[float]]:
    """Calculate Bollinger Bands.

    Args:
        closes: List of closing prices.
        period: SMA period for the middle band (default 20).
        std_dev: Number of standard deviations for upper/lower bands (default 2.0).

    Returns:
        Dict with 'upper', 'middle', 'lower' lists of float values.
    """
    middle = calculate_sma(closes, period)
    series = pd.Series(closes, dtype=float)
    rolling_std = series.rolling(window=period).std().tolist()

    upper = []
    lower = []
    for i in range(len(closes)):
        if np.isnan(middle[i]) or np.isnan(rolling_std[i]):
            upper.append(float("nan"))
            lower.append(float("nan"))
        else:
            upper.append(middle[i] + std_dev * rolling_std[i])
            lower.append(middle[i] - std_dev * rolling_std[i])

    return {"upper": upper, "middle": middle, "lower": lower}
