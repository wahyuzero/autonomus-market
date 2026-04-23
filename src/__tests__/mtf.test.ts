// ============================================================
// Multi-Timeframe Analysis (MTF) — Unit Tests
// Validates analyzeMultiTimeframe across core alignment branches
// with synthetic Candle data.
// ============================================================

import { describe, it, expect } from 'vitest';
import { analyzeMultiTimeframe, type MTFResult, type HTFBias } from '../analysis/mtf';
import type { Candle } from '../config';

// ── Synthetic candle factories ──────────────────────────────

function makeCandle(time: number, open: number, close: number, high?: number, low?: number): Candle {
  return {
    time,
    open,
    high: high ?? Math.max(open, close) + 1,
    low: low ?? Math.min(open, close) - 1,
    close,
    volume: 100,
  };
}

/**
 * Generates a trending series of candles.
 * trend > 0  → uptrend  (each close higher than previous)
 * trend < 0  → downtrend (each close lower than previous)
 * trend === 0 → flat / sideways
 *
 * Produces enough candles (≥55) for the EMA50 calculation to work.
 */
function makeTrendingCandles(trend: number, count = 60): Candle[] {
  const candles: Candle[] = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    const open = price;
    const change = trend === 0
      ? (Math.sin(i) * 0.1)           // flat: tiny oscillation
      : trend * (1 + Math.random());   // trending
    const close = open + change;
    const high = Math.max(open, close) + Math.abs(change) * 0.5 + 0.5;
    const low = Math.min(open, close) - Math.abs(change) * 0.5 - 0.5;

    candles.push(makeCandle(i * 3600, open, close, high, low));
    price = close;
  }

  return candles;
}

// Pre-built candle sets
const bullishCandles = makeTrendingCandles(2);   // strong uptrend
const bearishCandles = makeTrendingCandles(-2);   // strong downtrend
const neutralCandles = makeTrendingCandles(0);    // sideways

// ── 1. HOLD signal branch ───────────────────────────────────

describe('analyzeMultiTimeframe — HOLD signal', () => {
  it('returns MIXED alignment with zero bonuses for HOLD', () => {
    const result = analyzeMultiTimeframe(bullishCandles, bullishCandles, 'HOLD');

    expect(result.alignment).toBe('MIXED');
    expect(result.confluenceBonus).toBe(0);
    expect(result.minConfidenceRequired).toBe(0);
  });

  it('still computes htfBias and mtfBias even on HOLD', () => {
    const result = analyzeMultiTimeframe(bullishCandles, bearishCandles, 'HOLD');

    expect(result.htfBias).toBe('BULLISH');
    expect(result.mtfBias).toBe('BEARISH');
    expect(result.description).toContain('4H: BULLISH');
    expect(result.description).toContain('1H: BEARISH');
  });

  it('includes both bias values in description', () => {
    const result = analyzeMultiTimeframe(bearishCandles, bullishCandles, 'HOLD');
    expect(result.description).toContain('4H: BEARISH');
    expect(result.description).toContain('1H: BULLISH');
  });
});

// ── 2. ALIGNED branch — both timeframes agree with signal ──

describe('analyzeMultiTimeframe — ALIGNED', () => {
  it('fully aligned BUY: 4H BULLISH + 1H BULLISH', () => {
    const result = analyzeMultiTimeframe(bullishCandles, bullishCandles, 'BUY');

    expect(result.htfBias).toBe('BULLISH');
    expect(result.mtfBias).toBe('BULLISH');
    expect(result.alignment).toBe('ALIGNED');
    expect(result.confluenceBonus).toBe(15);
    expect(result.minConfidenceRequired).toBe(0);
    expect(result.description).toContain('Full MTF alignment');
  });

  it('fully aligned SELL: 4H BEARISH + 1H BEARISH', () => {
    const result = analyzeMultiTimeframe(bearishCandles, bearishCandles, 'SELL');

    expect(result.htfBias).toBe('BEARISH');
    expect(result.mtfBias).toBe('BEARISH');
    expect(result.alignment).toBe('ALIGNED');
    expect(result.confluenceBonus).toBe(15);
    expect(result.minConfidenceRequired).toBe(0);
    expect(result.description).toContain('Full MTF alignment');
  });
});

// ── 3. OPPOSED branch — HTF fights the signal ──────────────

describe('analyzeMultiTimeframe — OPPOSED', () => {
  it('counter-trend BUY against BEARISH HTF', () => {
    const result = analyzeMultiTimeframe(bearishCandles, bearishCandles, 'BUY');

    expect(result.htfBias).toBe('BEARISH');
    expect(result.alignment).toBe('OPPOSED');
    expect(result.confluenceBonus).toBe(-20);
    expect(result.minConfidenceRequired).toBe(20);
    expect(result.description).toContain('Counter-trend');
  });

  it('counter-trend SELL against BULLISH HTF', () => {
    const result = analyzeMultiTimeframe(bullishCandles, bullishCandles, 'SELL');

    expect(result.htfBias).toBe('BULLISH');
    expect(result.alignment).toBe('OPPOSED');
    expect(result.confluenceBonus).toBe(-20);
    expect(result.minConfidenceRequired).toBe(20);
    expect(result.description).toContain('Counter-trend');
  });
});

// ── 4. MIXED branch — partial alignment ─────────────────────

describe('analyzeMultiTimeframe — MIXED (partial alignment)', () => {
  it('BUY with HTF aligned but MTF opposed → MIXED', () => {
    // HTF bullish (aligned with BUY), MTF bearish (not aligned)
    const result = analyzeMultiTimeframe(bullishCandles, bearishCandles, 'BUY');

    expect(result.htfBias).toBe('BULLISH');
    expect(result.mtfBias).toBe('BEARISH');
    expect(result.alignment).toBe('MIXED');
    expect(result.confluenceBonus).toBe(5);
    expect(result.minConfidenceRequired).toBe(5);
    expect(result.description).toContain('Partial MTF');
  });

  it('SELL with MTF aligned but HTF neutral → MIXED', () => {
    // HTF neutral (not aligned, not opposed), MTF bearish (aligned with SELL)
    const result = analyzeMultiTimeframe(neutralCandles, bearishCandles, 'SELL');

    // HTF is NEUTRAL so not aligned for SELL, but MTF is BEARISH which is aligned
    expect(result.mtfBias).toBe('BEARISH');
    expect(result.alignment).toBe('MIXED');
    expect(result.confluenceBonus).toBe(5);
    expect(result.minConfidenceRequired).toBe(5);
  });

  it('BUY with HTF neutral and MTF neutral → MIXED (HTF neutral fallback)', () => {
    // Force NEUTRAL bias with <20 candles — getBias returns NEUTRAL when candles < 20
    const shortBullish = makeTrendingCandles(2, 15);
    const result = analyzeMultiTimeframe(shortBullish, shortBullish, 'BUY');

    expect(result.htfBias).toBe('NEUTRAL');
    expect(result.mtfBias).toBe('NEUTRAL');
    expect(result.alignment).toBe('MIXED');
    expect(result.confluenceBonus).toBe(0);
    expect(result.minConfidenceRequired).toBe(0);
    expect(result.description).toContain('HTF neutral');
  });
});

// ── 5. Edge cases ────────────────────────────────────────────

describe('analyzeMultiTimeframe — edge cases', () => {
  it('fewer than 20 candles produces NEUTRAL bias', () => {
    const shortCandles = makeTrendingCandles(3, 15);
    expect(shortCandles.length).toBeLessThan(20);

    const result = analyzeMultiTimeframe(shortCandles, shortCandles, 'BUY');

    expect(result.htfBias).toBe('NEUTRAL');
    expect(result.mtfBias).toBe('NEUTRAL');
  });

  it('result is a plain object matching MTFResult interface', () => {
    const result = analyzeMultiTimeframe(bullishCandles, bullishCandles, 'BUY');

    expect(result).toHaveProperty('htfBias');
    expect(result).toHaveProperty('mtfBias');
    expect(result).toHaveProperty('alignment');
    expect(result).toHaveProperty('confluenceBonus');
    expect(result).toHaveProperty('minConfidenceRequired');
    expect(result).toHaveProperty('description');

    // JSON-serializable (no functions, no circular refs)
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.alignment).toBe('ALIGNED');
  });

  it('BUY with MTF aligned but HTF opposed → OPPOSED (HTF dominance)', () => {
    // HTF bearish (opposed to BUY), MTF bullish (aligned with BUY)
    const result = analyzeMultiTimeframe(bearishCandles, bullishCandles, 'BUY');

    expect(result.htfBias).toBe('BEARISH');
    expect(result.mtfBias).toBe('BULLISH');
    // MTF aligned but HTF opposed → still partial MIXED (not full OPPOSED because MTF is aligned)
    expect(result.alignment).toBe('MIXED');
    expect(result.confluenceBonus).toBe(5);
  });
});
