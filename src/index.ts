// ============================================================
// MAIN ENTRY POINT - Autonomous Market AI System v1.0.0
// Full professional suite: Multi-TP, Kelly, Regime, Macro, MTF
// ============================================================

import 'dotenv/config';

import { CONFIG, getModeConfig, validateConfig } from './config';
import { startPriceWebSocket } from './data/crypto';
import { startForexRefresh } from './data/forex';
import { initCommodityFeed } from './data/commodity';
import { initializePairs, startOrchestrator, stopOrchestrator, persistState, getPortfolioSummary } from './engine/orchestrator';
import { waitForDataReadiness } from './engine/readiness';
import { startDashboard } from './dashboard/server';

async function main() {
  // Validate config before booting any subsystems
  const validation = validateConfig();
  if (!validation.valid) {
    console.error('[Config] Startup validation failed:');
    for (const err of validation.errors) {
      console.error(`  ✗ ${err.field}: ${err.message}`);
    }
    process.exit(1);
  }

  const modeConf = getModeConfig();

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║       🤖 AUTONOMOUS MARKET AI SYSTEM v1.0.0              ║
║   Crypto • Forex • Gold • Silver • Oil Analysis          ║
║          Powered by SemutSSH AI (semut/opus-4.6)         ║
╚═══════════════════════════════════════════════════════════╝

⚙️  Config:
   • Mode: ${CONFIG.MODE} (${CONFIG.MODE === 'SCALPING' ? 'Fast 5s cycle, tight TP/SL' : 'Standard 15s cycle, swing TP/SL'})
   • Pairs: ${CONFIG.ACTIVE_PAIRS.length} total
     📈 Crypto (${CONFIG.CRYPTO_PAIRS.length}): ${CONFIG.CRYPTO_PAIRS.join(', ')}
     💱 Forex  (${CONFIG.FOREX_PAIRS.length}): ${CONFIG.FOREX_PAIRS.join(', ')}
     🥇 Commodities (${CONFIG.COMMODITY_PAIRS.length}): ${CONFIG.COMMODITY_PAIRS.join(', ')}
   • Balance: $${CONFIG.TRADING.STARTING_BALANCE_USDT} USDT per pair
   • Loss Threshold: ${CONFIG.TRADING.LOSS_THRESHOLD_PCT}% → self-correction
   • TP/SL: ATR-based (TP1=1.5×, TP2=3×, TP3=5×ATR) | Trail: 2×ATR | Daily Limit: ${CONFIG.TRADING.DAILY_LOSS_LIMIT_PCT}%
   • Analysis: every ${modeConf.ANALYSIS_INTERVAL_MS / 1000}s
   • Dashboard: http://localhost:${CONFIG.DASHBOARD.PORT}
`);

  // 1. Start crypto real-time price feed
  startPriceWebSocket(CONFIG.CRYPTO_PAIRS);

  // 2. Start forex refresh
  startForexRefresh(60000);

  // 3. Start commodity price feed (Gold/Silver/Oil via Yahoo Finance or simulation)
  initCommodityFeed();

  // 4. Initialize pair states
  initializePairs();

  // 5. Start dashboard
  startDashboard();

  // 6. Data readiness gate — probe feeds with bounded timeout
  const readiness = await waitForDataReadiness({
    timeoutMs: CONFIG.STARTUP.READINESS_TIMEOUT_MS,
    mode: CONFIG.STARTUP.READINESS_MODE,
    requirements: Object.fromEntries(
      Object.entries(CONFIG.STARTUP.READINESS_REQUIREMENTS).filter(([, value]) => value !== ''),
    ) as Partial<Record<string, import('./config').SourceHealthTier>>,
  });
  if (!readiness.ready) {
    const message = `[Main] ⚠️ Data sources not ready under ${CONFIG.STARTUP.READINESS_MODE} mode after ${readiness.elapsedMs}ms`;
    if (CONFIG.STARTUP.READINESS_FAILURE_POLICY === 'fail') {
      console.error(`${message} — aborting startup`);
      process.exit(1);
    }
    console.warn(`${message} — proceeding with available data`);
  }

  // 7. Start main orchestrator loop (runs forever)
  await startOrchestrator();
}

// ── Graceful shutdown ──────────────────────────────────────
let isShuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Main] Received ${signal}. Shutting down gracefully...`);

  try {
    stopOrchestrator();
    persistState({ shutdown: true });

    const summary = getPortfolioSummary();
    console.log(`[Main] Final state — Equity: $${summary.totalEquity.toFixed(2)} | PnL: $${summary.totalPnl.toFixed(2)} (${summary.totalPnlPct.toFixed(2)}%) | Cycles: ${summary.cycle} | Trades: ${summary.totalTrades}`);
    console.log('[Main] State persisted. Goodbye.');
  } catch (err: any) {
    console.error(`[Main] Error during shutdown: ${err.message}`);
  }

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  console.error('[Main] Unhandled error:', err);
});

main().catch(console.error);
