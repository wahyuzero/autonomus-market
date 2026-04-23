// ============================================================
// BACKTEST MODULE — Focused Unit Tests
// Wave 1, Phase 4: validate runBacktest + logBacktestResult
// with synthetic candle fixtures; no production changes.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Candle, TechnicalSummary } from '../config';

// ── Mock computeTechnicals so we control entry/exit signals ──
vi.mock('../analysis/technical', () => ({
  computeTechnicals: vi.fn(),
}));

import { computeTechnicals } from '../analysis/technical';
import { runBacktest, logBacktestResult, BacktestResult, BacktestTrade } from '../analytics/backtest';

const mockedCompute = vi.mocked(computeTechnicals);

// ── Helpers ──────────────────────────────────────────────────

/** Build N flat candles around `price`. */
function flatCandles(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: 1_700_000_000 + i * 60_000,
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 1000,
  }));
}

/** Neutral tech summary (no entry trigger). */
function neutralTech(price: number): TechnicalSummary {
  return {
    trend: 'NEUTRAL',
    rsi: 50,
    macd: { line: 0, signal: 0, histogram: 0 },
    bbands: { upper: price * 1.02, middle: price, lower: price * 0.98, width: 0.04 },
    ema: { ema9: price, ema21: price, ema50: price, ema200: price },
    atr: price * 0.01,
    stochastic: { k: 50, d: 50 },
    support: price * 0.98,
    resistance: price * 1.02,
    patterns: [],
    score: 30, // below default threshold of 60
  };
}

/** Bullish tech summary with configurable score and ATR. */
function bullishTech(price: number, score = 75, atr?: number): TechnicalSummary {
  return {
    ...neutralTech(price),
    trend: 'BULLISH',
    score,
    atr: atr ?? price * 0.01,
  };
}

// ============================================================
// 1. ZERO-TRADE / NO-SIGNAL PATH
// ============================================================
describe('runBacktest — zero trades', () => {
  beforeEach(() => {
    mockedCompute.mockReset();
    // Default: always neutral, never triggers entry
    mockedCompute.mockImplementation((candles: Candle[]) => neutralTech(candles.at(-1)?.close ?? 100));
  });

  it('returns empty result when no candles meet entry conditions', async () => {
    const candles = flatCandles(100);
    const result = await runBacktest(candles);

    expect(result.totalTrades).toBe(0);
    expect(result.trades).toEqual([]);
    expect(result.winRate).toBe(0);
    expect(result.profitFactor).toBe(0);
    expect(result.totalPnl).toBe(0);
    expect(result.totalPnlPct).toBe(0);
    expect(result.maxDrawdownPct).toBe(0);
    expect(result.sharpeRatio).toBe(0);
    expect(result.avgHoldingCandles).toBe(0);
    expect(result.bestTrade).toBe(0);
    expect(result.worstTrade).toBe(0);
    expect(result.recommendation).toContain('No trades');
    expect(result.configUsed).toEqual({ signalThreshold: 60, atrMultiplierSL: 2.0 });
  });

  it('handles fewer candles than LOOKBACK (60) gracefully', async () => {
    const candles = flatCandles(10);
    const result = await runBacktest(candles);
    expect(result.totalTrades).toBe(0);
  });

  it('respects custom signalThreshold', async () => {
    // Score 55 with threshold 60 → no entry
    mockedCompute.mockImplementation((candles: Candle[]) =>
      bullishTech(candles.at(-1)?.close ?? 100, 55)
    );
    const candles = flatCandles(100);
    const result = await runBacktest(candles, { signalThreshold: 60 });
    expect(result.totalTrades).toBe(0);
  });
});

// ============================================================
// 2. PROFITABLE TRADE PATH (TP hit)
// ============================================================
describe('runBacktest — profitable trade path', () => {
  beforeEach(() => {
    mockedCompute.mockReset();
  });

  it('enters on bullish signal and exits at TP1', async () => {
    const entryPrice = 100;
    const atr = 1; // 1% of price
    const candles = flatCandles(100, entryPrice);

    // Push price up on candle after entry to trigger TP1
    // TP1 = entry + tp1ATR * atr = 100 + 1.5 * 1 = 101.5
    // Set high of candle 62 to exceed TP1
    candles[62] = {
      ...candles[62],
      high: 102, // > 101.5, triggers TP1
      low: 99,
      close: 102,
    };

    // Make computeTechnicals return bullish at index 60 (LOOKBACK)
    // The loop starts at LOOKBACK=60, and since i%3===0 for i=60, it will compute
    mockedCompute.mockImplementation((cs: Candle[]) => {
      const last = cs.at(-1);
      if (!last) return neutralTech(100);
      // When we've accumulated at least 61 candles (index 60), trigger entry
      if (cs.length >= 61) return bullishTech(last.close, 75, atr);
      return neutralTech(last.close);
    });

    const result = await runBacktest(candles);

    expect(result.totalTrades).toBeGreaterThanOrEqual(1);
    const trade = result.trades[0];
    expect(trade.direction).toBe('BUY');
    expect(trade.exitReason).toBe('TP1');
    expect(trade.pnl).toBeGreaterThan(0);
    expect(trade.pnlPct).toBeGreaterThan(0);
    expect(result.totalPnl).toBeGreaterThan(0);
  });
});

// ============================================================
// 3. STOP-LOSS PATH
// ============================================================
describe('runBacktest — stop-loss path', () => {
  beforeEach(() => {
    mockedCompute.mockReset();
  });

  it('enters on bullish signal and exits at SL', async () => {
    const entryPrice = 100;
    const atr = 1;
    // SL = entry - atrSLMult * atr = 100 - 2.0 * 1 = 98
    const candles = flatCandles(100, entryPrice);

    // Drop price on candle 62 to trigger SL
    candles[62] = {
      ...candles[62],
      low: 96, // well below SL of 98
      high: 100,
      close: 97,
    };

    mockedCompute.mockImplementation((cs: Candle[]) => {
      const last = cs.at(-1);
      if (!last) return neutralTech(100);
      if (cs.length >= 61) return bullishTech(last.close, 75, atr);
      return neutralTech(last.close);
    });

    const result = await runBacktest(candles);

    expect(result.totalTrades).toBeGreaterThanOrEqual(1);
    const trade = result.trades[0];
    expect(trade.direction).toBe('BUY');
    expect(trade.exitReason).toBe('SL');
    expect(trade.pnl).toBeLessThan(0);
    expect(trade.pnlPct).toBeLessThan(0);
    expect(trade.exitPrice).toBe(98); // SL = 100 - 2*1
  });
});

// ============================================================
// 4. SUMMARY METRICS SHAPE
// ============================================================
describe('runBacktest — summary metrics shape', () => {
  beforeEach(() => {
    mockedCompute.mockReset();
  });

  it('BacktestResult has all required fields with correct types', async () => {
    const candles = flatCandles(100, 100);
    mockedCompute.mockImplementation((cs: Candle[]) =>
      bullishTech(cs.at(-1)?.close ?? 100, 80, 1)
    );

    // Shape future candles to force an exit (TP)
    // With ATR=1, TP3=100+5=105, TP2=100+3=103, TP1=100+1.5=101.5
    // Push high of candle 62 to exceed TP1
    candles[62] = { ...candles[62], high: 102, low: 99, close: 102 };

    const result = await runBacktest(candles);

    // Structural checks
    expect(result).toHaveProperty('trades');
    expect(result).toHaveProperty('totalTrades');
    expect(result).toHaveProperty('winRate');
    expect(result).toHaveProperty('profitFactor');
    expect(result).toHaveProperty('totalPnl');
    expect(result).toHaveProperty('totalPnlPct');
    expect(result).toHaveProperty('maxDrawdownPct');
    expect(result).toHaveProperty('sharpeRatio');
    expect(result).toHaveProperty('avgHoldingCandles');
    expect(result).toHaveProperty('bestTrade');
    expect(result).toHaveProperty('worstTrade');
    expect(result).toHaveProperty('recommendation');
    expect(result).toHaveProperty('configUsed');

    // Type checks
    expect(Array.isArray(result.trades)).toBe(true);
    expect(typeof result.totalTrades).toBe('number');
    expect(typeof result.winRate).toBe('number');
    expect(typeof result.profitFactor).toBe('number');
    expect(typeof result.totalPnl).toBe('number');
    expect(typeof result.totalPnlPct).toBe('number');
    expect(typeof result.maxDrawdownPct).toBe('number');
    expect(typeof result.sharpeRatio).toBe('number');
    expect(typeof result.avgHoldingCandles).toBe('number');
    expect(typeof result.bestTrade).toBe('number');
    expect(typeof result.worstTrade).toBe('number');
    expect(typeof result.recommendation).toBe('string');
    expect(typeof result.configUsed).toBe('object');

    // configUsed shape
    expect(result.configUsed).toHaveProperty('signalThreshold');
    expect(result.configUsed).toHaveProperty('atrMultiplierSL');
  });

  it('BacktestTrade has all required fields', async () => {
    const candles = flatCandles(100, 100);
    mockedCompute.mockImplementation((cs: Candle[]) =>
      bullishTech(cs.at(-1)?.close ?? 100, 80, 1)
    );
    candles[62] = { ...candles[62], high: 102, low: 99, close: 102 };

    const result = await runBacktest(candles);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);

    const trade: BacktestTrade = result.trades[0];
    expect(trade).toHaveProperty('direction');
    expect(trade).toHaveProperty('entryIndex');
    expect(trade).toHaveProperty('entryPrice');
    expect(trade).toHaveProperty('exitPrice');
    expect(trade).toHaveProperty('exitIndex');
    expect(trade).toHaveProperty('exitReason');
    expect(trade).toHaveProperty('pnl');
    expect(trade).toHaveProperty('pnlPct');
    expect(trade).toHaveProperty('holdingCandles');
    expect(trade).toHaveProperty('atr');

    // Allowed exit reasons
    const validReasons: BacktestTrade['exitReason'][] = ['TP1', 'TP2', 'TP3', 'SL', 'END'];
    expect(validReasons).toContain(trade.exitReason);
    expect(trade.direction).toBe('BUY');
    expect(typeof trade.entryPrice).toBe('number');
    expect(typeof trade.exitPrice).toBe('number');
    expect(typeof trade.holdingCandles).toBe('number');
    expect(trade.holdingCandles).toBeGreaterThanOrEqual(1);
  });

  it('recommendation string matches expected patterns', async () => {
    // Zero-trade recommendation
    mockedCompute.mockImplementation((cs: Candle[]) => neutralTech(cs.at(-1)?.close ?? 100));
    const noTradeResult = await runBacktest(flatCandles(100));
    expect(noTradeResult.recommendation).toContain('No trades');

    // With-trade recommendation (any of the three patterns)
    mockedCompute.mockImplementation((cs: Candle[]) =>
      bullishTech(cs.at(-1)?.close ?? 100, 80, 1)
    );
    const candles = flatCandles(100, 100);
    candles[62] = { ...candles[62], high: 102, low: 99, close: 102 };
    const tradeResult = await runBacktest(candles);
    const validRecs = ['✅', '⚡', '❌'];
    expect(validRecs.some(r => tradeResult.recommendation.includes(r))).toBe(true);
  });
});

// ============================================================
// 5. logBacktestResult helper
// ============================================================
describe('logBacktestResult', () => {
  it('logs formatted output without throwing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result: BacktestResult = {
      trades: [],
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      totalPnl: 0,
      totalPnlPct: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      avgHoldingCandles: 0,
      bestTrade: 0,
      worstTrade: 0,
      recommendation: '⚠️ No trades generated.',
      configUsed: { signalThreshold: 60, atrMultiplierSL: 2.0 },
    };

    expect(() => logBacktestResult('BTC/USDT', result)).not.toThrow();

    expect(spy).toHaveBeenCalled();
    // Should log pair name
    const allCalls = spy.mock.calls.map((c: any[]) => c.join(' '));
    expect(allCalls.some(c => c.includes('BTC/USDT'))).toBe(true);

    spy.mockRestore();
  });

  it('logs positive PnL with plus sign prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result: BacktestResult = {
      trades: [],
      totalTrades: 5,
      winRate: 60,
      profitFactor: 1.5,
      totalPnl: 42.5,
      totalPnlPct: 4.25,
      maxDrawdownPct: 2.1,
      sharpeRatio: 1.3,
      avgHoldingCandles: 3,
      bestTrade: 20,
      worstTrade: -5,
      recommendation: '✅ Good',
      configUsed: { signalThreshold: 60, atrMultiplierSL: 2.0 },
    };

    logBacktestResult('ETH/USDT', result);
    const output = spy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('+'); // positive PnL prefixed with +
    spy.mockRestore();
  });
});
