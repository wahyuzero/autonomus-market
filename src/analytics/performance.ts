// ============================================================
// PERFORMANCE ANALYTICS — Professional Metrics
//
// Computes: Sharpe, Sortino, Calmar, Max Drawdown,
//           Profit Factor, Expectancy, Win Rate, Avg R
// ============================================================

import { PairState, TradePosition, CONFIG } from '../config';

export interface PerformanceMetrics {
  // Core stats
  totalTrades: number;
  winRate: number;           // %
  avgWin: number;            // $ avg winning trade
  avgLoss: number;           // $ avg losing trade

  // Ratios
  profitFactor: number;      // Gross profit / Gross loss
  expectancy: number;        // Expected $ per trade
  avgR: number;              // Avg return in R-multiples

  // Risk-adjusted
  sharpeRatio: number;       // Return / Total StdDev
  sortinoRatio: number;      // Return / Downside StdDev
  calmarRatio: number;       // Annual Return / Max Drawdown

  // Drawdown
  maxDrawdownPct: number;    // Peak-to-trough %
  maxDrawdownDollar: number; // Peak-to-trough $
  currentDrawdownPct: number;
  recoveryFactor: number;    // Total Profit / Max Drawdown

  // Streak
  currentWinStreak: number;
  currentLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;

  // Daily loss circuit breaker
  dailyPnl: number;
  dailyLossLimitHit: boolean;
  tradingHalted: boolean;
}

export interface PortfolioMetrics extends PerformanceMetrics {
  totalEquity: number;
  totalPnl: number;
  totalPnlPct: number;
  pairMetrics: Record<string, PerformanceMetrics>;
}

// ============================================================
// COMPUTE PER-PAIR METRICS
// ============================================================
export function computePairMetrics(state: PairState, dailyState: DailyTradingState): PerformanceMetrics {
  const trades = state.closedTrades;
  const balance = CONFIG.TRADING.STARTING_BALANCE_USDT;

  if (trades.length === 0) {
    return emptyMetrics();
  }

  const pnls = trades.map(t => t.pnl ?? 0);
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) <= 0);

  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  const winRate01 = winRate / 100;
  const expectancy = (winRate01 * avgWin) - ((1 - winRate01) * avgLoss);

  // Sharpe Ratio (annualized approximation from trade returns)
  const returns = pnls.map(p => p / balance);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  // Sortino Ratio (only penalizes downside)
  const downsideReturns = returns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length : 0;
  const downsideStdDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideStdDev > 0 ? (avgReturn / downsideStdDev) * Math.sqrt(252) : 0;

  // Max Drawdown
  const { maxDrawdownPct, maxDrawdownDollar, currentDrawdownPct } = computeDrawdown(trades, balance);

  // Calmar Ratio
  const totalReturn = (state.totalPnl / balance) * 100;
  const calmarRatio = maxDrawdownPct > 0 ? totalReturn / maxDrawdownPct : 0;

  // Recovery Factor
  const recoveryFactor = maxDrawdownDollar > 0 ? state.totalPnl / maxDrawdownDollar : 0;

  // R-multiple
  const avgR = avgLoss > 0 ? expectancy / avgLoss : 0;

  // Streaks
  const { currentWin, currentLoss, maxWin, maxLoss } = computeStreaks(trades);

  // Daily PnL
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailyTrades = trades.filter(t => (t.closeTime ?? 0) >= todayStart.getTime());
  const dailyPnl = dailyTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const dailyLossLimitPct = CONFIG.TRADING.DAILY_LOSS_LIMIT_PCT;
  const dailyLossLimitHit = dailyPnl < -(balance * dailyLossLimitPct / 100);

  return {
    totalTrades: trades.length, winRate, avgWin, avgLoss,
    profitFactor, expectancy, avgR,
    sharpeRatio, sortinoRatio, calmarRatio,
    maxDrawdownPct, maxDrawdownDollar, currentDrawdownPct, recoveryFactor,
    currentWinStreak: currentWin, currentLossStreak: currentLoss,
    maxWinStreak: maxWin, maxLossStreak: maxLoss,
    dailyPnl, dailyLossLimitHit,
    tradingHalted: dailyState.halted,
  };
}

// ============================================================
// DRAWDOWN CALCULATION
// ============================================================
function computeDrawdown(trades: TradePosition[], startBalance: number) {
  let equity = startBalance;
  let peak = startBalance;
  let maxDrawdownDollar = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    equity += trade.pnl ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdownDollar) {
      maxDrawdownDollar = dd;
      maxDrawdownPct = ddPct;
    }
  }

  const currentDD = Math.max(0, peak - equity);
  const currentDrawdownPct = peak > 0 ? (currentDD / peak) * 100 : 0;

  return { maxDrawdownPct, maxDrawdownDollar, currentDrawdownPct };
}

// ============================================================
// STREAK CALCULATION
// ============================================================
function computeStreaks(trades: TradePosition[]) {
  let currentWin = 0, currentLoss = 0, maxWin = 0, maxLoss = 0;
  let winStreak = 0, lossStreak = 0;

  for (const t of trades) {
    if ((t.pnl ?? 0) > 0) {
      winStreak++; lossStreak = 0;
      maxWin = Math.max(maxWin, winStreak);
    } else {
      lossStreak++; winStreak = 0;
      maxLoss = Math.max(maxLoss, lossStreak);
    }
  }
  return { currentWin: winStreak, currentLoss: lossStreak, maxWin, maxLoss };
}

// ============================================================
// DAILY TRADING STATE (Circuit Breaker)
// ============================================================
export interface DailyTradingState {
  date: string;          // YYYY-MM-DD
  startBalance: number;
  pnlToday: number;
  tradesCount: number;
  halted: boolean;       // Trading halted for today
  haltReason: string;
  consecutiveLosses: number;
}

const dailyStates: Map<string, DailyTradingState> = new Map();

export function getDailyState(pair: string): DailyTradingState {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${pair}-${today}`;

  if (!dailyStates.has(key)) {
    dailyStates.set(key, {
      date: today,
      startBalance: CONFIG.TRADING.STARTING_BALANCE_USDT,
      pnlToday: 0,
      tradesCount: 0,
      halted: false,
      haltReason: '',
      consecutiveLosses: 0,
    });
  }
  return dailyStates.get(key)!;
}

export function recordTrade(pair: string, pnl: number): { halted: boolean; reason: string } {
  const state = getDailyState(pair);
  state.pnlToday += pnl;
  state.tradesCount++;

  if (pnl < 0) {
    state.consecutiveLosses++;
  } else {
    state.consecutiveLosses = 0;
  }

  // Circuit breaker 1: Daily loss limit
  const dailyLossPct = CONFIG.TRADING.DAILY_LOSS_LIMIT_PCT;
  if (state.pnlToday < -(state.startBalance * dailyLossPct / 100)) {
    state.halted = true;
    state.haltReason = `Daily loss limit hit: ${state.pnlToday.toFixed(2)}$ (>${dailyLossPct}%)`;
    console.log(`[${pair}] 🚨 DAILY LOSS LIMIT — Trading halted for today. Loss: $${state.pnlToday.toFixed(2)}`);
    return { halted: true, reason: state.haltReason };
  }

  // Circuit breaker 2: Consecutive losses
  if (state.consecutiveLosses >= CONFIG.TRADING.MAX_CONSECUTIVE_LOSSES) {
    state.halted = true;
    state.haltReason = `${state.consecutiveLosses} consecutive losses — cooling off`;
    console.log(`[${pair}] ⚠️ ${state.consecutiveLosses} consecutive losses — pausing trading`);
    return { halted: true, reason: state.haltReason };
  }

  return { halted: false, reason: '' };
}

export function isTradingHalted(pair: string): boolean {
  return getDailyState(pair).halted;
}

// ============================================================
// PERSISTENCE BRIDGE — read / restore daily circuit-breaker state
// ============================================================

/** Snapshot the entire daily-states map (safe for JSON serialization). */
export function getDailyStates(): Map<string, DailyTradingState> {
  return new Map(dailyStates);
}

/** Replace the in-memory daily-states map with persisted data. */
export function restoreDailyStates(data: Map<string, DailyTradingState>): void {
  dailyStates.clear();
  for (const [k, v] of data) {
    dailyStates.set(k, { ...v });
  }
}

// ============================================================
// PORTFOLIO ANALYTICS
// ============================================================
export function computePortfolioMetrics(
  pairStates: Map<string, PairState>,
  currentPrices: Map<string, number>
): PortfolioMetrics {
  const pairMetrics: Record<string, PerformanceMetrics> = {};
  let aggregateTrades: TradePosition[] = [];
  let totalEquity = 0;
  let totalPnl = 0;

  for (const [pair, state] of pairStates) {
    const daily = getDailyState(pair);
    const metrics = computePairMetrics(state, daily);
    pairMetrics[pair] = metrics;
    aggregateTrades = [...aggregateTrades, ...state.closedTrades];
    totalPnl += state.totalPnl;
    const price = currentPrices.get(pair) ?? state.currentPrice;
    const unrealized = state.positions.reduce((s, p) => s + (p.quantity * price - p.currentUsdtValue), 0);
    totalEquity += state.balance + state.positions.reduce((s, p) => s + p.currentUsdtValue, 0) + unrealized;
  }

  const startingTotal = CONFIG.TRADING.STARTING_BALANCE_USDT * pairStates.size;
  const tempState = {
    pair: 'PORTFOLIO', balance: startingTotal, positions: [],
    closedTrades: aggregateTrades, totalPnl, totalPnlPct: 0, winRate: 0,
    strategy: {} as any, currentPrice: 0, isAnalyzing: false, correctionCount: 0,
  };
  const dailyState = { date: '', startBalance: startingTotal, pnlToday: 0, tradesCount: 0, halted: false, haltReason: '', consecutiveLosses: 0 };
  const portfolio = computePairMetrics(tempState as any, dailyState);

  return {
    ...portfolio,
    totalEquity,
    totalPnl,
    totalPnlPct: (totalPnl / startingTotal) * 100,
    pairMetrics,
  };
}

function emptyMetrics(): PerformanceMetrics {
  return {
    totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
    profitFactor: 0, expectancy: 0, avgR: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    maxDrawdownPct: 0, maxDrawdownDollar: 0, currentDrawdownPct: 0, recoveryFactor: 0,
    currentWinStreak: 0, currentLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0,
    dailyPnl: 0, dailyLossLimitHit: false, tradingHalted: false,
  };
}
