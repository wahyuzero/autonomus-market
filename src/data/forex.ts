// ============================================================
// FOREX DATA - Free forex rates via exchangerate.host
// ============================================================

import axios from 'axios';
import { Candle, MarketData } from '../config';

const FOREX_BASE = 'https://api.exchangerate.host';
const OPEN_FX = 'https://open.er-api.com/v6/latest';

const liveForex: Map<string, number> = new Map();

// Fetch current forex rates
export async function fetchForexRates(): Promise<void> {
  try {
    const { data } = await axios.get(`${OPEN_FX}/USD`, { timeout: 10000 });
    if (data?.rates) {
      const rates: Record<string, number> = data.rates;
      // Convert to pair format e.g. EURUSD = 1/rates.EUR
      const pairs = ['EUR', 'GBP', 'JPY', 'AUD', 'CHF'];
      for (const currency of pairs) {
        if (rates[currency]) {
          const usdRate = 1 / rates[currency];
          liveForex.set(`${currency}USD`, usdRate);
        }
      }
      // USDJPY etc
      if (rates['JPY']) liveForex.set('USDJPY', rates['JPY']);
      if (rates['CHF']) liveForex.set('USDCHF', rates['CHF']);
    }
  } catch (err: any) {
    console.error('[Forex] Failed to fetch rates:', err.message);
  }
}

export function getForexPrice(pair: string): number {
  return liveForex.get(pair) ?? 0;
}

// Simulate candles from current + slight random variation (since free API doesn't provide OHLCV)
export function simulateForexCandles(pair: string, count: number = 100): Candle[] {
  const basePrice = liveForex.get(pair) ?? 1.0;
  const volatility = basePrice * 0.001; // 0.1% volatility per candle
  const candles: Candle[] = [];
  let price = basePrice * (1 - count * 0.0005);
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const open = price;
    const change = (Math.random() - 0.5) * 2 * volatility;
    const high = open + Math.abs(change) + Math.random() * volatility;
    const low = open - Math.abs(change) - Math.random() * volatility;
    const close = open + change;
    price = close;

    candles.push({
      time: now - (count - i) * 60000, // 1min candles
      open,
      high,
      low,
      close,
      volume: Math.random() * 1000 + 500,
    });
  }

  return candles;
}

export async function buildForexMarketData(pair: string): Promise<MarketData> {
  const price = liveForex.get(pair) ?? 0;
  const candles = simulateForexCandles(pair, 200);

  return {
    pair,
    type: 'forex',
    price: price || 1.0,
    change24h: (Math.random() - 0.5) * 0.5, // ~0.5% daily forex moves
    volume24h: Math.random() * 1e9 + 1e8,
    candles: {
      '1m': candles.slice(-50),
      '5m': candles.slice(-100),
      '15m': candles.slice(-100),
      '1h': candles.slice(-100),
      '4h': candles.slice(-50),
    },
    updatedAt: Date.now(),
  };
}

// Periodically refresh forex rates
export function startForexRefresh(intervalMs: number = 60000): void {
  fetchForexRates();
  setInterval(fetchForexRates, intervalMs);
}
