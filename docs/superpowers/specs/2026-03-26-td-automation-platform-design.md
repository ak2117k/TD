# TD Automation — Automated Trading Platform Design

> Date: 2026-03-26
> Author: Aryan Kumar + Claude
> Status: Approved

---

## 1. Vision

A self-contained automated trading platform for the Indian market that consolidates live market data, trade execution, AI-powered signal generation, self-learning analytics, and portfolio management into a single deployable application. Designed for local-first development with cloud migration path.

## 2. Core Requirements

### 2.1 Market Data
- Live streaming prices for all NSE/BSE stocks, indices (Nifty, BankNifty, FinNifty, Sensex), and MCX commodities
- Live Open Interest (OI) data with change tracking
- Historical candle data (1min, 5min, 15min, 1hr, daily)
- Options chain with Greeks (Delta, Gamma, Theta, Vega, IV)
- Market breadth: advance/decline, sector heatmap, FII/DII data

### 2.2 Live Charts
- Candlestick charts via TradingView Lightweight Charts (open source)
- OI overlay on charts
- Multi-timeframe view (5min, 15min, 1hr, daily)
- Technical indicators (RSI, VWAP, EMA, Bollinger, custom)
- Drawing tools and annotations

### 2.3 Signal Generator
- Algorithmic scanning against live data
- Pluggable strategy system (Gamma Blast, RSI-based, VWAP, custom)
- Each signal includes: instrument, direction, entry, target, stoploss, expected profit, risk/reward, confidence score
- Multi-timeframe confirmation before signal emission
- Ranked by AI confidence score

### 2.4 Auto-Trade Engine
- Executes highest-ranked signals that meet configured criteria
- Risk limits enforced as hard constraints (max daily loss, max position size, max concurrent trades)
- Configurable modes: fully automatic, approval-required, paper trading
- Kill switch — instant square-off of all positions
- Every decision logged for audit and self-learning

### 2.5 Portfolio & Dashboard
- Real-time P&L: daily, weekly, monthly, all-time
- Win rate, avg profit/loss, Sharpe ratio, max drawdown
- Equity curve visualization
- Segment-wise breakdown (options, equity, commodity, swing)
- Trade journal with full history, filters, export

### 2.6 News Aggregator
- RSS feeds from: Economic Times, MoneyControl, Reuters, LiveMint
- Categorized: Indian market, Global, Sector, Company-specific
- AI sentiment analysis (bullish/bearish/neutral)
- Alerts when news impacts open positions or watchlist

### 2.7 AI Advisor Bot
- Observes all trades (manual + automated)
- Pattern analysis: what works, what doesn't, time-of-day, segment performance
- Weekly performance reports with actionable suggestions
- Interactive: "Should I take this trade?", "Why did I lose this week?"
- Self-learning: improves recommendations from trade outcome feedback

### 2.8 Settings
- Algorithm selection and parameter tuning
- Risk/reward ratio, max loss/day, max loss/trade
- Auto-trade toggle, approval mode toggle
- Paper trading mode toggle
- Broker API credentials management
- Notification preferences

### 2.9 Backtesting Engine
- Run any strategy against historical data
- Performance metrics: total return, win rate, max drawdown, Sharpe
- Compare strategies side-by-side
- Visual equity curve for backtest results

### 2.10 Alerts System
- Price alerts (above/below threshold)
- OI spike alerts
- News alerts for watchlist stocks
- P&L threshold alerts (daily loss limit approaching)
- Desktop notifications (push notifications when mobile comes)

## 3. Architecture

### 3.1 Approach
Monolith-first with Bull queue workers for background jobs. Python ML sidecar for AI engine. Designed for easy extraction into microservices when scaling to cloud.

### 3.2 Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React + Vite + TypeScript | 3000 |
| Backend | NestJS + TypeScript | 3001 |
| AI Engine | Python + FastAPI | 5000 |
| Database | PostgreSQL + TimescaleDB | 5432 |
| Cache/Queue | Redis + Bull | 6379 |
| Charts | TradingView Lightweight Charts | - |
| Broker | Angel One SmartAPI | - |

### 3.3 Module Architecture
Each NestJS module is self-contained with:
- Controller (REST endpoints)
- Gateway (WebSocket events where needed)
- Service (business logic)
- Repository (data access)
- DTOs (validation)
- Strategy interfaces (pluggable algorithms)

### 3.4 Background Workers (Bull Queues)
- `live-feed` — streams market data from Angel One WebSocket
- `signal-scan` — runs strategy algorithms against live data
- `auto-trade` — evaluates and executes top signals
- `oi-tracker` — tracks OI changes and detects spikes
- `news-fetch` — periodic news aggregation and sentiment analysis

### 3.5 Data Flow

```
Angel One WebSocket → Live Feed Worker → Redis (pub/sub) → Frontend (WebSocket)
                                       → TimescaleDB (candle storage)
                                       → Signal Scan Worker → Signal Generator
                                                            → Auto-Trade Worker → Order Execution
                                                            → AI Engine (scoring)
```

## 4. Frontend Pages

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/` | P&L overview, equity curve, today's trades, active positions |
| Live Charts | `/charts` | Candlestick charts with OI, indicators, multi-timeframe |
| Market Overview | `/market` | All indices, stocks, commodities watchlist grid |
| Options Chain | `/options` | Live options chain with Greeks, IV, OI |
| Signals | `/signals` | Trade opportunities ranked by confidence |
| Auto-Trade | `/auto-trade` | Status, execution log, toggle, approval queue |
| News | `/news` | Aggregated feed with sentiment tags |
| Trade Journal | `/journal` | Historical trades with filters and export |
| AI Advisor | `/advisor` | Chat interface, weekly insights, suggestions |
| Backtesting | `/backtest` | Run strategies against historical data |
| Settings | `/settings` | All configuration options |

## 5. Cost Structure

### Initial (₹0/month)
- All services run locally
- PostgreSQL, Redis, Python — all free
- Angel One SmartAPI — free
- TradingView Lightweight Charts — open source
- News via RSS feeds — free

### Cloud Migration (estimated)
- VPS: ₹500-800/mo (DigitalOcean/AWS Lightsail)
- Managed PostgreSQL: ₹500/mo
- Redis Cloud: Free tier or ₹300/mo
- Total: ~₹1000-1600/mo

## 6. Design Principles

1. **Plugin Architecture** — every algorithm, data source, and broker is a pluggable adapter
2. **Configuration over Code** — behavior controlled via settings, not hardcoded
3. **Safety First** — hard risk limits that auto-trade cannot override, kill switch always accessible
4. **Paper Trading Default** — new strategies always start in paper mode
5. **Audit Everything** — every trade decision, every signal, every AI recommendation is logged
6. **Mobile-Ready** — responsive design, API-first so mobile app can be built later
7. **Agile Delivery** — stage-by-stage implementation, each stage is a usable increment

## 7. Stage Plan (High Level)

| Stage | Focus | Outcome |
|-------|-------|---------|
| 1 | Project scaffold + Angel One integration + live data | See live prices flowing |
| 2 | Live charts + market overview + watchlist | Visual market monitoring |
| 3 | Signal generator + first algorithm | Trade recommendations appearing |
| 4 | Trade engine + paper trading | Simulated trade execution |
| 5 | Dashboard + trade journal | Performance tracking |
| 6 | Auto-trade engine + risk manager | Automated execution with safety |
| 7 | News aggregator + alerts | Information and notifications |
| 8 | AI advisor + self-learning | Intelligent trade coaching |
| 9 | Backtesting engine | Strategy validation |
| 10 | Options chain + advanced features | Full platform |

## 8. Non-Functional Requirements

- **Latency**: Market data to UI < 500ms
- **Reliability**: Auto-trade worker must recover from crashes without losing state
- **Data Retention**: All candle data retained indefinitely, trade logs retained indefinitely
- **Security**: Broker credentials encrypted at rest, no credentials in logs
- **Extensibility**: New broker = new adapter, new algorithm = new strategy class
