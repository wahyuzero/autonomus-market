// ============================================================
// REGIME DETECTION — Market Classification Engine
//
// Classifies the current market regime to adapt strategy:
//
//   STRONG_BULL  — price above all EMAs, ADX > 30, bullish
//   BULL         — trending up, price above EMA50
//   RANGING      — ADX < 20, Bollinger width narrow
//   BEAR         — trending down, price below EMA50
//   STRONG_BEAR  — price below all EMAs, ADX > 30, bearish
//   VOLATILE     — high ATR, wide BB, chaotic
//
// Usage:
//   detectRegime(candles)  →  { regime, strength, confidence }
//
// Strategy Adjustments per Regime:
//   BULL/STRONG_BULL → raise buy threshold, lower sell threshold
//   BEAR/STRONG_BEAR → tighten SL, only counter-trend with high conf
//   RANGING          → reduce TP targets, use mean-reversion logic
//   VOLATILE         → reduce position sizes, wider SL
// ============================================================

import { Candle } from '../config';

export type MarketRegime =
  | 'STRONG_BULL'
  | 'BULL'
  | 'RANGING'
  | 'BEAR'
  | 'STRONG_BEAR'
  | 'VOLATILE';

export interface RegimeResult {
  regime: MarketRegime;
  strength: number;      // 0–100 conviction
  adx: number;           // ADX value
  bbWidth: number;       // Bollinger Band width (volatility measure)
  priceVsEma50: number;  // % price is above/below EMA50
  priceVsEma200: number; // % price is above/below EMA200
  description: string;
  // Strategy adjustments
  adjustments: {
    minConfidenceBonus: number; // Extra confidence required (e.g., +10 in bearish)
    positionSizeMult: number;   // Multiply position size (0.5 in volatile)
    tpMultiplier: number;       // Multiply TP levels (0.7 in ranging)
    avoidLong: boolean;         // Avoid new longs (bearish regimes)
    avoidShort: boolean;        // Avoid new shorts (bull regimes)
  };
}

// ── Simple EMA calculation ───────────────────────────────────
function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...Array(period - 1).fill(NaN), prev);
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// ── ADX calculation ──────────────────────────────────────────
function adx(candles: Candle[], period = 14): number {
  if (candles.length < period * 2) return 25;
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const plusDM = c.high - p.high > p.low - c.low ? Math.max(c.high - p.high, 0) : 0;
    const minusDM = p.low - c.low > c.high - p.high ? Math.max(p.low - c.low, 0) : 0;
    trueRanges.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const smoothTR = trueRanges.slice(-period * 2).reduce((a, b) => a + b, 0) / period;
  const smoothPlus = plusDMs.slice(-period * 2).reduce((a, b) => a + b, 0) / period;
  const smoothMinus = minusDMs.slice(-period * 2).reduce((a, b) => a + b, 0) / period;

  if (smoothTR === 0) return 25;
  const plusDI = (smoothPlus / smoothTR) * 100;
  const minusDI = (smoothMinus / smoothTR) * 100;
  const diff = Math.abs(plusDI - minusDI);
  const sum = plusDI + minusDI;
  const dx = sum > 0 ? (diff / sum) * 100 : 0;
  return dx; // Simplified single DX (approximate ADX)
}

// ── Bollinger Band Width ─────────────────────────────────────
function bollingerWidth(prices: number[], period = 20): number {
  if (prices.length < period) return 0.02;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return (4 * stdDev) / mean; // Band width ratio
}

// ============================================================
// MAIN DETECTION FUNCTION
// ============================================================
export function detectRegime(candles: Candle[]): RegimeResult {
  if (candles.length < 50) {
    return defaultRegime();
  }

  const closes = candles.map(c => c.close);
  const price = closes.at(-1)!;

  // EMAs
  const ema50s = ema(closes, 50);
  const ema200s = ema(closes, Math.min(200, candles.length - 1));
  const ema50 = ema50s.at(-1) ?? price;
  const ema200 = ema200s.at(-1) ?? price;

  // ADX (trend strength)
  const adxVal = adx(candles);

  // Bollinger width (volatility)
  const bbWidth = bollingerWidth(closes);

  // ATR-based volatility check
  const recentCandles = candles.slice(-20);
  const avgATR = recentCandles.reduce((s, c, i) => {
    if (i === 0) return s;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - recentCandles[i-1].close), Math.abs(c.low - recentCandles[i-1].close));
    return s + tr;
  }, 0) / 19;
  const volatilityPct = (avgATR / price) * 100;

  const priceVsEma50 = ((price - ema50) / ema50) * 100;
  const priceVsEma200 = ((price - ema200) / ema200) * 100;

  // Classify regime
  let regime: MarketRegime;
  let strength = 50;
  let description = '';

  const isTrending = adxVal > 25;
  const isHighVol = volatilityPct > 3 || bbWidth > 0.08;
  const aboveEma50 = price > ema50;
  const aboveEma200 = price > ema200;

  if (isHighVol && adxVal < 20) {
    regime = 'VOLATILE';
    strength = Math.min(100, volatilityPct * 20);
    description = `Chaotic: ATR=${volatilityPct.toFixed(1)}% BB-width=${(bbWidth*100).toFixed(1)}%`;
  } else if (!isTrending) {
    regime = 'RANGING';
    strength = Math.max(0, 100 - adxVal * 4);
    description = `Range-bound: ADX=${adxVal.toFixed(0)} | Price ±${Math.abs(priceVsEma50).toFixed(1)}% EMA50`;
  } else if (aboveEma50 && aboveEma200 && adxVal > 30) {
    regime = 'STRONG_BULL';
    strength = Math.min(100, adxVal * 2.5);
    description = `Strong uptrend: ADX=${adxVal.toFixed(0)}, +${priceVsEma50.toFixed(1)}% above EMA50`;
  } else if (aboveEma50) {
    regime = 'BULL';
    strength = Math.min(80, adxVal * 2);
    description = `Uptrend: +${priceVsEma50.toFixed(1)}% above EMA50, ADX=${adxVal.toFixed(0)}`;
  } else if (!aboveEma50 && !aboveEma200 && adxVal > 30) {
    regime = 'STRONG_BEAR';
    strength = Math.min(100, adxVal * 2.5);
    description = `Strong downtrend: ADX=${adxVal.toFixed(0)}, ${priceVsEma50.toFixed(1)}% below EMA50`;
  } else {
    regime = 'BEAR';
    strength = Math.min(80, adxVal * 2);
    description = `Downtrend: ${priceVsEma50.toFixed(1)}% below EMA50, ADX=${adxVal.toFixed(0)}`;
  }

  // Strategy adjustments per regime
  const adjustments = getAdjustments(regime);

  return {
    regime, strength, adx: adxVal, bbWidth,
    priceVsEma50, priceVsEma200, description, adjustments,
  };
}

type RegimeAdjustments = {
  minConfidenceBonus: number;
  positionSizeMult: number;
  tpMultiplier: number;
  avoidLong: boolean;
  avoidShort: boolean;
};

function getAdjustments(regime: MarketRegime): RegimeAdjustments {
  const map: Record<MarketRegime, RegimeAdjustments> = {
    STRONG_BULL: { minConfidenceBonus: -5,  positionSizeMult: 1.2, tpMultiplier: 1.3, avoidLong: false, avoidShort: true  },
    BULL:        { minConfidenceBonus: 0,   positionSizeMult: 1.0, tpMultiplier: 1.0, avoidLong: false, avoidShort: false },
    RANGING:     { minConfidenceBonus: 10,  positionSizeMult: 0.7, tpMultiplier: 0.6, avoidLong: false, avoidShort: false },
    BEAR:        { minConfidenceBonus: 15,  positionSizeMult: 0.8, tpMultiplier: 0.8, avoidLong: true,  avoidShort: false },
    STRONG_BEAR: { minConfidenceBonus: 25,  positionSizeMult: 0.5, tpMultiplier: 0.7, avoidLong: true,  avoidShort: false },
    VOLATILE:    { minConfidenceBonus: 20,  positionSizeMult: 0.5, tpMultiplier: 1.2, avoidLong: false, avoidShort: false },
  };
  return map[regime];
}

function defaultRegime(): RegimeResult {
  return {
    regime: 'RANGING', strength: 50, adx: 25, bbWidth: 0.04,
    priceVsEma50: 0, priceVsEma200: 0, description: 'Insufficient data',
    adjustments: { minConfidenceBonus: 0, positionSizeMult: 1.0, tpMultiplier: 1.0, avoidLong: false, avoidShort: false },
  };
}
