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
cd /home/wxsys/Development/autonomous-market-ai

# Install dependencies (sudah dilakukan)
npm install

# Jalankan (development mode)
npx ts-node src/index.ts

# Atau build & run (production)
npm run build && npm start
```

Buka browser: **http://localhost:3000**

## ⚙️ Configuration

Edit `src/config.ts`:

```typescript
TRADING: {
  STARTING_BALANCE_USDT: 1000,  // Balance per pair
  LOSS_THRESHOLD_PCT: -7,        // Self-correction trigger
  TAKE_PROFIT_PCT: 3,            // Default TP %
  STOP_LOSS_PCT: 2,              // Default SL %
}

ANALYSIS: {
  MAX_PARALLEL_PAIRS: 20,
  ANALYSIS_INTERVAL_MS: 15000,  // Analisa setiap 15 detik
}
```

## 📁 Project Structure

```
src/
├── index.ts               # Entry point
├── config.ts              # Config & types
├── ai/
│   ├── client.ts          # SemutSSH AI client (semut/opus-4.6)
│   └── analyst.ts         # AI market analyst
├── data/
│   ├── crypto.ts          # Binance WebSocket + REST
│   └── forex.ts           # Forex rates
├── analysis/
│   ├── technical.ts       # RSI, MACD, BB, EMA, ATR, Stochastic
│   └── fundamental.ts     # AI news analysis
├── trading/
│   ├── simulator.ts       # Virtual trading engine
│   └── strategy_store.ts  # Best strategy persistence
├── engine/
│   └── orchestrator.ts    # Main parallel analysis loop
├── learning/
│   └── corrector.ts       # Self-correction on loss
└── dashboard/
    ├── server.ts           # Express + WebSocket
    └── public/index.html  # Realtime dashboard

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
