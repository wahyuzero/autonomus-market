// ============================================================
// LIQUIDITY SWEEP DETECTION
//
// Liquidity sweeps = institutional "stop hunts":
//   Price briefly breaks above a swing high (takes out buy-stops)
//   Then reverses sharply = bearish reversal signal.
//
//   Price briefly breaks below a swing low (takes out sell-stops)
//   Then reverses sharply = bullish reversal signal.
//
// Detection logic:
//   1. Identify recent swing highs/lows (pivot points in last N candles)
//   2. Check if price swept beyond pivot with a long wick
//   3. Check if price closed BACK below/above the pivot (rejection)
//   4. Confirms the sweep only if close body is inside the pivot zone
//
// High-probability entries: enter AFTER the sweep on confirmation candle
// ============================================================

import { Candle } from '../config';

export type SweepType = 'BULLISH_SWEEP' | 'BEARISH_SWEEP' | 'NONE';

export interface LiquiditySweep {
  type: SweepType;
  strength: number;         // 1–3 (wick size relative to ATR)
  sweptLevel: number;       // The price level that was swept
  candleIndex: number;      // Which candle performed the sweep (-1 = most recent)
  description: string;
  confluenceBonus: number;  // Added to confluence score
}

// ── Find pivot highs/lows in look-back window ────────────────
function findPivotHighs(candles: Candle[], lookback: number, pivotStrength = 3): number[] {
  const highs: number[] = [];
  const n = Math.min(lookback, candles.length);
  for (let i = pivotStrength; i < n - pivotStrength; i++) {
    const c = candles[candles.length - n + i];
    let isPivot = true;
    for (let j = 1; j <= pivotStrength; j++) {
      if (c.high <= candles[candles.length - n + i - j].high ||
          c.high <= candles[candles.length - n + i + j].high) {
        isPivot = false; break;
      }
    }
    if (isPivot) highs.push(c.high);
  }
  return highs;
}

function findPivotLows(candles: Candle[], lookback: number, pivotStrength = 3): number[] {
  const lows: number[] = [];
  const n = Math.min(lookback, candles.length);
  for (let i = pivotStrength; i < n - pivotStrength; i++) {
    const c = candles[candles.length - n + i];
    let isPivot = true;
    for (let j = 1; j <= pivotStrength; j++) {
      if (c.low >= candles[candles.length - n + i - j].low ||
          c.low >= candles[candles.length - n + i + j].low) {
        isPivot = false; break;
      }
    }
    if (isPivot) lows.push(c.low);
  }
  return lows;
}

// ── ATR calculation ──────────────────────────────────────────
function calcATR(candles: Candle[], period = 14): number {
  const slice = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low - slice[i-1].close)
    );
    sum += tr;
  }
  return sum / period;
}

// ============================================================
// MAIN DETECTION FUNCTION
// ============================================================
export function detectLiquiditySweep(candles: Candle[], lookback = 30): LiquiditySweep {
  if (candles.length < lookback + 5) {
    return { type: 'NONE', strength: 0, sweptLevel: 0, candleIndex: -1, description: 'Insufficient data', confluenceBonus: 0 };
  }

  const lastCandle = candles.at(-1)!;
  const prevCandle = candles.at(-2)!;
  const atr = calcATR(candles);
  const tolerance = atr * 0.1; // Allow 10% ATR tolerance for sweep

  // Look at the last 2 candles for sweeps
  const checkCandles = [prevCandle, lastCandle];

  for (let ci = 0; ci < checkCandles.length; ci++) {
    const sweepCandle = checkCandles[ci];
    const confirmationAvail = ci < checkCandles.length - 1; // Is there a follow-up candle?

    // ── BEARISH SWEEP (above swing high, then close inside) ──
    const pivotHighs = findPivotHighs(candles.slice(0, candles.length - ci - 1), lookback);
    for (const pivotHigh of pivotHighs.slice(-3)) {
      const sweptAbove = sweepCandle.high > pivotHigh + tolerance;
      const closedBelow = sweepCandle.close < pivotHigh; // Closed back below the level
      const wickSize = sweepCandle.high - Math.max(sweepCandle.open, sweepCandle.close);
      const bodySize = Math.abs(sweepCandle.close - sweepCandle.open);
      const isWickDominant = wickSize > bodySize * 1.5; // Wick at least 1.5x body

      if (sweptAbove && closedBelow && isWickDominant) {
        const strength = Math.min(3, Math.ceil(wickSize / atr)) as 1 | 2 | 3;
        return {
          type: 'BEARISH_SWEEP',
          strength,
          sweptLevel: pivotHigh,
          candleIndex: -(ci + 1),
          description: `🦁 Bearish Sweep: price swept high $${pivotHigh.toFixed(4)}, rejected. Wick=${(wickSize/atr).toFixed(1)}×ATR`,
          confluenceBonus: strength * 8, // +8 to +24 bonus
        };
      }
    }

    // ── BULLISH SWEEP (below swing low, then close inside) ───
    const pivotLows = findPivotLows(candles.slice(0, candles.length - ci - 1), lookback);
    for (const pivotLow of pivotLows.slice(-3)) {
      const sweptBelow = sweepCandle.low < pivotLow - tolerance;
      const closedAbove = sweepCandle.close > pivotLow; // Closed back above the level
      const wickSize = Math.min(sweepCandle.open, sweepCandle.close) - sweepCandle.low;
      const bodySize = Math.abs(sweepCandle.close - sweepCandle.open);
      const isWickDominant = wickSize > bodySize * 1.5;

      if (sweptBelow && closedAbove && isWickDominant) {
        const strength = Math.min(3, Math.ceil(wickSize / atr)) as 1 | 2 | 3;
        return {
          type: 'BULLISH_SWEEP',
          strength,
          sweptLevel: pivotLow,
          candleIndex: -(ci + 1),
          description: `🐂 Bullish Sweep: price swept low $${pivotLow.toFixed(4)}, rejected. Wick=${(wickSize/atr).toFixed(1)}×ATR`,
          confluenceBonus: strength * 8,
        };
      }
    }
  }

  return { type: 'NONE', strength: 0, sweptLevel: 0, candleIndex: -1, description: 'No sweep detected', confluenceBonus: 0 };
}
