// ============================================================
// CRYPTO DATA - Binance WebSocket + REST API (FREE, no key)
// ============================================================

import axios from 'axios';
import WebSocket from 'ws';
import { Candle, MarketData, SourceStatus, SourceHealthTier } from '../config';
import { EventEmitter } from 'events';

const BINANCE_REST = 'https://api.binance.com/api/v3';
const BINANCE_WS = 'wss://stream.binance.com:9443';

export const priceEmitter = new EventEmitter();
const livePrices: Map<string, number> = new Map();
const liveVolumes: Map<string, number> = new Map();
const liveChanges: Map<string, number> = new Map();

// Seed prices for fallback simulation (approximate values March 2026)
const SEED_PRICES: Record<string, number> = {
  BTCUSDT: 87000, ETHUSDT: 2400, BNBUSDT: 580, SOLUSDT: 145,
  XRPUSDT: 0.52, DOGEUSDT: 0.17, ADAUSDT: 0.68, AVAXUSDT: 28,
  DOTUSDT: 6.2, MATICUSDT: 0.48, LINKUSDT: 14.5, UNIUSDT: 7.8,
  LTCUSDT: 95, ATOMUSDT: 7.4, NEARUSDT: 4.2,
};

let wsConnected = false;
let simulationActive = false;

// Start WebSocket for real-time price updates
export function startPriceWebSocket(pairs: string[]): void {
  const cryptoPairs = pairs.filter(p => !p.includes('/'));
  const streams = cryptoPairs.map(p => `${p.toLowerCase()}@miniTicker`).join('/');
  const url = `${BINANCE_WS}/stream?streams=${streams}`;

  // Initialize with seed prices immediately
  for (const pair of cryptoPairs) {
    if (!livePrices.has(pair)) {
      livePrices.set(pair, SEED_PRICES[pair] ?? 1.0);
      liveChanges.set(pair, 0);
      liveVolumes.set(pair, (SEED_PRICES[pair] ?? 1) * 200000);
    }
  }

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    console.warn('[Binance WS] Cannot connect, using price simulation');
    if (!simulationActive) simulatePriceFeed(cryptoPairs);
    return;
  }

  const connectTimeout = setTimeout(() => {
    if (!wsConnected) {
      console.warn('[Binance WS] Connection timeout → using price simulation');
      ws.terminate();
      if (!simulationActive) simulatePriceFeed(cryptoPairs);
    }
  }, 8000);

  ws.on('open', () => {
    clearTimeout(connectTimeout);
    wsConnected = true;
    console.log(`[Binance WS] ✅ Connected — tracking ${cryptoPairs.length} crypto pairs live`);
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const ticker = msg.data;
      if (!ticker) return;
      const symbol: string = ticker.s;
      const price = parseFloat(ticker.c);
      const change = parseFloat(ticker.P);
      const volume = parseFloat(ticker.v) * parseFloat(ticker.c);
      livePrices.set(symbol, price);
      liveChanges.set(symbol, change);
      liveVolumes.set(symbol, volume);
      priceEmitter.emit('price', { pair: symbol, price, change });
    } catch { /* ignore */ }
  });

  ws.on('close', () => {
    wsConnected = false;
    console.warn('[Binance WS] Disconnected. Reconnecting in 5s...');
    if (!simulationActive) simulatePriceFeed(cryptoPairs);
    setTimeout(() => startPriceWebSocket(pairs), 5000);
  });

  ws.on('error', (err) => {
    console.warn('[Binance WS] Error:', err.message, '→ using simulation');
    ws.terminate();
    if (!simulationActive) simulatePriceFeed(cryptoPairs);
  });
}

// Fallback: simulate realistic price movement when Binance is unreachable
function simulatePriceFeed(pairs: string[]): void {
  simulationActive = true;
  console.log('[Price Feed] 📊 Using simulated price data for', pairs.length, 'pairs');

  setInterval(() => {
    for (const pair of pairs) {
      const current = livePrices.get(pair) ?? SEED_PRICES[pair] ?? 1;
      const volatility = current * 0.0018;
      const drift = 0.0002; // slight upward drift
      const change = (Math.random() - 0.5 + drift) * 2 * volatility;
      const newPrice = Math.max(current * 0.9, current + change);
      livePrices.set(pair, newPrice);
      const seedPrice = SEED_PRICES[pair] ?? newPrice;
      liveChanges.set(pair, ((newPrice - seedPrice) / seedPrice) * 100);
      liveVolumes.set(pair, newPrice * (Math.random() * 300000 + 50000));
    }
  }, 2000);
}

export function getLivePrice(pair: string): number {
  return livePrices.get(pair) ?? SEED_PRICES[pair] ?? 0;
}

export function isWsConnected(): boolean {
  return wsConnected;
}

// Fetch OHLCV candles from Binance REST
export async function fetchCandles(pair: string, interval: string, limit: number = 200): Promise<Candle[]> {
  try {
    const { data } = await axios.get(`${BINANCE_REST}/klines`, {
      params: { symbol: pair, interval, limit },
      timeout: 8000,
    });

    return data.map((k: any[]): Candle => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  } catch {
    return generateSimulatedCandles(pair, limit, interval);
  }
}

// Generate statistically realistic candles when REST unavailable
function generateSimulatedCandles(pair: string, count: number, interval: string): Candle[] {
  const basePrice = livePrices.get(pair) ?? SEED_PRICES[pair] ?? 100;
  const volatility = basePrice * 0.002;
  const intervalMs: Record<string, number> = {
    '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000
  };
  const msPerCandle = intervalMs[interval] ?? 60000;
  const now = Date.now();
  const candles: Candle[] = [];
  let price = basePrice * (1 - (count / 2) * 0.0005);

  for (let i = 0; i < count; i++) {
    const open = price;
    const bodySize = volatility * (Math.random() * 1.5 + 0.2);
    const direction = Math.random() > 0.47 ? 1 : -1;
    const close = open + direction * bodySize;
    const high = Math.max(open, close) + Math.random() * volatility * 0.5;
    const low = Math.min(open, close) - Math.random() * volatility * 0.5;
    price = close;
    candles.push({
      time: now - (count - i) * msPerCandle,
      open, high, low, close,
      volume: (Math.random() * 500 + 100) * basePrice,
    });
  }

  return candles;
}

// Build full MarketData for a crypto pair
export async function buildCryptoMarketData(pair: string): Promise<MarketData> {
  const price = livePrices.get(pair) ?? SEED_PRICES[pair] ?? 0;

  const [candles1m, candles5m, candles15m, candles1h, candles4h] = await Promise.all([
    fetchCandles(pair, '1m', 50),
    fetchCandles(pair, '5m', 100),
    fetchCandles(pair, '15m', 100),
    fetchCandles(pair, '1h', 200),
    fetchCandles(pair, '4h', 100),
  ]);

  return {
    pair,
    type: 'crypto',
    price: price || (candles1m.at(-1)?.close ?? 0),
    change24h: liveChanges.get(pair) ?? 0,
    volume24h: liveVolumes.get(pair) ?? 0,
    candles: { '1m': candles1m, '5m': candles5m, '15m': candles15m, '1h': candles1h, '4h': candles4h },
    updatedAt: Date.now(),
  };
}

export function getSourceStatus(): SourceStatus {
  const status: SourceHealthTier = wsConnected
    ? 'LIVE'
    : simulationActive
      ? 'SIMULATION'
      : 'DEGRADED';

  return {
    source: 'crypto',
    status,
    message: wsConnected
      ? 'Binance WebSocket connected'
      : simulationActive
        ? 'Using simulated price feed'
        : 'Awaiting connection',
    lastUpdated: Date.now(),
    metadata: {
      wsConnected,
      simulationActive,
      trackedPairs: livePrices.size,
    },
  };
}
