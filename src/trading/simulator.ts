// ============================================================
// TRADING SIMULATOR v1.0.0 — Multi-TP + Trailing SL + Pyramiding
//
// SYSTEM OVERVIEW:
//
//  BUY @ $100 (ATR = $2)
//  ├─ TP1 = $103 (1.5×ATR) → close 30%, SL → entry
//  ├─ TP2 = $106 (3.0×ATR) → close 30%, SL → TP1
//  ├─ TP3 = $110 (5.0×ATR) → close 40%, SWING MODE starts
//  └─ SWING: trailing SL = highest_close - 2×ATR (never goes down)
//
//  SL JOURNEY:
//  entry   → SL at originalSL
//  50%→TP1 → SL moves to entry (BREAKEVEN, zero risk trade)
//  TP1 hit → SL moves to entry + ATR/2 (locked small profit)
//  TP2 hit → SL moves to TP1 level
//  TP3 hit → Swing mode: SL = trailingHighest - 2×ATR
//
//  PYRAMIDING:
//  Layer 1: 20% balance (initial)
//  Layer 2: 10% balance (add only if profitable + score > 70)
//  Layer 3: 5% balance  (add only if layer 2 profitable + score > 80)
//  Max 3 layers. Never add to losing position.
// ============================================================

import { TradePosition, PairState, StrategyConfig, CONFIG, TPPhase } from '../config';
import { kellyPositionSize } from '../analytics/kelly';


const MTP = CONFIG.TRADING.MULTI_TP;
const PYR = CONFIG.TRADING.PYRAMID;

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// CREATE PAIR STATE
// ============================================================
export function createPairState(pair: string, strategy: StrategyConfig): PairState {
  return {
    pair, balance: CONFIG.TRADING.STARTING_BALANCE_USDT,
    positions: [], closedTrades: [],
    totalPnl: 0, totalPnlPct: 0, winRate: 0,
    strategy, currentPrice: 0, isAnalyzing: false, correctionCount: 0,
  };
}

// ============================================================
// EXECUTE BUY — Opens position with multi-TP targets
// ============================================================
export function executeBuy(
  state: PairState,
  price: number,
  confidence: number,
  reason: string,
  atr: number = price * 0.01 // Default ATR = 1% of price if not provided
): TradePosition | null {
  const { strategy, balance, positions } = state;

  // Check pyramiding rules
  const existingLayers = positions.filter(p => p.status === 'OPEN').length;
  if (existingLayers >= PYR.MAX_LAYERS) return null;

  // Determine pyramid layer and requirements
  const pyramidLayer = existingLayers + 1;
  if (pyramidLayer === 2) {
    // Layer 2: requires first position to be profitable
    const layer1 = positions.find(p => p.pyramidLayer === 1 && p.status === 'OPEN');
    if (!layer1 || price <= layer1.entryPrice) return null;
    if (confidence < PYR.MIN_CONFLUENCE_SCORE) return null;
  }
  if (pyramidLayer === 3) {
    const layer2 = positions.find(p => p.pyramidLayer === 2 && p.status === 'OPEN');
    if (!layer2 || price <= layer2.entryPrice) return null;
    if (confidence < 80) return null; // Stricter for 3rd layer
  }

  if (confidence < strategy.signalThreshold) return null;
  if (balance < 10) return null;

  // Determine position size — Kelly Criterion or fixed fallback
  const usdtValue = kellyPositionSize(state, balance, pyramidLayer);
  const commission = usdtValue * (CONFIG.TRADING.COMMISSION_PCT / 100);
  const slippage = price * (CONFIG.TRADING.SLIPPAGE_PCT / 100);
  const finalPrice = price + slippage;
  const quantity = (usdtValue - commission) / finalPrice;

  // ATR-based TP levels
  const tp1 = finalPrice + MTP.TP1_ATR * atr;
  const tp2 = finalPrice + MTP.TP2_ATR * atr;
  const tp3 = finalPrice + MTP.TP3_ATR * atr;

  // Original SL: entry - 2×ATR (or strategy slPct if wider)
  const slByATR = finalPrice - 2 * atr;
  const slByPct = finalPrice * (1 - strategy.slPct / 100);
  const originalSL = Math.max(slByATR, slByPct); // Use whichever is tighter (higher price)

  const position: TradePosition = {
    id: genId(),
    pair: state.pair,
    type: 'BUY',
    entryPrice: finalPrice,
    initialQuantity: quantity,
    quantity,
    usdtValue,
    currentUsdtValue: usdtValue,
    tp1, tp2, tp3,
    originalSL,
    stopLoss: originalSL,
    tpPhase: 'initial',
    highestClose: finalPrice,
    atr,
    pyramidLayer,
    openTime: Date.now(),
    status: 'OPEN',
    partialCloses: [],
    takeProfit: tp1, // For display compat
    reason,
  };

  state.balance -= usdtValue;
  state.positions.push(position);
  return position;
}

// ============================================================
// PARTIAL CLOSE — Close X% of remaining position
// ============================================================
function partialClose(
  state: PairState,
  pos: TradePosition,
  closePct: number,
  price: number,
  phase: string
): number {
  const qtyToClose = pos.quantity * (closePct / 100);
  const slippage = price * (CONFIG.TRADING.SLIPPAGE_PCT / 100);
  const finalPrice = price - slippage;
  const commission = qtyToClose * finalPrice * (CONFIG.TRADING.COMMISSION_PCT / 100);
  const revenue = qtyToClose * finalPrice - commission;
  const costBasis = (pos.usdtValue / pos.initialQuantity) * qtyToClose;
  const pnl = revenue - costBasis;

  // Update position
  pos.quantity -= qtyToClose;
  pos.currentUsdtValue = pos.quantity * finalPrice;
  state.balance += revenue;

  pos.partialCloses.push({ phase, qty: qtyToClose, price: finalPrice, pnl });

  console.log(`[${pos.pair}] 📊 Partial Close at ${phase}: ${closePct}% @ $${finalPrice.toFixed(4)} | PnL on closed: $${pnl.toFixed(2)}`);

  return pnl;
}

// ============================================================
// ADVANCE TP PHASE — Core engine of the multi-TP system
// Called every tick with current price
// Returns list of events that happened
// ============================================================
export function advanceTPPhase(
  state: PairState,
  pos: TradePosition,
  currentPrice: number
): Array<{ event: string; pnl?: number }> {
  const events: Array<{ event: string; pnl?: number }> = [];

  if (pos.status !== 'OPEN' || pos.type !== 'BUY') return events;

  // Update highest close for swing mode
  if (currentPrice > pos.highestClose) {
    pos.highestClose = currentPrice;
  }

  // ----------------------------------------------------------------
  // SWING MODE: Trailing SL
  // ----------------------------------------------------------------
  if (pos.tpPhase === 'swing') {
    const newTrailSL = pos.highestClose - MTP.TRAIL_ATR * pos.atr;
    if (newTrailSL > pos.stopLoss) {
      pos.stopLoss = newTrailSL;
      pos.takeProfit = pos.highestClose + pos.atr; // Update display target
    }
    // Check if trailing SL was hit
    if (currentPrice <= pos.stopLoss) {
      const pnl = fullClose(state, pos, currentPrice, '⛵ Swing Trailing SL');
      events.push({ event: 'swing_sl_hit', pnl });
    }
    return events;
  }

  // ----------------------------------------------------------------
  // Phase: INITIAL → BREAKEVEN (when price is 50%+ toward TP1)
  // ----------------------------------------------------------------
  if (pos.tpPhase === 'initial') {
    const halfwayToTP1 = pos.entryPrice + (pos.tp1 - pos.entryPrice) * 0.5;
    if (currentPrice >= halfwayToTP1) {
      pos.stopLoss = pos.entryPrice; // Move SL to entry (zero risk trade!)
      pos.tpPhase = 'breakeven';
      events.push({ event: 'breakeven_activated' });
      console.log(`[${pos.pair}] 🔐 BREAKEVEN activated — SL moved to entry $${pos.entryPrice.toFixed(4)}`);
    }
    // Still check original SL
    if (currentPrice <= pos.stopLoss) {
      const pnl = fullClose(state, pos, currentPrice, '🛑 Stop Loss (Initial)');
      events.push({ event: 'sl_hit', pnl });
    }
    return events;
  }

  // ----------------------------------------------------------------
  // Phase: BREAKEVEN or TP1_HIT → check for SL or TP1
  // ----------------------------------------------------------------
  if (pos.tpPhase === 'breakeven') {
    // Check SL (now at entry, so minimum loss = 0 + commission/slippage)
    if (currentPrice <= pos.stopLoss) {
      const pnl = fullClose(state, pos, currentPrice, '🔐 Breakeven Stop (no loss)');
      events.push({ event: 'breakeven_sl', pnl });
      return events;
    }

    // TP1 HIT
    if (currentPrice >= pos.tp1) {
      const pnl = partialClose(state, pos, MTP.TP1_CLOSE_PCT, currentPrice, 'TP1');
      pos.stopLoss = pos.entryPrice + pos.atr * 0.5; // Locked small profit
      pos.tpPhase = 'tp1_hit';
      pos.takeProfit = pos.tp2; // Update display
      events.push({ event: 'tp1_hit', pnl });
      console.log(`[${pos.pair}] 🎯 TP1 HIT! SL → $${pos.stopLoss.toFixed(4)} | Remaining ${(100 - MTP.TP1_CLOSE_PCT)}% running`);
    }
    return events;
  }

  // ----------------------------------------------------------------
  // Phase: TP1_HIT → check for SL or TP2
  // ----------------------------------------------------------------
  if (pos.tpPhase === 'tp1_hit') {
    if (currentPrice <= pos.stopLoss) {
      const pnl = fullClose(state, pos, currentPrice, '🔒 Stop (locked profit after TP1)');
      events.push({ event: 'post_tp1_sl', pnl });
      return events;
    }

    // TP2 HIT
    if (currentPrice >= pos.tp2) {
      const pnl = partialClose(state, pos, MTP.TP2_CLOSE_PCT, currentPrice, 'TP2');
      pos.stopLoss = pos.tp1; // SL moves to TP1 level (protect TP1 gain on remainder)
      pos.tpPhase = 'tp2_hit';
      pos.takeProfit = pos.tp3;
      events.push({ event: 'tp2_hit', pnl });
      console.log(`[${pos.pair}] 🎯🎯 TP2 HIT! SL → TP1 level $${pos.stopLoss.toFixed(4)} | Remaining ${100 - MTP.TP1_CLOSE_PCT - MTP.TP2_CLOSE_PCT}% running`);
    }
    return events;
  }

  // ----------------------------------------------------------------
  // Phase: TP2_HIT → check for SL or TP3 (swing trigger)
  // ----------------------------------------------------------------
  if (pos.tpPhase === 'tp2_hit') {
    if (currentPrice <= pos.stopLoss) {
      const pnl = fullClose(state, pos, currentPrice, '🔒 Stop (after TP2, TP1 level protected)');
      events.push({ event: 'post_tp2_sl', pnl });
      return events;
    }

    // TP3 HIT → SWING MODE
    if (currentPrice >= pos.tp3) {
      const pnl = partialClose(state, pos, MTP.TP3_CLOSE_PCT, currentPrice, 'TP3');
      pos.tpPhase = 'swing';
      pos.highestClose = currentPrice;
      pos.stopLoss = currentPrice - MTP.TRAIL_ATR * pos.atr; // Initial trailing SL
      pos.takeProfit = currentPrice + pos.atr * 2; // Nominal swing target display
      events.push({ event: 'tp3_swing_activated', pnl });
      console.log(`[${pos.pair}] 🚀 TP3 HIT → SWING MODE! ${100 - MTP.TP1_CLOSE_PCT - MTP.TP2_CLOSE_PCT - MTP.TP3_CLOSE_PCT}% position now trailing at $${pos.stopLoss.toFixed(4)}`);
    }
    return events;
  }

  return events;
}

// ============================================================
// FULL CLOSE — Close entire remaining position
// ============================================================
function fullClose(
  state: PairState,
  pos: TradePosition,
  price: number,
  reason: string
): number {
  const slippage = price * (CONFIG.TRADING.SLIPPAGE_PCT / 100);
  const finalPrice = Math.max(0.0001, price - slippage);
  const commission = pos.quantity * finalPrice * (CONFIG.TRADING.COMMISSION_PCT / 100);
  const revenue = pos.quantity * finalPrice - commission;
  const costBasis = pos.currentUsdtValue;
  const pnl = revenue - costBasis;
  const pnlPct = (pnl / pos.usdtValue) * 100;

  pos.closePrice = finalPrice;
  pos.closeTime = Date.now();
  pos.pnl = (pos.partialCloses.reduce((s, p) => s + p.pnl, 0)) + pnl; // Total including partials
  pos.pnlPct = (pos.pnl / pos.usdtValue) * 100;
  pos.status = 'CLOSED';
  pos.reason = reason;
  pos.quantity = 0;
  pos.currentUsdtValue = 0;

  state.balance += revenue;
  state.positions = state.positions.filter(p => p.id !== pos.id);
  state.closedTrades.push(pos);
  updatePortfolioStats(state);

  return pnl;
}

// ============================================================
// CHECK MULTI-TP & TRAIL — Main per-tick function
// Replaces old checkStopLossTakeProfit
// ============================================================
export function checkMultiTPAndTrail(
  state: PairState,
  currentPrice: number,
  confluenceScore: number = 0
): Array<{ pair: string; event: string; pnl?: number; position: TradePosition }> {
  const results: Array<{ pair: string; event: string; pnl?: number; position: TradePosition }> = [];
  const timeExitMs = CONFIG.TRADING.TIME_BASED_EXIT_HOURS * 3600000;

  for (const pos of [...state.positions]) {
    if (pos.status !== 'OPEN') continue;

    // ── Time-Based Exit: close stagnant positions ──────────────────────────
    // Only for initial phase (no TP hit yet) to avoid kicking swing runners
    if (pos.tpPhase === 'initial' && pos.openTime) {
      const elapsed = Date.now() - pos.openTime;
      const priceMoveAbs = Math.abs(currentPrice - pos.entryPrice);
      const stagnant = priceMoveAbs < pos.atr * 0.5; // Less than 0.5 ATR movement
      if (elapsed >= timeExitMs && stagnant) {
        const pnl = fullClose(state, pos, currentPrice, `⏰ Time-based exit (${CONFIG.TRADING.TIME_BASED_EXIT_HOURS}h stagnant)`);
        results.push({ pair: state.pair, event: 'time_exit', pnl, position: pos });
        console.log(`[${pos.pair}] ⏰ Time-based exit after ${(elapsed / 3600000).toFixed(1)}h | PnL: $${pnl.toFixed(2)}`);
        continue;
      }
    }

    // ── Normal multi-TP and Trail logic ──────────────────────────────────
    const events = advanceTPPhase(state, pos, currentPrice);
    for (const event of events) {
      results.push({ pair: state.pair, event: event.event, pnl: event.pnl, position: pos });
    }
  }

  return results;
}

// ============================================================
// EXECUTE SELL (AI SELL signal) — Close all positions for pair
// Also used when AI confidence is very high for reversal
// ============================================================
export function executeSell(
  state: PairState,
  price: number,
  positionId: string,
  reason: string = 'AI SELL Signal'
): TradePosition | null {
  const pos = state.positions.find(p => p.id === positionId && p.status === 'OPEN');
  if (!pos) return null;

  fullClose(state, pos, price, reason);
  return pos;
}

// ============================================================
// Legacy compatibility wrapper (used in some places)
// ============================================================
export function checkStopLossTakeProfit(
  state: PairState,
  currentPrice: number
): TradePosition[] {
  const results = checkMultiTPAndTrail(state, currentPrice);
  return results
    .filter(r => ['sl_hit', 'breakeven_sl', 'swing_sl_hit', 'post_tp1_sl', 'post_tp2_sl'].includes(r.event))
    .map(r => r.position);
}

// ============================================================
// PORTFOLIO STATS
// ============================================================
export function updatePortfolioStats(state: PairState): void {
  const closed = state.closedTrades;
  if (closed.length === 0) { state.totalPnl = 0; state.totalPnlPct = 0; state.winRate = 0; return; }
  state.totalPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  state.winRate = (wins / closed.length) * 100;
  state.totalPnlPct = (state.totalPnl / CONFIG.TRADING.STARTING_BALANCE_USDT) * 100;
}

export function getUnrealizedPnl(state: PairState, currentPrice: number): number {
  return state.positions.reduce((sum, pos) => {
    if (pos.status !== 'OPEN') return sum;
    const currentValue = pos.quantity * currentPrice;
    return sum + (currentValue - pos.currentUsdtValue);
  }, 0);
}

export function getTotalEquity(state: PairState, currentPrice: number): number {
  const unrealized = getUnrealizedPnl(state, currentPrice);
  return state.balance + state.positions.reduce((sum, p) => sum + p.currentUsdtValue, 0) + unrealized;
}
