// ============================================================
// BACKTESTING ENGINE — Strategy Replay on Historical Candles
//
// A simplified walk-forward backtester that:
//   1. Replays historical candles through the signal logic
//   2. Simulates entries/exits with multi-TP rules
//   3. Computes performance metrics on the result
//
// NOT a full backtester (no AI calls — uses technical signals only)
// Purpose: validate strategy parameters before deploying live
//
// Usage:
//   const result = await runBacktest(candles, config);
//   → { trades, performance, recommendation }
// ============================================================

import { Candle, CONFIG, TechnicalSummary } from '../config';
import { computeTechnicals } from '../analysis/technical';

export interface BacktestTrade {
  direction: 'BUY';
  entryIndex: number;
  entryPrice: number;
  exitPrice: number;
  exitIndex: number;
  exitReason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'END';
  pnl: number;
  pnlPct: number;
  holdingCandles: number;
  atr: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldingCandles: number;
  bestTrade: number;
  worstTrade: number;
  recommendation: string;
  configUsed: { signalThreshold: number; atrMultiplierSL: number };
}

// ============================================================
// CORE BACKTEST RUNNER
// ============================================================
export async function runBacktest(
  candles: Candle[],
  options: {
    signalThreshold?: number;   // Min confluence score to enter (default: 60)
    atrSLMultiplier?: number;   // SL = entry - ATR × mult (default: 2.0)
    tp1ATR?: number;            // TP1 = entry + ATR × mult (default: 1.5)
    tp2ATR?: number;
    tp3ATR?: number;
    startingBalance?: number;
  } = {}
): Promise<BacktestResult> {
  const signalThreshold = options.signalThreshold ?? 60;
  const atrSLMult = options.atrSLMultiplier ?? 2.0;
  const tp1ATR = options.tp1ATR ?? CONFIG.TRADING.MULTI_TP.TP1_ATR;
  const tp2ATR = options.tp2ATR ?? CONFIG.TRADING.MULTI_TP.TP2_ATR;
  const tp3ATR = options.tp3ATR ?? CONFIG.TRADING.MULTI_TP.TP3_ATR;
  const startBal = options.startingBalance ?? CONFIG.TRADING.STARTING_BALANCE_USDT;

  const LOOKBACK = 60; // Candles needed for warmup
  const trades: BacktestTrade[] = [];

  let balance = startBal;
  let inTrade = false;
  let peakBalance = startBal;
  let maxDD = 0;

  for (let i = LOOKBACK; i < candles.length - 1; i++) {
    const windowCandles = candles.slice(0, i + 1);

    // Skip computation every candle (sample every 3 for speed)
    if (!inTrade && i % 3 !== 0) continue;

    let tech: TechnicalSummary | null = null;
    try {
      tech = computeTechnicals(windowCandles);
    } catch {
      continue;
    }

    if (!tech) continue;

    // Entry condition: score >= threshold + bullish structure
    if (!inTrade && tech.score >= signalThreshold && tech.trend === 'BULLISH') {
      const entry = candles[i].close;
      const atr = tech.atr > 0 ? tech.atr : entry * 0.01;

      const sl = entry - atrSLMult * atr;
      const tp1 = entry + tp1ATR * atr;
      const tp2 = entry + tp2ATR * atr;
      const tp3 = entry + tp3ATR * atr;

      // Simulate forward until exit
      let exitIndex = i + 1;
      let exitPrice = entry;
      let exitReason: BacktestTrade['exitReason'] = 'END';

      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        if (c.low <= sl) { exitPrice = sl; exitReason = 'SL'; exitIndex = j; break; }
        if (c.high >= tp3) { exitPrice = tp3; exitReason = 'TP3'; exitIndex = j; break; }
        if (c.high >= tp2) { exitPrice = tp2; exitReason = 'TP2'; exitIndex = j; break; }
        if (c.high >= tp1) { exitPrice = tp1; exitReason = 'TP1'; exitIndex = j; break; }
      }

      const posSize = balance * 0.2; // 20% position
      const pnlPct = ((exitPrice - entry) / entry) * 100;
      const pnl = posSize * (pnlPct / 100);

      trades.push({
        direction: 'BUY',
        entryIndex: i, entryPrice: entry,
        exitIndex, exitPrice, exitReason,
        pnl, pnlPct, holdingCandles: exitIndex - i, atr,
      });

      balance += pnl;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDD) maxDD = dd;

      i = exitIndex; // Skip to after trade
      inTrade = false;
    }
  }

  if (trades.length === 0) {
    return {
      trades: [], totalTrades: 0, winRate: 0, profitFactor: 0,
      totalPnl: 0, totalPnlPct: 0, maxDrawdownPct: 0, sharpeRatio: 0,
      avgHoldingCandles: 0, bestTrade: 0, worstTrade: 0,
      recommendation: '⚠️ No trades generated. Lower signalThreshold or provide more candles.',
      configUsed: { signalThreshold, atrMultiplierSL: atrSLMult },
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const totalPnl = balance - startBal;
  const totalPnlPct = (totalPnl / startBal) * 100;
  const avgHolding = trades.reduce((s, t) => s + t.holdingCandles, 0) / trades.length;

  // Sharpe (simplified annualized from trade returns)
  const tradeReturns = trades.map(t => t.pnlPct / 100);
  const avgR = tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length;
  const variance = tradeReturns.reduce((s, r) => s + Math.pow(r - avgR, 2), 0) / tradeReturns.length;
  const sharpe = variance > 0 ? (avgR / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  const bestTrade = Math.max(...trades.map(t => t.pnl));
  const worstTrade = Math.min(...trades.map(t => t.pnl));

  let recommendation = '';
  if (profitFactor >= 1.5 && winRate >= 50) recommendation = '✅ Strategy shows edge. Consider deploying.';
  else if (profitFactor >= 1.2) recommendation = '⚡ Marginal edge. Monitor closely before scaling.';
  else recommendation = '❌ No significant edge. Tune parameters or wait for better market conditions.';

  return {
    trades, totalTrades: trades.length, winRate, profitFactor,
    totalPnl, totalPnlPct, maxDrawdownPct: maxDD, sharpeRatio: sharpe,
    avgHoldingCandles: avgHolding, bestTrade, worstTrade, recommendation,
    configUsed: { signalThreshold, atrMultiplierSL: atrSLMult },
  };
}

// ============================================================
// LOG RESULTS
// ============================================================
export function logBacktestResult(pair: string, result: BacktestResult): void {
  console.log(`\n[Backtest] ════ ${pair} ════════════════════`);
  console.log(`[Backtest] Trades: ${result.totalTrades} | WR: ${result.winRate.toFixed(0)}% | PF: ${result.profitFactor.toFixed(2)}`);
  console.log(`[Backtest] PnL: ${result.totalPnl >= 0 ? '+' : ''}$${result.totalPnl.toFixed(2)} (${result.totalPnlPct.toFixed(1)}%) | MaxDD: ${result.maxDrawdownPct.toFixed(1)}%`);
  console.log(`[Backtest] Sharpe: ${result.sharpeRatio.toFixed(2)} | Avg Hold: ${result.avgHoldingCandles.toFixed(0)} candles`);
  console.log(`[Backtest] ${result.recommendation}`);
}
