// ============================================================
// MAIN ENTRY POINT - Autonomous Market AI System v3.0
// Full professional suite: Multi-TP, Kelly, Regime, Macro, MTF
// ============================================================

import 'dotenv/config';

import { CONFIG, getModeConfig } from './config';
import { startPriceWebSocket } from './data/crypto';
import { startForexRefresh } from './data/forex';
import { initCommodityFeed } from './data/commodity';
import { initializePairs, startOrchestrator } from './engine/orchestrator';
import { startDashboard } from './dashboard/server';

async function main() {
  const modeConf = getModeConfig();

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║       🤖 AUTONOMOUS MARKET AI SYSTEM v2.0                ║
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

  // 6. Warm up
  console.log('[Main] Waiting 3s for data feeds to establish...');
  await sleep(3000);

  // 7. Start main orchestrator loop (runs forever)
  await startOrchestrator();
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log('\n[Main] Shutting down gracefully...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[Main] Unhandled error:', err);
});

main().catch(console.error);
