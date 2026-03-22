// ============================================================
// MULTI-TIMEFRAME CONFIRMATION (MTF)
//
// Professional approach: "HTF bias, MTF setup, LTF entry"
//
//   4H timeframe → determines overall bias (BULL / BEAR / NEUTRAL)
//   1H timeframe → confirms direction + entry structure
//   15M timeframe → precise entry timing (not used here, handled by AI)
//
// Logic:
//   - 4H bullish + 1H bullish + signal BUY → HIGH CONFLUENCE ✅
//   - 4H bullish + signal BUY           → MEDIUM CONFLUENCE
//   - 4H bearish + signal BUY           → COUNTER-TREND ❌ skip or require >80% conf
//   - 4H bearish + 1H bearish + BUY     → BLOCKED
//
// Output: MTFResult with bias, alignment score (0-100), and canProceed
// ============================================================

import { Candle } from '../config';

export type HTFBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface MTFResult {
  htfBias: HTFBias;           // 4H timeframe bias
  mtfBias: HTFBias;           // 1H timeframe bias
  alignment: 'ALIGNED' | 'MIXED' | 'OPPOSED';
  confluenceBonus: number;    // +15 if aligned, -20 if opposed
  minConfidenceRequired: number; // Extra confidence needed if opposing HTF
  description: string;
}

// ── Simple directional bias from candles ─────────────────────
function getBias(candles: Candle[]): HTFBias {
  if (candles.length < 20) return 'NEUTRAL';

  const closes = candles.map(c => c.close);
  const price = closes.at(-1)!;

  // EMA20 fast, EMA50 slow
  const period20 = 20, period50 = Math.min(50, candles.length - 1);
  const k20 = 2 / (period20 + 1);
  const k50 = 2 / (period50 + 1);

  let ema20 = closes.slice(0, period20).reduce((a, b) => a + b, 0) / period20;
  let ema50 = closes.slice(0, period50).reduce((a, b) => a + b, 0) / period50;

  for (let i = period20; i < closes.length; i++) {
    ema20 = closes[i] * k20 + ema20 * (1 - k20);
  }
  for (let i = period50; i < closes.length; i++) {
    ema50 = closes[i] * k50 + ema50 * (1 - k50);
  }

  // Higher highs / higher lows check (last 5 swing points)
  const recentHighs = candles.slice(-10).map(c => c.high);
  const recentLows = candles.slice(-10).map(c => c.low);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i-1]).length;
  const hlCount = recentLows.filter((l, i) => i > 0 && l > recentLows[i-1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i-1]).length;
  const lhCount = recentHighs.filter((h, i) => i > 0 && h < recentHighs[i-1]).length;

  const bullScore = (price > ema20 ? 1 : 0) + (ema20 > ema50 ? 1 : 0) + (hhCount >= lhCount ? 1 : 0) + (hlCount >= llCount ? 1 : 0);
  const bearScore = (price < ema20 ? 1 : 0) + (ema20 < ema50 ? 1 : 0) + (lhCount > hhCount ? 1 : 0) + (llCount > hlCount ? 1 : 0);

  if (bullScore >= 3) return 'BULLISH';
  if (bearScore >= 3) return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================================
// MAIN MTF ANALYSIS
// ============================================================
export function analyzeMultiTimeframe(
  candles4h: Candle[],
  candles1h: Candle[],
  signalDirection: 'BUY' | 'SELL' | 'HOLD'
): MTFResult {
  const htfBias = getBias(candles4h);
  const mtfBias = getBias(candles1h);

  if (signalDirection === 'HOLD') {
    return {
      htfBias, mtfBias, alignment: 'MIXED',
      confluenceBonus: 0, minConfidenceRequired: 0,
      description: `4H: ${htfBias} | 1H: ${mtfBias}`,
    };
  }

  const isBuy = signalDirection === 'BUY';

  // Alignment check
  const htfAligned = isBuy ? htfBias === 'BULLISH' : htfBias === 'BEARISH';
  const mtfAligned = isBuy ? mtfBias === 'BULLISH' : mtfBias === 'BEARISH';
  const htfOpposed = isBuy ? htfBias === 'BEARISH' : htfBias === 'BULLISH';

  let alignment: MTFResult['alignment'];
  let confluenceBonus: number;
  let minConfidenceRequired: number;
  let description: string;

  if (htfAligned && mtfAligned) {
    // Full alignment — all timeframes agree
    alignment = 'ALIGNED';
    confluenceBonus = 15;  // +15 to confluence score
    minConfidenceRequired = 0;
    description = `✅ Full MTF alignment — 4H ${htfBias} → 1H ${mtfBias} → ${signalDirection}`;
  } else if (htfAligned || mtfAligned) {
    // Partial alignment
    alignment = 'MIXED';
    confluenceBonus = 5;
    minConfidenceRequired = 5;
    description = `⚡ Partial MTF: 4H ${htfBias} | 1H ${mtfBias} | ${signalDirection}`;
  } else if (htfOpposed) {
    // Counter-trend — require much higher confidence
    alignment = 'OPPOSED';
    confluenceBonus = -20;
    minConfidenceRequired = 20; // Need 20% more confidence than normal
    description = `⛔ Counter-trend: 4H ${htfBias} vs ${signalDirection} signal — requires ${minConfidenceRequired}% extra confidence`;
  } else {
    // HTF neutral
    alignment = 'MIXED';
    confluenceBonus = 0;
    minConfidenceRequired = 0;
    description = `➡️ HTF neutral: 4H ${htfBias} | 1H ${mtfBias}`;
  }

  return { htfBias, mtfBias, alignment, confluenceBonus, minConfidenceRequired, description };
}
