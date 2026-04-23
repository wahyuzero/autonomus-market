// ============================================================
// DASHBOARD SERVER - HTTP + WebSocket for real-time UI
// ============================================================

import express from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
import { Request, Response, NextFunction } from 'express';
import { CONFIG, SourceStatus, getPairType, getModeConfig } from '../config';
import { orchestratorEmitter, pairStates, getPortfolioSummary } from '../engine/orchestrator';
import { getTotalEquity, getUnrealizedPnl } from '../trading/simulator';
import { computePortfolioMetrics } from '../analytics/performance';
import { getSourceStatus as getCryptoStatus, buildCryptoMarketData } from '../data/crypto';
import { getSourceStatus as getForexStatus, buildForexMarketData } from '../data/forex';
import { getSourceStatus as getCommodityStatus, buildCommodityMarketData } from '../data/commodity';
import { getSourceStatus as getCalendarStatus } from '../data/calendar';
import { runBacktest, BacktestResult } from '../analytics/backtest';

export function gatherSourceStatuses(): SourceStatus[] {
  return [getCryptoStatus(), getForexStatus(), getCommodityStatus(), getCalendarStatus()];
}

export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const requiredToken = CONFIG.DASHBOARD.AUTH_TOKEN;
  if (!requiredToken) return next();

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;

  if (headerToken === requiredToken || queryToken === requiredToken) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================
// BACKTEST FOR PAIR — fetches candles on-demand, runs backtest
// ============================================================

export interface BacktestEndpointOptions {
  interval?: string;
  signalThreshold?: number;
  atrSLMultiplier?: number;
  tp1ATR?: number;
  tp2ATR?: number;
  tp3ATR?: number;
  startingBalance?: number;
}

export async function runBacktestForPair(
  pair: string,
  options: BacktestEndpointOptions = {},
): Promise<{ pair: string; result: BacktestResult } | { error: string }> {
  const pairType = getPairType(pair);
  const interval = options.interval ?? getModeConfig().PRIMARY_INTERVAL;

  let marketData;
  try {
    if (pairType === 'commodity') marketData = await buildCommodityMarketData(pair);
    else if (pairType === 'forex') marketData = await buildForexMarketData(pair);
    else marketData = await buildCryptoMarketData(pair);
  } catch {
    return { error: `Failed to fetch market data for ${pair}` };
  }

  if (!marketData) return { error: `No market data available for ${pair}` };

  const candles =
    marketData.candles[interval]
    ?? marketData.candles['1h']
    ?? marketData.candles['15m']
    ?? [];

  if (candles.length < 60) {
    return { error: `Insufficient candles (${candles.length}) for ${pair} at ${interval}. Need ≥60.` };
  }

  const result = await runBacktest(candles, {
    signalThreshold: options.signalThreshold,
    atrSLMultiplier: options.atrSLMultiplier,
    tp1ATR: options.tp1ATR,
    tp2ATR: options.tp2ATR,
    tp3ATR: options.tp3ATR,
    startingBalance: options.startingBalance,
  });

  return { pair, result };
}

export function startDashboard(): void {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  app.use('/api', dashboardAuth);

  app.get('/api/state', (req, res) => {
    res.json(buildStatePayload());
  });

  app.get('/api/summary', (req, res) => {
    res.json(getPortfolioSummary());
  });

  app.get('/api/performance-history', (req, res) => {
    const dailyMap = new Map<string, { pnl: number; trades: number; wins: number }>();

    for (const [, state] of pairStates) {
      for (const trade of state.closedTrades) {
        if (!trade.closeTime) continue;
        const date = new Date(trade.closeTime).toISOString().split('T')[0];
        const entry = dailyMap.get(date) || { pnl: 0, trades: 0, wins: 0 };
        entry.pnl += trade.pnl || 0;
        entry.trades++;
        if ((trade.pnl || 0) > 0) entry.wins++;
        dailyMap.set(date, entry);
      }
    }

    const sorted = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-30);

    let cumulative = 0;
    const history = sorted.map(([date, data]) => {
      cumulative += data.pnl;
      return { date, pnl: data.pnl, trades: data.trades, wins: data.wins, cumulativePnl: cumulative };
    });

    res.json(history);
  });

  app.get('/api/stats', (req, res) => {
    const stats = { tp1: 0, tp2: 0, tp3: 0, swingSL: 0, initialSL: 0, breakevenSL: 0, timeExit: 0, postTP1SL: 0, postTP2SL: 0 };

    const allTrades: any[] = [];
    for (const [, state] of pairStates) {
      for (const trade of state.closedTrades) {
        allTrades.push({ ...trade, pair: state.pair });
      }
    }

    if (allTrades.length === 0) {
      res.json({ ...stats, totalTrades: 0, winCount: 0, lossCount: 0, avgWin: 0, avgLoss: 0, bestTrade: null, worstTrade: null });
      return;
    }

    let totalWin = 0, totalLoss = 0, winCount = 0, lossCount = 0;
    let bestTrade = allTrades[0], worstTrade = allTrades[0];

    for (const trade of allTrades) {
      const pnl = trade.pnl || 0;
      if (pnl > 0) { totalWin += pnl; winCount++; }
      else if (pnl < 0) { totalLoss += Math.abs(pnl); lossCount++; }

      if (pnl > (bestTrade.pnl || 0)) bestTrade = trade;
      if (pnl < (worstTrade.pnl || 0)) worstTrade = trade;

      for (const pc of (trade.partialCloses || [])) {
        if (pc.phase === 'TP1') stats.tp1++;
        if (pc.phase === 'TP2') stats.tp2++;
        if (pc.phase === 'TP3') stats.tp3++;
      }

      const reason = (trade.reason || '').toLowerCase();
      if (reason.includes('swing trailing')) stats.swingSL++;
      if (reason.includes('stop loss (initial)')) stats.initialSL++;
      if (reason.includes('breakeven stop')) stats.breakevenSL++;
      if (reason.includes('time-based')) stats.timeExit++;
      if (reason.includes('locked profit after tp1') || reason.includes('post_tp1')) stats.postTP1SL++;
      if (reason.includes('locked profit after tp2') || reason.includes('post_tp2')) stats.postTP2SL++;
    }

    res.json({
      ...stats,
      totalTrades: allTrades.length,
      winCount, lossCount,
      avgWin: winCount > 0 ? totalWin / winCount : 0,
      avgLoss: lossCount > 0 ? totalLoss / lossCount : 0,
      bestTrade: bestTrade ? { pair: bestTrade.pair, pnl: bestTrade.pnl, pnlPct: bestTrade.pnlPct } : null,
      worstTrade: worstTrade ? { pair: worstTrade.pair, pnl: worstTrade.pnl, pnlPct: worstTrade.pnlPct } : null,
    });
  });

  app.get('/api/signals', (req, res) => {
    const signals: any[] = [];

    for (const [, state] of pairStates) {
      for (const pos of state.positions) {
        signals.push({
          id: pos.id,
          pair: state.pair,
          type: pos.type,
          status: 'ACTIVE',
          entryPrice: pos.entryPrice,
          currentPrice: state.currentPrice,
          tp1: pos.tp1, tp2: pos.tp2, tp3: pos.tp3,
          stopLoss: pos.stopLoss,
          tpPhase: pos.tpPhase,
          confidence: state.lastAnalysis?.confidence,
          score: state.lastAnalysis?.technical?.score,
          signal: state.lastAnalysis?.signal,
          openTime: pos.openTime,
          pnl: pos.pnl,
          unrealizedPnl: pos.quantity * (state.currentPrice - pos.entryPrice),
        });
      }

      for (const trade of state.closedTrades) {
        signals.push({
          id: trade.id,
          pair: state.pair,
          type: trade.type,
          status: (trade.pnl || 0) >= 0 ? 'TP' : 'SL',
          entryPrice: trade.entryPrice,
          closePrice: trade.closePrice,
          tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3,
          stopLoss: trade.stopLoss,
          tpPhase: trade.tpPhase,
          openTime: trade.openTime,
          closeTime: trade.closeTime,
          pnl: trade.pnl,
          pnlPct: trade.pnlPct,
          reason: trade.reason,
        });
      }
    }

    signals.sort((a, b) => (b.openTime || 0) - (a.openTime || 0));
    res.json(signals);
  });

  app.get('/api/data-sources', (_req, res) => {
    res.json(gatherSourceStatuses());
  });

  app.get('/api/var', (_req, res) => {
    const currentPrices = new Map(Array.from(pairStates.entries()).map(([k, v]) => [k, v.currentPrice]));
    res.json(computePortfolioVaR(pairStates, currentPrices));
  });

  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[Dashboard] Client connected (total: ${clients.size})`);

    ws.send(JSON.stringify({ type: 'state', data: buildStatePayload() }));

    ws.on('close', () => {
      clients.delete(ws);
    });
  });

  function broadcast(event: string, data: any) {
    const msg = JSON.stringify({ type: event, data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  setInterval(() => {
    if (clients.size > 0) {
      broadcast('state', buildStatePayload());
    }
  }, CONFIG.DASHBOARD.WS_BROADCAST_INTERVAL_MS);

  function buildStatePayload() {
  const pairs = Array.from(pairStates.values()).map(state => {
    const equity = getTotalEquity(state, state.currentPrice);
    const unrealized = getUnrealizedPnl(state, state.currentPrice);
    return {
      pair: state.pair,
      price: state.currentPrice,
      balance: state.balance,
      equity,
      openPositions: state.positions.length,
      closedTrades: state.closedTrades.length,
      totalPnl: state.totalPnl,
      totalPnlPct: state.totalPnlPct,
      unrealizedPnl: unrealized,
      winRate: state.winRate,
      isAnalyzing: state.isAnalyzing,
      correctionCount: state.correctionCount,
      strategy: state.strategy.name,
      signal: state.lastAnalysis?.signal ?? 'HOLD',
      confidence: state.lastAnalysis?.confidence ?? 0,
      reasoning: state.lastAnalysis?.reasoning?.slice(0, 300) ?? '',
      technicalScore: state.lastAnalysis?.technical?.score ?? 0,
      trend: state.lastAnalysis?.technical?.trend ?? 'NEUTRAL',
      positions: state.positions.map(p => ({
        id: p.id, type: p.type, entryPrice: p.entryPrice,
        tp1: p.tp1, tp2: p.tp2, tp3: p.tp3,
        stopLoss: p.stopLoss, tpPhase: p.tpPhase,
        pnl: p.pnl, pyramidLayer: p.pyramidLayer,
        usdtValue: p.usdtValue, quantity: p.quantity,
        currentUsdtValue: p.currentUsdtValue, atr: p.atr,
      })),
    };
  });

  const currentPrices = new Map(Array.from(pairStates.entries()).map(([k, v]) => [k, v.currentPrice]));
  const portfolioMetrics = computePortfolioMetrics(pairStates, currentPrices);

  const baseSummary = getPortfolioSummary();

  return {
    pairs,
    summary: {
      ...baseSummary,
      analytics: {
        sharpeRatio: portfolioMetrics.sharpeRatio,
        sortinoRatio: portfolioMetrics.sortinoRatio,
        calmarRatio: portfolioMetrics.calmarRatio,
        maxDrawdownPct: portfolioMetrics.maxDrawdownPct,
        profitFactor: portfolioMetrics.profitFactor,
        expectancy: portfolioMetrics.expectancy,
        avgR: portfolioMetrics.avgR,
        tradingHalted: portfolioMetrics.tradingHalted,
      },
      totalEquity: baseSummary.totalEquity,
      onlineUsers: clients.size,
    },
    dataSources: gatherSourceStatuses(),
    timestamp: Date.now(),
  };
  }

  orchestratorEmitter.on('trade-opened', (data) => broadcast('trade-opened', data));
  orchestratorEmitter.on('trade-closed', (data) => broadcast('trade-closed', data));
  orchestratorEmitter.on('self-corrected', (data) => broadcast('self-corrected', data));
  orchestratorEmitter.on('pair-analyzed', (data) => broadcast('pair-analyzed', data));
  orchestratorEmitter.on('cycle-complete', (data) => broadcast('cycle', data));
  orchestratorEmitter.on('circuit-breaker', (data) => broadcast('circuit-breaker', data));
  orchestratorEmitter.on('tp-event', (data) => broadcast('tp-event', data));

  const host = CONFIG.DASHBOARD.HOST;
  server.listen(CONFIG.DASHBOARD.PORT, host, () => {
    console.log(`\n[Dashboard] Running at http://${host}:${CONFIG.DASHBOARD.PORT}`);
    if (host === '0.0.0.0') {
      console.log(`[Dashboard] ⚠️  Listening on all interfaces — ensure firewall is configured`);
    }
    console.log(`[Dashboard] Press Ctrl+C to stop\n`);
  });
}
