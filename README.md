# 🤖 Autonomous Market AI System

AI otonom untuk analisa pasar crypto, forex, saham & komoditas — non-stop, paralel, dengan simulasi trading realtime.

## ✨ Features

- **20 pair sekaligus**: 15 crypto (BTC, ETH, BNB, SOL, XRP, DOGE, ADA...) + 5 forex (EUR/USD, GBP/USD...)
- **Analisa non-stop**: AI menganalisa setiap 15 detik, paralel 5 pair per batch
- **Teknikal lengkap**: RSI, MACD, Bollinger Bands, EMA (9/21/50/200), ATR, Stochastic, candlestick patterns
- **Fundamental**: AI analisa berita & konteks makro (cached 10 menit)
- **Simulasi trading**: Virtual buy/sell dengan SL/TP, slippage, komisi
- **Realtime P&L**: Running profit/loss per pair + total portfolio
- **Self-correction**: Jika loss > -7% → AI evaluasi & ubah strategi otomatis
- **Strategy memory**: Strategi terbaik per pair disimpan di `data/strategies/`
- **Dashboard**: Glassmorphism dark UI di `http://localhost:3000`

## 🚀 Quick Start

```bash
# Clone and enter project
git clone <repo-url> && cd autonomous-market-ai

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your AI API key

# Development mode
npx ts-node src/index.ts

# Or build & run (production)
npm run build && npm start
```

Buka browser: **http://localhost:3000**

## ⚙️ Configuration

### Environment Variables

Copy `.env.example` to `.env` and set values. See `.env.example` for the full list with descriptions.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_BASE_URL` | Yes | `https://ai.semutssh.com` | OpenAI-compatible API base URL |
| `AI_API_KEY` | Yes | — | API key for the AI provider |
| `DASHBOARD_HOST` | No | `127.0.0.1` | Dashboard listen address |
| `DASHBOARD_AUTH_TOKEN` | No | empty (no auth) | Bearer token for dashboard/API auth |
| `STARTUP_READINESS_TIMEOUT_MS` | No | `10000` | Max ms to wait for data sources at boot |
| `STARTUP_READINESS_MODE` | No | `usable` | `usable` or `live` |
| `STARTUP_READINESS_FAILURE_POLICY` | No | `warn` | `warn` (continue) or `fail` (abort) |
| `STARTUP_READINESS_CRYPTO` | No | — | Require tier: `LIVE`, `DEGRADED`, `SIMULATION` |
| `STARTUP_READINESS_FOREX` | No | — | Same as above, for forex |
| `STARTUP_READINESS_COMMODITY` | No | — | Same as above, for commodities |

### Runtime Config (`src/config.ts`)

Key settings you can adjust in `CONFIG`:

| Section | Key | Default | Notes |
|---------|-----|---------|-------|
| `MODE` | — | `'SWING'` | `'SWING'` (15s cycle) or `'SCALPING'` (5s cycle) |
| `TRADING` | `STARTING_BALANCE_USDT` | `1000` | Virtual balance per pair |
| `TRADING` | `LOSS_THRESHOLD_PCT` | `-7` | Self-correction trigger |
| `TRADING` | `DAILY_LOSS_LIMIT_PCT` | `3` | Circuit breaker halts trading above this daily loss |
| `TRADING.MULTI_TP` | `TP1/TP2/TP3_ATR` | `1.5/3.0/5.0` | Take-profit levels as ATR multipliers |
| `TRADING.PYRAMID` | `MAX_LAYERS` | `3` | Max add-on positions per pair |
| `KELLY` | `KELLY_FRACTION` | `0.5` | Half-Kelly position sizing |
| `PORTFOLIO_HEAT` | `MAX_HEAT_PCT` | `10` | Max total open risk across all pairs |

## 📁 Project Structure

```
src/
├── index.ts               # Entry point + graceful shutdown
├── config.ts              # Runtime config, types, validation
├── ai/
│   ├── client.ts          # AI HTTP client (OpenAI-compatible)
│   └── analyst.ts         # Market analysis prompt + parsing
├── data/
│   ├── crypto.ts          # Binance WebSocket + REST
│   ├── forex.ts           # Forex rates (Open Exchange Rates)
│   ├── commodity.ts       # Gold, Silver, Oil feeds
│   ├── calendar.ts        # Economic calendar / news window filter
│   └── macro.ts           # DXY, risk sentiment, macro context
├── analysis/
│   ├── technical.ts       # RSI, MACD, BB, EMA, ATR, Stochastic, SMC, Ichimoku
│   ├── fundamental.ts     # AI news/sentiment analysis
│   ├── mtf.ts             # Multi-timeframe analysis
│   ├── regime.ts          # Market regime detection
│   └── liquidity.ts       # Liquidity sweep detection
├── trading/
│   ├── simulator.ts       # Virtual trading engine (multi-TP, trailing SL, pyramiding)
│   └── strategy_store.ts  # Best strategy persistence per pair
├── engine/
│   ├── orchestrator.ts    # Main parallel analysis loop
│   └── readiness.ts       # Data source readiness probe at startup
├── analytics/
│   ├── performance.ts     # Portfolio metrics, circuit breaker, daily tracking
│   ├── kelly.ts           # Kelly Criterion position sizing
│   ├── sessions.ts        # Market session detection (London, NY, Asia)
│   ├── backtest.ts        # Backtesting framework (dormant)
│   └── var.ts             # Value-at-Risk module (dormant)
├── learning/
│   └── corrector.ts       # Self-correction on sustained losses
├── persistence/
│   └── state_store.ts     # Pair state, circuit breaker, runtime meta persistence
└── dashboard/
    ├── server.ts          # Express + WebSocket API
    └── public/
        ├── index.html     # Realtime dashboard UI
        └── styles.css     # Tailwind CSS (compiled)

data/
├── strategies/            # Best strategies per pair (auto-saved)
└── history/               # Trade history
```

## 🌐 Dashboard

Dashboard realtime di **http://localhost:3000** menampilkan:
- Portfolio summary: total equity, P&L, win rate
- Per-pair card: harga, signal AI, technical score, confidence, P&L
- Activity log: semua trade, AI analysis, self-correction events

## 📡 Data Sources

| Sumber | Data | Status |
|--------|------|--------|
| Binance WebSocket | Real-time crypto prices | Gratis |
| Binance REST API | OHLCV candles multi-timeframe | Gratis |
| Open Exchange Rates | Forex rates | Gratis |
| CryptoCompare | Berita crypto | Gratis |
| SemutSSH AI | Analysis + signals | API Key provided |

**Fallback**: Jika network terbatas, sistem otomatis menggunakan simulated price data yang realistis.

## 🤖 AI Model

- **Primary**: `semut/opus-4.6`
- **Fallback**: `semut/sonnet-4.6`
- **Base URL**: `https://ai.semutssh.com`

## ⚠️ Disclaimer

Ini adalah sistem **simulasi/paper trading**. Tidak menggunakan uang nyata. Untuk edukasi & riset saja.
