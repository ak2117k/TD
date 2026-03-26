# System Architecture

## Overview

TD Automation follows a **Monolith + Bull Queue Workers + Python AI Sidecar** architecture.

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Vite)                  │
│                        Port 3000                             │
├─────────────────────────────────────────────────────────────┤
│                     BACKEND (NestJS)                         │
│                        Port 3001                             │
│                                                              │
│  Modules: market-data | trade-engine | signal-generator      │
│           auto-trade | portfolio | news | ai-advisor         │
│           settings | alerts | backtest | options-chain       │
│                                                              │
│  Bull Queue Workers:                                         │
│    live-feed | signal-scan | auto-trade | oi-tracker         │
│    news-fetch                                                │
├─────────────────────────────────────────────────────────────┤
│                   AI ENGINE (Python + FastAPI)                │
│                        Port 5000                             │
│                                                              │
│  Services: signal-scorer | trade-analyzer | advisor-bot      │
│            sentiment-analyzer | self-learning-engine          │
├─────────────────────────────────────────────────────────────┤
│  PostgreSQL + TimescaleDB     │     Redis (Cache + Queues)   │
│       Port 5432               │         Port 6379            │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Live Market Data
```
Angel One WebSocket
    → Live Feed Worker (Bull Queue)
        → Redis Pub/Sub (real-time distribution)
            → Frontend (via Socket.IO)
            → Signal Scan Worker
            → OI Tracker Worker
        → PostgreSQL/TimescaleDB (candle storage)
```

### Signal Generation
```
Signal Scan Worker
    → Runs active TradingStrategy implementations against live data
    → AI Engine scores the signal (confidence 0-100)
    → Signal stored in DB
    → Published to Frontend via WebSocket
    → If auto-trade enabled → Auto-Trade Worker evaluates
```

### Auto Trade Execution
```
Auto-Trade Worker
    → Picks highest confidence signal meeting criteria
    → Validates against risk limits (max loss, max positions, etc.)
    → If FULLY_AUTOMATIC → executes via BrokerAdapter
    → If APPROVAL_REQUIRED → sends to frontend for user approval
    → If PAPER_TRADING → simulates execution
    → Logs decision to DB for AI self-learning
```

## Plugin Points

| Interface | Purpose | How to extend |
|-----------|---------|---------------|
| `BrokerAdapter` | Broker integration | New class implementing the interface |
| `TradingStrategy` | Trading algorithms | New class implementing the interface |
| News sources | Data feeds | Add new RSS/API source in news module config |

## Scaling Path (Local → Cloud)

1. **Local**: All services on one machine, SQLite → PostgreSQL
2. **Single VPS**: Same architecture, just on a cloud server
3. **Split services**: Extract Bull workers into separate processes
4. **Full microservices**: Each module becomes its own service (if ever needed)
