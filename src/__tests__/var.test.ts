// ============================================================
// VaR Analytics — Unit Tests
// Exercises computeVaR and computePortfolioVaR across branches:
//   - no-trade / insufficient-history (method='none')
//   - parametric branch (5–19 trades)
//   - historical branch (≥20 trades)
//   - portfolio aggregation (multi-pair, exposure, empty)
// ============================================================

import { describe, it, expect } from 'vitest';
import { computeVaR, computePortfolioVaR } from '../analytics/var';
import { type PairState, type TradePosition, type StrategyConfig } from '../config';

// ── Helpers ─────────────────────────────────────────────────

const defaultStrategy: StrategyConfig = {
  name: 'test',
  tpPct: 3,
  slPct: 1.5,
  maxPositions: 3,
  signalThreshold: 0.6,
  indicators: ['rsi'],
  lastUpdated: Date.now(),
  winRate: 50,
  totalTrades: 0,
};

function makeClosedTrade(overrides: Partial<TradePosition> & { pnl?: number }): TradePosition {
  return {
    id: `trade-${Math.random().toString(36).slice(2, 8)}`,
    pair: 'BTC/USDT',
    type: 'BUY',
    entryPrice: 50000,
    initialQuantity: 0.01,
    quantity: 0,
    usdtValue: 500,
    currentUsdtValue: 0,
    tp1: 52000,
    tp2: 54000,
    tp3: 56000,
    originalSL: 49000,
    stopLoss: 49000,
    tpPhase: 'done' as any,
    highestClose: 51000,
    atr: 500,
    pyramidLayer: 1,
    openTime: Date.now() - 86400000,
    status: 'CLOSED',
    closePrice: 50500,
    closeTime: Date.now(),
    pnl: 0,
    pnlPct: 0,
    reason: 'tp1',
    partialCloses: [],
    takeProfit: 52000,
    ...overrides,
  };
}

function makePairState(overrides: Partial<PairState> = {}): PairState {
  return {
    pair: 'BTC/USDT',
    balance: 1000,
    positions: [],
    closedTrades: [],
    totalPnl: 0,
    totalPnlPct: 0,
    winRate: 0,
    strategy: { ...defaultStrategy },
    currentPrice: 50000,
    isAnalyzing: false,
    correctionCount: 0,
    ...overrides,
  };
}

function tradesWithPnls(pnls: number[]): TradePosition[] {
  return pnls.map((pnl) => makeClosedTrade({ pnl }));
}

// ── computeVaR ──────────────────────────────────────────────

describe('computeVaR', () => {
  // ── Branch: no trades → method='none'

  it('returns method="none" when there are 0 closed trades', () => {
    const result = computeVaR(makePairState({ closedTrades: [] }));
    expect(result.method).toBe('none');
    expect(result.var95).toBe(0);
    expect(result.var99).toBe(0);
    expect(result.var95Pct).toBe(0);
    expect(result.var99Pct).toBe(0);
    expect(result.expectedShortfall).toBe(0);
    expect(result.tradeCount).toBe(0);
    expect(result.description).toContain('0');
  });

  // ── Branch: insufficient history (1–4 trades)

  it('returns method="none" when there are 4 trades (below threshold of 5)', () => {
    const trades = tradesWithPnls([10, -5, 20, -3]);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('none');
    expect(result.var95).toBe(0);
    expect(result.var99).toBe(0);
    expect(result.tradeCount).toBe(4);
    expect(result.description).toContain('4');
  });

  // ── Branch: parametric (5–19 trades)

  it('uses parametric method when there are 5 trades', () => {
    const trades = tradesWithPnls([10, -5, 8, -12, 3]);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('parametric');
    expect(result.var95).toBeGreaterThan(0);
    expect(result.var99).toBeGreaterThanOrEqual(result.var95);
    expect(result.tradeCount).toBe(5);
  });

  it('uses parametric method when there are 19 trades', () => {
    const pnls = Array.from({ length: 19 }, (_, i) => (i % 3 === 0 ? -10 : 5));
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('parametric');
    expect(result.tradeCount).toBe(19);
  });

  // ── Branch: historical (≥20 trades)

  it('uses historical method when there are 20 trades', () => {
    const pnls = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? -15 : 6));
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('historical');
    expect(result.var95).toBeGreaterThan(0);
    expect(result.var99).toBeGreaterThanOrEqual(result.var95);
    expect(result.tradeCount).toBe(20);
  });

  it('uses historical method when there are 50 trades', () => {
    const pnls = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? -20 : 4));
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('historical');
    expect(result.tradeCount).toBe(50);
  });

  // ── Percentages

  it('computes var95Pct and var99Pct relative to STARTING_BALANCE_USDT', () => {
    const pnls = Array.from({ length: 25 }, (_, i) => (i % 3 === 0 ? -30 : 10));
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.var95Pct).toBeGreaterThan(0);
    expect(result.var99Pct).toBeGreaterThanOrEqual(result.var95Pct);
    // Verify the percentage relationship: var95Pct = (var95 / 1000) * 100
    expect(result.var95Pct).toBeCloseTo((result.var95 / 1000) * 100, 5);
  });

  // ── Expected Shortfall (CVaR)

  it('computes expectedShortfall from actual tail losses when available', () => {
    // Craft returns where some are clearly below -var95
    const pnls = Array.from({ length: 30 }, (_, i) => i < 5 ? -100 - i * 10 : 5);
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('historical');
    expect(result.expectedShortfall).toBeGreaterThan(0);
    // Should be average of tail losses, not the 1.3 approximation
    expect(result.expectedShortfall).toBeGreaterThan(result.var95);
  });

  it('falls back to var95 * 1.3 approximation when no losses exceed VaR95', () => {
    // Small positive returns → var95 may be near zero, no losses exceed it
    const pnls = Array.from({ length: 10 }, () => 0.01);
    const trades = tradesWithPnls(pnls);
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('parametric');
    // With tiny positive returns, CVaR should use the approximation
    expect(result.expectedShortfall).toBeCloseTo(result.var95 * 1.3, 5);
  });

  // ── Description string

  it('includes method, trade count, and dollar amounts in description', () => {
    const trades = tradesWithPnls(Array.from({ length: 20 }, (_, i) => i % 3 - 1));
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.description).toContain('historical');
    expect(result.description).toContain('20 trades');
    expect(result.description).toContain('95%=$');
    expect(result.description).toContain('99%=$');
    expect(result.description).toContain('CVaR=$');
  });

  // ── Edge: trades with undefined pnl (should be treated as 0)

  it('handles trades with undefined pnl gracefully', () => {
    const trades = Array.from({ length: 6 }, () => makeClosedTrade({ pnl: undefined }));
    const result = computeVaR(makePairState({ closedTrades: trades }));
    expect(result.method).toBe('parametric');
    // All pnl values treated as 0, so var should be 0 (no deviation)
    expect(result.var95).toBe(0);
    expect(result.var99).toBe(0);
  });
});

// ── computePortfolioVaR ─────────────────────────────────────

describe('computePortfolioVaR', () => {
  it('returns method="none" with empty pairStates map', () => {
    const result = computePortfolioVaR(new Map(), new Map());
    expect(result.method).toBe('none');
    expect(result.var95).toBe(0);
    expect(result.var99).toBe(0);
    expect(result.totalExposure).toBe(0);
    expect(result.exposurePct).toBe(0);
    expect(Object.keys(result.pairBreakdown)).toHaveLength(0);
    expect(result.tradeCount).toBe(0);
  });

  it('aggregates returns from multiple pairs for portfolio VaR', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls([10, -5, 8, -3, 6]),
      currentPrice: 50000,
    }));
    pairStates.set('ETH/USDT', makePairState({
      pair: 'ETH/USDT',
      closedTrades: tradesWithPnls([5, -2, 7, -1, 3]),
      currentPrice: 3000,
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    // 10 total trades → parametric (5–19 range) for portfolio
    expect(result.method).toBe('parametric');
    expect(result.tradeCount).toBe(10);
    expect(Object.keys(result.pairBreakdown)).toHaveLength(2);
    expect(result.pairBreakdown['BTC/USDT']).toBeDefined();
    expect(result.pairBreakdown['ETH/USDT']).toBeDefined();
    expect(result.pairBreakdown['BTC/USDT'].tradeCount).toBe(5);
    expect(result.pairBreakdown['ETH/USDT'].tradeCount).toBe(5);
  });

  it('uses historical method when aggregate trades ≥ 20', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls(Array.from({ length: 12 }, (_, i) => i % 3 - 1)),
    }));
    pairStates.set('ETH/USDT', makePairState({
      pair: 'ETH/USDT',
      closedTrades: tradesWithPnls(Array.from({ length: 10 }, (_, i) => i % 4 - 1)),
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.method).toBe('historical');
    expect(result.tradeCount).toBe(22);
  });

  it('computes totalExposure from open positions only', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls([10, -5, 8, -3, 6]),
      positions: [
        makeClosedTrade({ status: 'OPEN', currentUsdtValue: 200 }),
        makeClosedTrade({ status: 'OPEN', currentUsdtValue: 300 }),
        makeClosedTrade({ status: 'CLOSED', currentUsdtValue: 999 }), // not counted
      ],
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.totalExposure).toBe(500); // 200 + 300 only
  });

  it('computes exposurePct as ratio of totalExposure to totalEquity', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      balance: 800,
      closedTrades: tradesWithPnls([10, -5, 8, -3, 6]),
      positions: [
        makeClosedTrade({ status: 'OPEN', currentUsdtValue: 200, quantity: 0.005 }),
      ],
      currentPrice: 50000,
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.totalExposure).toBe(200);
    expect(result.exposurePct).toBeGreaterThan(0);
    expect(result.exposurePct).toBeLessThanOrEqual(100);
  });

  it('uses currentPrices map over state.currentPrice for equity calc', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls([10, -5, 8, -3, 6]),
      positions: [
        makeClosedTrade({
          status: 'OPEN',
          currentUsdtValue: 500,
          quantity: 0.01,
        }),
      ],
      currentPrice: 49000,
      balance: 500,
    }));

    const currentPrices = new Map<string, number>();
    currentPrices.set('BTC/USDT', 51000);

    const resultDefault = computePortfolioVaR(pairStates, new Map());
    const resultOverride = computePortfolioVaR(pairStates, currentPrices);

    // exposurePct = totalExposure / totalEquity * 100 — different prices yield different equity
    expect(resultOverride.exposurePct).not.toBe(resultDefault.exposurePct);
  });

  it('computes portfolio VaR percentages against starting balance × pair count', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls(Array.from({ length: 15 }, (_, i) => i % 3 - 1)),
    }));
    pairStates.set('ETH/USDT', makePairState({
      pair: 'ETH/USDT',
      closedTrades: tradesWithPnls(Array.from({ length: 10 }, (_, i) => i % 2 - 1)),
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    // STARTING_BALANCE_USDT * 2 = 2000
    const expectedVar95Pct = (result.var95 / 2000) * 100;
    expect(result.var95Pct).toBeCloseTo(expectedVar95Pct, 5);
  });

  it('includes expectedShortfall approximation (var95 * 1.3)', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls(Array.from({ length: 10 }, (_, i) => i * 2 - 10)),
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.expectedShortfall).toBeCloseTo(result.var95 * 1.3, 5);
  });

  it('returns zero exposurePct when totalEquity is 0', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      balance: 0,
      closedTrades: tradesWithPnls([10, -5, 8, -3, 6]),
      positions: [],
      currentPrice: 0,
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.exposurePct).toBe(0);
  });

  it('description contains pair count and total trades', () => {
    const pairStates = new Map<string, PairState>();
    pairStates.set('BTC/USDT', makePairState({
      pair: 'BTC/USDT',
      closedTrades: tradesWithPnls([1, 2, 3, 4, 5]),
    }));

    const result = computePortfolioVaR(pairStates, new Map());
    expect(result.description).toContain('1 pairs');
    expect(result.description).toContain('5 total trades');
  });
});
