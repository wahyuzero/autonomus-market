// ============================================================
// KELLY CRITERION — Optimal Position Sizing
//
// Formula: f* = (b×p - q) / b
//   f* = fraction of capital to risk
//   b  = avg win / avg loss (Reward-to-Risk ratio)
//   p  = win probability  
//   q  = loss probability (1 - p)
//
// Professional approach: use HALF-KELLY (50%) to reduce variance
// Further cap at MAX_POSITION_SIZE_PCT for safety.
//
// Improves on fixed % by scaling position size with strategy edge.
// When win rate drops → smaller positions (natural protection).
// ============================================================

import { PairState, CONFIG } from '../config';

export interface KellyResult {
  fullKelly: number;    // Full Kelly % (raw)
  halfKelly: number;    // 50% Kelly (recommended)
  capped: number;       // After max cap applied
  winRate: number;      // Win rate used
  rr: number;           // Reward:Risk used
  edge: number;         // Strategy edge (0 = no edge)
}

// ============================================================
// COMPUTE KELLY FRACTION
// ============================================================
export function computeKelly(state: PairState): KellyResult {
  const trades = state.closedTrades;
  const defaultSize = CONFIG.TRADING.PYRAMID.LAYER_SIZES_PCT[0];

  if (trades.length < CONFIG.KELLY.MIN_TRADES_FOR_KELLY) {
    // Not enough history — use default
    return {
      fullKelly: defaultSize, halfKelly: defaultSize, capped: defaultSize,
      winRate: 0, rr: 0, edge: 0,
    };
  }

  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) <= 0);

  const p = wins.length / trades.length;
  const q = 1 - p;

  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;

  if (avgLoss === 0) {
    return { fullKelly: defaultSize, halfKelly: defaultSize, capped: defaultSize, winRate: p * 100, rr: 0, edge: 0 };
  }

  const b = avgWin / avgLoss; // Reward:Risk ratio

  // Kelly formula: f* = (b×p - q) / b
  const fullKellyDecimal = (b * p - q) / b;
  const fullKellyPct = fullKellyDecimal * 100;

  // Negative Kelly = no edge, use minimum
  if (fullKellyDecimal <= 0) {
    const minSize = 2; // Absolute minimum 2%
    return { fullKelly: fullKellyPct, halfKelly: minSize, capped: minSize, winRate: p * 100, rr: b, edge: fullKellyDecimal };
  }

  const halfKellyPct = fullKellyPct * CONFIG.KELLY.KELLY_FRACTION;
  const cappedPct = Math.min(halfKellyPct, CONFIG.TRADING.MAX_POSITION_SIZE_PCT);

  return {
    fullKelly: fullKellyPct,
    halfKelly: halfKellyPct,
    capped: cappedPct,
    winRate: p * 100,
    rr: b,
    edge: fullKellyDecimal,
  };
}

// ============================================================
// KELLY-BASED USDT POSITION SIZE
// ============================================================
export function kellyPositionSize(
  state: PairState,
  balance: number,
  pyramidLayer: number,
): number {
  if (!CONFIG.KELLY.ENABLED) {
    // Fall back to fixed layer sizes from config
    const layerPct = CONFIG.TRADING.PYRAMID.LAYER_SIZES_PCT[pyramidLayer - 1] ?? 5;
    return balance * (layerPct / 100);
  }

  const kelly = computeKelly(state);

  // Pyramid layers use decreasing fractions of Kelly size
  const layerFractions = [1.0, 0.5, 0.25]; // Layer 1=full, Layer 2=half, Layer 3=quarter
  const fraction = layerFractions[pyramidLayer - 1] ?? 0.25;

  const sizePct = kelly.capped * fraction;
  const minPct = 1.0; // Never below 1%
  const finalPct = Math.max(minPct, sizePct);

  if (state.closedTrades.length >= CONFIG.KELLY.MIN_TRADES_FOR_KELLY) {
    console.log(`[${state.pair}] 📐 Kelly: WR=${kelly.winRate.toFixed(0)}% RR=${kelly.rr.toFixed(2)} → ${kelly.capped.toFixed(1)}% (L${pyramidLayer}: ${finalPct.toFixed(1)}%)`);
  }

  return balance * (finalPct / 100);
}
