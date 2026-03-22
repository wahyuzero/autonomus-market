// ============================================================
// SELF-CORRECTION ENGINE
// ============================================================

import { PairState, StrategyConfig, CONFIG } from '../config';
import { requestSelfCorrection } from '../ai/analyst';
import { applyCorrection } from '../trading/strategy_store';

export async function checkAndCorrect(state: PairState): Promise<{ corrected: boolean; message: string }> {
  // Only trigger when loss threshold exceeded
  if (state.totalPnlPct > CONFIG.TRADING.LOSS_THRESHOLD_PCT) {
    return { corrected: false, message: '' };
  }

  if (state.closedTrades.length < 3) {
    return { corrected: false, message: 'Not enough trades for correction analysis' };
  }

  console.log(`\n[Corrector] ⚠️  ${state.pair} loss ${state.totalPnlPct.toFixed(2)}% exceeded threshold ${CONFIG.TRADING.LOSS_THRESHOLD_PCT}%`);
  console.log(`[Corrector] 🔄 Requesting AI self-correction analysis...`);

  try {
    const result = await requestSelfCorrection(
      state.pair,
      state.strategy.name,
      state.closedTrades,
      state.totalPnlPct
    );

    const parsed = parseCorrections(result.adjustments);
    const correctedStrategy = applyCorrection(state.pair, state.strategy, {
      newStrategy: result.newStrategy,
      newTpPct: parsed.newTpPct,
      newSlPct: parsed.newSlPct,
      newSignalThreshold: parsed.newSignalThreshold,
    });

    state.strategy = correctedStrategy;
    state.correctionCount++;

    // Close all open positions to apply new strategy fresh
    console.log(`[Corrector] ✅ Applied new strategy: "${correctedStrategy.name}"`);
    console.log(`[Corrector] 📊 Analysis: ${result.analysis}`);
    console.log(`[Corrector] 🔧 Adjustments: ${result.adjustments}`);

    return {
      corrected: true,
      message: `Self-corrected (attempt #${state.correctionCount}): ${result.newStrategy}. ${result.analysis}`,
    };
  } catch (err: any) {
    console.error(`[Corrector] Failed for ${state.pair}:`, err.message);
    return { corrected: false, message: 'Correction attempt failed' };
  }
}

function parseCorrections(adjustments: string): {
  newTpPct?: number;
  newSlPct?: number;
  newSignalThreshold?: number;
} {
  // Try to extract numeric values from adjustment text or JSON
  const result: ReturnType<typeof parseCorrections> = {};

  const tpMatch = adjustments.match(/tp[_\s]?pct[:\s]+([0-9.]+)/i);
  const slMatch = adjustments.match(/sl[_\s]?pct[:\s]+([0-9.]+)/i);
  const threshMatch = adjustments.match(/threshold[:\s]+([0-9]+)/i);

  if (tpMatch) result.newTpPct = parseFloat(tpMatch[1]);
  if (slMatch) result.newSlPct = parseFloat(slMatch[1]);
  if (threshMatch) result.newSignalThreshold = parseInt(threshMatch[1]);

  return result;
}
