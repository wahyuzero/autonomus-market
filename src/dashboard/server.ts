// ============================================================
// DASHBOARD SERVER - HTTP + WebSocket for real-time UI
// ============================================================

import express from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import WebSocket from 'ws';
import { CONFIG } from '../config';
import { orchestratorEmitter, pairStates, getPortfolioSummary } from '../engine/orchestrator';
import { getTotalEquity, getUnrealizedPnl } from '../trading/simulator';
import { computePortfolioMetrics } from '../analytics/performance';

export function startDashboard(): void {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // Serve static files
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // API endpoints
  app.get('/api/state', (req, res) => {
    res.json(buildStatePayload());
  });

  app.get('/api/summary', (req, res) => {
    res.json(getPortfolioSummary());
  });

  // WebSocket connections
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[Dashboard] Client connected (total: ${clients.size})`);

    // Send initial state
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

  // Real-time broadcast every second
  setInterval(() => {
    if (clients.size > 0) {
      broadcast('state', buildStatePayload());
    }
  }, CONFIG.DASHBOARD.WS_BROADCAST_INTERVAL_MS);

  // Forward orchestrator events
  orchestratorEmitter.on('trade-opened', (data) => broadcast('trade-opened', data));
  orchestratorEmitter.on('trade-closed', (data) => broadcast('trade-closed', data));
  orchestratorEmitter.on('self-corrected', (data) => broadcast('self-corrected', data));
  orchestratorEmitter.on('pair-analyzed', (data) => broadcast('pair-analyzed', data));
  orchestratorEmitter.on('cycle-complete', (data) => broadcast('cycle', data));
  orchestratorEmitter.on('circuit-breaker', (data) => broadcast('circuit-breaker', data));
  orchestratorEmitter.on('tp-event', (data) => broadcast('tp-event', data));

  server.listen(CONFIG.DASHBOARD.PORT, () => {
    console.log(`\n[Dashboard] 🌐 Running at http://localhost:${CONFIG.DASHBOARD.PORT}`);
    console.log(`[Dashboard] Press Ctrl+C to stop\n`);
  });
}

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

  // Compute aggregate analytics (only if there are trades to measure)
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
    },
    timestamp: Date.now(),
  };
}
