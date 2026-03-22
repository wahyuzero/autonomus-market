// ============================================================
// VALUE AT RISK (VaR) — Statistical Risk Measurement
//
// VaR answers: "At 95% confidence, what's the maximum I could
// lose in a single trade / single day?"
//
// Methods implemented:
//   Historical VaR  — use actual past trade returns distribution
//   Parametric VaR  — assume normal distribution (fast, approximate)
//
// Example output:
//   "95% VaR = $45 (meaning: 95% of the time, daily loss ≤ $45)"
//   "99% VaR = $87 (there's 1% chance of losing more than $87)"
//
// Used for:
//   - Dashboard risk display
//   - Position sizing verification (don't open if VaR too high)
//   - Portfolio-level risk aggregation
// ============================================================

import { PairState, TradePosition, CONFIG } from '../config';

export interface VaRResult {
  var95: number;         // 95% 1-day VaR in $
  var99: number;         // 99% 1-day VaR in $
  var95Pct: number;      // As % of starting balance
  var99Pct: number;
  method: 'historical' | 'parametric' | 'none';
  tradeCount: number;
  expectedShortfall: number; // CVaR: average loss beyond VaR95
  description: string;
}

export interface PortfolioVaR extends VaRResult {
  totalExposure: number;      // Total USDT in open positions
  exposurePct: number;        // As % of total portfolio equity
  pairBreakdown: Record<string, VaRResult>;
}

// ============================================================
// HISTORICAL VaR (Preferred method when enough trades exist)
// ============================================================
function historicalVaR(returns: number[], confidenceLevels = [0.95, 0.99]): number[] {
  if (returns.length < 5) return [0, 0];
  const sorted = [...returns].sort((a, b) => a - b); // Sort ascending (worst first)
  return confidenceLevels.map(level => {
    const idx = Math.floor((1 - level) * sorted.length);
    return Math.abs(sorted[Math.max(0, idx)]);
  });
}

// ============================================================
// PARAMETRIC VaR (Gaussian assumption)
// ============================================================
function parametricVaR(returns: number[]): { var95: number; var99: number } {
  if (returns.length < 3) return { var95: 0, var99: 0 };
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  // Z-scores: 1.645 for 95%, 2.326 for 99%
  return {
    var95: Math.abs(avg - 1.645 * stdDev),
    var99: Math.abs(avg - 2.326 * stdDev),
  };
}

// ============================================================
// COMPUTE PER-PAIR VaR
// ============================================================
export function computeVaR(state: PairState): VaRResult {
  const trades = state.closedTrades;
  const balance = CONFIG.TRADING.STARTING_BALANCE_USDT;

  if (trades.length < 5) {
    return {
      var95: 0, var99: 0, var95Pct: 0, var99Pct: 0,
      method: 'none', tradeCount: trades.length,
      expectedShortfall: 0, description: `Need ≥5 trades (have ${trades.length})`,
    };
  }

  const returns = trades.map(t => t.pnl ?? 0);

  let var95: number, var99: number, method: VaRResult['method'];

  if (trades.length >= 20) {
    // Historical VaR (better with more data)
    const [v95, v99] = historicalVaR(returns);
    var95 = v95; var99 = v99; method = 'historical';
  } else {
    // Parametric (fewer trades)
    const pVar = parametricVaR(returns);
    var95 = pVar.var95; var99 = pVar.var99; method = 'parametric';
  }

  // Expected Shortfall (CVaR) — average of losses beyond VaR95
  const lossesAboveVaR = returns.filter(r => r < -var95).map(r => Math.abs(r));
  const expectedShortfall = lossesAboveVaR.length > 0
    ? lossesAboveVaR.reduce((a, b) => a + b, 0) / lossesAboveVaR.length
    : var95 * 1.3; // Approximate if no data points

  const var95Pct = (var95 / balance) * 100;
  const var99Pct = (var99 / balance) * 100;

  return {
    var95, var99, var95Pct, var99Pct, method, tradeCount: trades.length,
    expectedShortfall,
    description: `${method} VaR (${trades.length} trades): 95%=$${var95.toFixed(2)} | 99%=$${var99.toFixed(2)} | CVaR=$${expectedShortfall.toFixed(2)}`,
  };
}

// ============================================================
// PORTFOLIO-LEVEL VaR
// ============================================================
export function computePortfolioVaR(
  pairStates: Map<string, PairState>,
  currentPrices: Map<string, number>
): PortfolioVaR {
  const pairBreakdown: Record<string, VaRResult> = {};
  let totalExposure = 0;
  let totalEquity = 0;
  let allReturns: number[] = [];

  for (const [pair, state] of pairStates) {
    const varResult = computeVaR(state);
    pairBreakdown[pair] = varResult;
    allReturns = [...allReturns, ...state.closedTrades.map(t => t.pnl ?? 0)];

    // Open position exposure
    for (const pos of state.positions) {
      if (pos.status === 'OPEN') totalExposure += pos.currentUsdtValue;
    }

    const price = currentPrices.get(pair) ?? state.currentPrice;
    const balance = state.balance;
    const unrealized = state.positions.reduce((s, p) => s + (p.quantity * price - p.currentUsdtValue), 0);
    totalEquity += balance + state.positions.reduce((s, p) => s + p.currentUsdtValue, 0) + unrealized;
  }

  // Portfolio VaR (diversification reduces total risk)
  const [portfolioVar95, portfolioVar99] = allReturns.length >= 5
    ? historicalVaR(allReturns) : [0, 0];
  const startingTotal = CONFIG.TRADING.STARTING_BALANCE_USDT * pairStates.size;

  return {
    var95: portfolioVar95,
    var99: portfolioVar99,
    var95Pct: (portfolioVar95 / startingTotal) * 100,
    var99Pct: (portfolioVar99 / startingTotal) * 100,
    method: allReturns.length >= 20 ? 'historical' : allReturns.length >= 5 ? 'parametric' : 'none',
    tradeCount: allReturns.length,
    expectedShortfall: portfolioVar95 * 1.3,
    description: `Portfolio VaR: ${pairStates.size} pairs, ${allReturns.length} total trades`,
    totalExposure,
    exposurePct: totalEquity > 0 ? (totalExposure / totalEquity) * 100 : 0,
    pairBreakdown,
  };
}
