// —————————————————————————————————————————————————————————————
// TECHNICAL ANALYSIS ENGINE v1.0.0 — Full Professional Suite
//
// Includes: BOS/CHoCH, VWAP+Bands, Ichimoku (5), RSI Divergence,
// MACD Momentum, Volume Profile (POC), FVG, Order Blocks,
// Confluence Score, Regime Detection, Liquidity Sweep
// —————————————————————————————————————————————————————————————
//
// PHILOSOPHY: Based on deep research into indicator quality.
//
// ❌ AVOIDED (laggy/false-prone):
//   - Raw SMA/EMA crossovers (60%+ false in ranging markets)
//   - RSI overbought/oversold as standalone (stuck for weeks in trends)
//   - Standard MACD crossovers (double-lagging, whipsaw)
//   - Stochastic as standalone trigger (too noisy)
//
// ✅ USED (genuinely powerful):
//   - Ichimoku Cloud (5-component, semi-leading, projects future S/R)
//   - VWAP + Bands (institutional benchmark, volume-weighted)
//   - Volume Profile POC simulation (high-volume node S/R)
//   - Market Structure: BOS / CHoCH (price action, zero lag)
//   - RSI Divergence (leading signal, not overbought/oversold)
//   - Hidden Divergence (trend continuation signal)
//   - Multi-timeframe confluence (1h primary + 4h bias)
//   - ATR-based dynamic SL/TP (volatility-adjusted)
//   - Weighted Confluence Score (counts signal quality)
//   - Fair Value Gaps / FVG (imbalance zones — high probability)
//   - Order Blocks (institutional entry zones — SMC)
// ============================================================

import { MACD, BollingerBands, RSI, EMA, ATR, Stochastic } from 'technicalindicators';
import { Candle, TechnicalSummary, CONFIG } from '../config';
import { detectRegime, RegimeResult } from './regime';
import { detectLiquiditySweep, LiquiditySweep } from './liquidity';

// ============================================================
// MAIN EXPORT
// ============================================================

export function computeTechnicals(candles: Candle[]): TechnicalSummary {
  if (candles.length < 52) {
    return emptyTech(candles.at(-1)?.close ?? 0);
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // === 1. CORE MOMENTUM (used only for DIVERGENCE, not overbought/oversold) ===
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiValues.at(-1) ?? 50;

  // RSI Divergence analysis (leading signal)
  const rsiDivergence = detectRSIDivergence(closes.slice(-30), rsiValues.slice(-30));

  // MACD — used only for momentum SHIFT, not crossovers
  const macdValues = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const lastMacd = macdValues.at(-1);
  const macd = {
    line: lastMacd?.MACD ?? 0,
    signal: lastMacd?.signal ?? 0,
    histogram: lastMacd?.histogram ?? 0,
  };

  // Pure momentum: is histogram accelerating or decelerating?
  const macdMomentumShift = getMacdMomentumShift(macdValues.slice(-5));

  // === 2. VWAP (Volume-Weighted Average Price) — Institutional Level ===
  const vwap = computeVWAP(candles.slice(-50));
  const vwapBands = computeVWAPBands(candles.slice(-50), vwap);

  // === 3. REGIME DETECTION (Trend vs. Range) ===
  const regime = detectRegime(candles.slice(-50));

  // === 4. ICHIMOKU CLOUD ===
  const ichimoku = computeIchimoku(candles);

  // === 5. ATR (Volatility — not a signal, used for SL/TP sizing) ===
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atr = atrValues.at(-1) ?? 0;

  // === 6. BOLLINGER BANDS (only for volatility context, not signals) ===
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const lastBB = bbValues.at(-1);
  const bbands = {
    upper: lastBB?.upper ?? closes.at(-1)! * 1.02,
    middle: lastBB?.middle ?? closes.at(-1)!,
    lower: lastBB?.lower ?? closes.at(-1)! * 0.98,
    width: lastBB ? (lastBB.upper - lastBB.lower) / lastBB.middle : 0.04,
  };

  // === 7. EMA (used as trend filter only, not crossover signal) ===
  const ema9v = EMA.calculate({ values: closes, period: 9 });
  const ema21v = EMA.calculate({ values: closes, period: 21 });
  const ema50v = EMA.calculate({ values: closes, period: 50 });
  const ema200v = EMA.calculate({ values: closes, period: Math.min(200, closes.length) });
  const ema = {
    ema9: ema9v.at(-1) ?? closes.at(-1)!,
    ema21: ema21v.at(-1) ?? closes.at(-1)!,
    ema50: ema50v.at(-1) ?? closes.at(-1)!,
    ema200: ema200v.at(-1) ?? closes.at(-1)!,
  };

  // === 8. MARKET STRUCTURE (BOS / CHoCH) — Zero lag, price action ===
  const marketStructure = detectMarketStructure(candles.slice(-30));

  // === 9. VOLUME PROFILE SIMULATION (High Volume Nodes) ===
  const volProfile = computeVolumeProfile(candles.slice(-100));

  // === 10. FAIR VALUE GAPS ===
  const fvgs = detectFairValueGaps(candles.slice(-50));

  // === 11. ORDER BLOCKS (Institutional entry zones) ===
  const orderBlocks = detectOrderBlocks(candles.slice(-50));

  // === 12. LIQUIDITY SWEEP ===
  const liquiditySweep = detectLiquiditySweep(candles.slice(-20));

  // === 13. CANDLESTICK PATTERNS ===
  const patterns = detectPatterns(candles.slice(-5));

  // === 14. STOCHASTIC ===
  const stochValues = Stochastic.calculate({
    high: highs, low: lows, close: closes, period: 14, signalPeriod: 3,
  });
  const lastStoch = stochValues.at(-1);
  const stochastic = { k: lastStoch?.k ?? 50, d: lastStoch?.d ?? 50 };

  // === 15. PIVOT POINTS ===
  const price = closes.at(-1)!;
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const pivot = (recentHigh + recentLow + price) / 3;
  const support = pivot - (recentHigh - pivot);
  const resistance = (2 * pivot) - recentLow;

  // === 16. WEIGHTED CONFLUENCE SCORE ===
  const confluence = computeConfluenceScore({
    price, ema, vwap, vwapBands, ichimoku, rsi,
    rsiDivergence, macdMomentumShift, marketStructure,
    bbands, volumes, candles, fvgs, orderBlocks,
    regime, liquiditySweep,
  });

  // === 17. TREND DETERMINATION ===
  const trend = determineTrend({ price, ema, ichimoku, marketStructure, confluence });

  return {
    trend, rsi, macd, bbands, ema, atr, stochastic,
    support: Math.min(support, volProfile.nearestSupport),
    resistance: Math.max(resistance, volProfile.nearestResistance),
    patterns: [
      ...patterns,
      ...rsiDivergence.signals,
      ...marketStructure.signals,
      ...(ichimoku.kumoTwist ? ['Kumo Twist ⚡'] : []),
      ...(ichimoku.tkCross !== 'none' ? [`TK Cross ${ichimoku.tkCross === 'bullish' ? '↑' : '↓'}`] : []),
      ...(macdMomentumShift !== 'none' ? [`MACD Momentum ${macdMomentumShift === 'up' ? '↑' : '↓'}`] : []),
      ...fvgs.filter(f => f.active).map(f => `FVG ${f.type === 'bullish' ? '🟢' : '🔴'} $${f.low.toFixed(2)}-$${f.high.toFixed(2)}`),
      ...orderBlocks.filter(ob => ob.fresh).map(ob => `OB ${ob.type === 'bullish' ? '🏗️↑' : '🏗️↓'} $${ob.low.toFixed(2)}-$${ob.high.toFixed(2)}`),
      ...(liquiditySweep.type === 'BULLISH_SWEEP' ? ['Bullish Liquidity Sweep 🧹⬆️'] : []),
      ...(liquiditySweep.type === 'BEARISH_SWEEP' ? ['Bearish Liquidity Sweep 🧹⬇️'] : []),
    ],
    score: confluence.total,
    // Extended data for AI prompt
    vwap, vwapBands, ichimoku, marketStructure, rsiDivergence, confluence,
    fvgs, orderBlocks, regime, liquiditySweep,
  } as TechnicalSummary;
}

// ============================================================
// ICHIMOKU CLOUD — Full 5-component implementation
// ============================================================

interface IchimokuData {
  tenkan: number;   // Conversion line (9-period median)
  kijun: number;    // Base line (26-period median)
  senkouA: number;  // Leading span A (plotted 26 ahead)
  senkouB: number;  // Leading span B (52-period median, plotted 26 ahead)
  chikou: number;   // Lagging span (current close, plotted 26 behind)
  cloudTop: number;
  cloudBottom: number;
  cloudColor: 'green' | 'red';
  priceAboveCloud: boolean;
  priceBelowCloud: boolean;
  priceInCloud: boolean;
  tkCross: 'bullish' | 'bearish' | 'none';
  kumoTwist: boolean;  // Cloud color change = major signal
  chikouBullish: boolean;
}

function computeIchimoku(candles: Candle[]): IchimokuData {
  const n = candles.length;
  if (n < 52) {
    const p = candles.at(-1)!.close;
    return {
      tenkan: p, kijun: p, senkouA: p, senkouB: p, chikou: p,
      cloudTop: p * 1.01, cloudBottom: p * 0.99, cloudColor: 'red',
      priceAboveCloud: false, priceBelowCloud: false, priceInCloud: true,
      tkCross: 'none', kumoTwist: false, chikouBullish: false,
    };
  }

  const midpoint = (start: number, len: number) => {
    const slice = candles.slice(start, start + len);
    return (Math.max(...slice.map(c => c.high)) + Math.min(...slice.map(c => c.low))) / 2;
  };

  const tenkan = midpoint(n - 9, 9);
  const kijun = midpoint(n - 26, 26);
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = midpoint(n - 52, 52);
  const chikou = candles.at(-1)!.close;

  // Previous period for TK cross detection
  const prevTenkan = midpoint(n - 10, 9);
  const prevKijun = midpoint(n - 27, 26);

  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const price = chikou;

  const tkCross: IchimokuData['tkCross'] =
    prevTenkan <= prevKijun && tenkan > kijun ? 'bullish' :
    prevTenkan >= prevKijun && tenkan < kijun ? 'bearish' : 'none';

  // Kumo Twist: cloud changes color (SenkouA crosses SenkouB)
  const prevSenkouA = midpoint(n - 27, 9) + midpoint(n - 53, 26); // simplified
  const kumoTwist = (prevSenkouA > senkouB) !== (senkouA > senkouB);

  // Chikou above price from 26 periods ago
  const price26ago = candles.at(-27)?.close ?? price;
  const chikouBullish = chikou > price26ago;

  return {
    tenkan, kijun, senkouA, senkouB, chikou,
    cloudTop, cloudBottom,
    cloudColor: senkouA >= senkouB ? 'green' : 'red',
    priceAboveCloud: price > cloudTop,
    priceBelowCloud: price < cloudBottom,
    priceInCloud: price >= cloudBottom && price <= cloudTop,
    tkCross,
    kumoTwist,
    chikouBullish,
  };
}

// ============================================================
// VWAP (Volume-Weighted Average Price) + Bands
// ============================================================

function computeVWAP(candles: Candle[]): number {
  let sumPV = 0;
  let sumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    sumPV += typical * c.volume;
    sumV += c.volume;
  }
  return sumV > 0 ? sumPV / sumV : candles.at(-1)!.close;
}

function computeVWAPBands(candles: Candle[], vwap: number): { upper1: number; upper2: number; lower1: number; lower2: number } {
  let sumV = 0;
  let sumVariance = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    sumV += c.volume;
    sumVariance += c.volume * Math.pow(typical - vwap, 2);
  }
  const stdDev = sumV > 0 ? Math.sqrt(sumVariance / sumV) : vwap * 0.01;
  return {
    upper1: vwap + stdDev,
    upper2: vwap + 2 * stdDev,
    lower1: vwap - stdDev,
    lower2: vwap - 2 * stdDev,
  };
}

// ============================================================
// MARKET STRUCTURE: BOS (Break of Structure) & CHoCH
// ============================================================

interface MarketStructure {
  type: 'uptrend' | 'downtrend' | 'ranging';
  lastBOS: 'bullish' | 'bearish' | 'none';
  lastCHoCH: 'bullish' | 'bearish' | 'none';
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  signals: string[];
}

function detectMarketStructure(candles: Candle[]): MarketStructure {
  if (candles.length < 10) {
    return {
      type: 'ranging', lastBOS: 'none', lastCHoCH: 'none',
      higherHighs: false, higherLows: false, lowerHighs: false, lowerLows: false, signals: [],
    };
  }

  // Detect swing highs and lows (simplified: local maxima/minima)
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  // Split candles into halves to detect HH/HL/LH/LL
  const mid = Math.floor(candles.length / 2);
  const firstHigh = Math.max(...highs.slice(0, mid));
  const secondHigh = Math.max(...highs.slice(mid));
  const firstLow = Math.min(...lows.slice(0, mid));
  const secondLow = Math.min(...lows.slice(mid));

  const higherHighs = secondHigh > firstHigh;
  const higherLows = secondLow > firstLow;
  const lowerHighs = secondHigh < firstHigh;
  const lowerLows = secondLow < firstLow;

  const signals: string[] = [];
  let lastBOS: MarketStructure['lastBOS'] = 'none';
  let lastCHoCH: MarketStructure['lastCHoCH'] = 'none';

  // Determine market structure type
  let type: MarketStructure['type'] = 'ranging';
  if (higherHighs && higherLows) {
    type = 'uptrend';
    signals.push('HH+HL (Uptrend Structure)');
    lastBOS = 'bullish';
  } else if (lowerHighs && lowerLows) {
    type = 'downtrend';
    signals.push('LH+LL (Downtrend Structure)');
    lastBOS = 'bearish';
  }

  // CHoCH detection (first sign of reversal)
  if (type === 'uptrend' && lowerHighs) {
    lastCHoCH = 'bearish';
    signals.push('CHoCH ⚠️ (Bearish Change of Character)');
  } else if (type === 'downtrend' && higherHighs) {
    lastCHoCH = 'bullish';
    signals.push('CHoCH ⚡ (Bullish Change of Character)');
  }

  // Detect recent Break of Structure
  const lastClose = closes.at(-1)!;
  const prevHigh = Math.max(...highs.slice(-10, -1));
  const prevLow = Math.min(...lows.slice(-10, -1));
  if (lastClose > prevHigh) {
    lastBOS = 'bullish';
    signals.push('BOS ↑ (Bullish Break of Structure)');
  } else if (lastClose < prevLow) {
    lastBOS = 'bearish';
    signals.push('BOS ↓ (Bearish Break of Structure)');
  }

  return { type, lastBOS, lastCHoCH, higherHighs, higherLows, lowerHighs, lowerLows, signals };
}

// ============================================================
// RSI DIVERGENCE (Leading signal)
// ============================================================

interface RSIDivergence {
  regularBullish: boolean;  // Price LL, RSI HL → potential reversal up
  regularBearish: boolean;  // Price HH, RSI LH → potential reversal down
  hiddenBullish: boolean;   // Price HL, RSI LL → trend continuation up
  hiddenBearish: boolean;   // Price LH, RSI HH → trend continuation down
  signals: string[];
}

function detectRSIDivergence(closes: number[], rsiValues: number[]): RSIDivergence {
  const signals: string[] = [];
  let regularBullish = false, regularBearish = false;
  let hiddenBullish = false, hiddenBearish = false;

  if (closes.length < 10 || rsiValues.length < 10) {
    return { regularBullish, regularBearish, hiddenBullish, hiddenBearish, signals };
  }

  const n = Math.min(closes.length, rsiValues.length);
  const mid = Math.floor(n / 2);

  const firstPriceHigh = Math.max(...closes.slice(0, mid));
  const secondPriceHigh = Math.max(...closes.slice(mid));
  const firstPriceLow = Math.min(...closes.slice(0, mid));
  const secondPriceLow = Math.min(...closes.slice(mid));

  const firstRSIhigh = Math.max(...rsiValues.slice(0, mid));
  const secondRSIhigh = Math.max(...rsiValues.slice(mid));
  const firstRSIlow = Math.min(...rsiValues.slice(0, mid));
  const secondRSIlow = Math.min(...rsiValues.slice(mid));

  // Regular Bearish: Price HH + RSI LH (momentum weakening at top)
  if (secondPriceHigh > firstPriceHigh && secondRSIhigh < firstRSIhigh) {
    regularBearish = true;
    signals.push('RSI Regular Bearish Divergence ⚠️');
  }

  // Regular Bullish: Price LL + RSI HL (momentum recovering at bottom)
  if (secondPriceLow < firstPriceLow && secondRSIlow > firstRSIlow) {
    regularBullish = true;
    signals.push('RSI Regular Bullish Divergence ⚡');
  }

  // Hidden Bullish: Price HL + RSI LL (trend continuation signal)
  if (secondPriceLow > firstPriceLow && secondRSIlow < firstRSIlow) {
    hiddenBullish = true;
    signals.push('RSI Hidden Bullish Divergence ↑');
  }

  // Hidden Bearish: Price LH + RSI HH (trend continuation signal)
  if (secondPriceHigh < firstPriceHigh && secondRSIhigh > firstRSIhigh) {
    hiddenBearish = true;
    signals.push('RSI Hidden Bearish Divergence ↓');
  }

  return { regularBullish, regularBearish, hiddenBullish, hiddenBearish, signals };
}

// ============================================================
// MACD MOMENTUM SHIFT (better than crossover)
// ============================================================

function getMacdMomentumShift(macdSlice: any[]): 'up' | 'down' | 'none' {
  if (macdSlice.length < 3) return 'none';
  const hists = macdSlice.map(m => m?.histogram ?? 0);
  const recent = hists.slice(-3);
  // Histogram increasing = bullish momentum shift
  if (recent[2] > recent[1] && recent[1] > recent[0] && recent[2] > 0) return 'up';
  if (recent[2] < recent[1] && recent[1] < recent[0] && recent[2] < 0) return 'down';
  return 'none';
}

// ============================================================
// VOLUME PROFILE (simulated — high/low volume nodes)
// ============================================================

function computeVolumeProfile(candles: Candle[]): {
  poc: number;
  nearestSupport: number;
  nearestResistance: number;
  hvns: number[];
} {
  if (candles.length === 0) return { poc: 0, nearestSupport: 0, nearestResistance: 1e9, hvns: [] };

  const price = candles.at(-1)!.close;
  const priceMin = Math.min(...candles.map(c => c.low));
  const priceMax = Math.max(...candles.map(c => c.high));
  const bucketCount = 20;
  const bucketSize = (priceMax - priceMin) / bucketCount;

  if (bucketSize === 0) return { poc: price, nearestSupport: price * 0.97, nearestResistance: price * 1.03, hvns: [] };

  const buckets: number[] = new Array(bucketCount).fill(0);

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(Math.floor((typical - priceMin) / bucketSize), bucketCount - 1);
    buckets[idx] += c.volume;
  }

  // POC = bucket with highest volume
  const maxVol = Math.max(...buckets);
  const pocIdx = buckets.indexOf(maxVol);
  const poc = priceMin + pocIdx * bucketSize + bucketSize / 2;

  // High Volume Nodes (top 30% volume buckets)
  const threshold = maxVol * 0.7;
  const hvns = buckets
    .map((v, i) => v >= threshold ? priceMin + i * bucketSize + bucketSize / 2 : 0)
    .filter(p => p > 0);

  // Nearest support/resistance from HVNs
  const below = hvns.filter(h => h < price);
  const above = hvns.filter(h => h > price);
  const nearestSupport = below.length > 0 ? Math.max(...below) : price * 0.97;
  const nearestResistance = above.length > 0 ? Math.min(...above) : price * 1.03;

  return { poc, nearestSupport, nearestResistance, hvns };
}

// ============================================================
// WEIGHTED CONFLUENCE SCORE (The core quality metric)
// Replaces simplistic -100 to +100 score
// ============================================================

interface ConfluenceScore {
  total: number;  // -100 to +100
  breakdown: Record<string, number>;
  signals: string[];
}

function computeConfluenceScore(params: {
  price: number;
  ema: { ema9: number; ema21: number; ema50: number; ema200: number };
  vwap: number;
  vwapBands: { upper1: number; upper2: number; lower1: number; lower2: number };
  ichimoku: IchimokuData;
  rsi: number;
  rsiDivergence: RSIDivergence;
  macdMomentumShift: 'up' | 'down' | 'none';
  marketStructure: MarketStructure;
  bbands: { upper: number; middle: number; lower: number; width: number };
  volumes: number[];
  candles: Candle[];
  fvgs?: Array<{ type: 'bullish'|'bearish'; high: number; low: number; active: boolean; strength: number; midpoint: number }>;
  orderBlocks?: Array<{ type: 'bullish'|'bearish'; high: number; low: number; fresh: boolean; strength: number; midpoint: number }>;
  regime?: RegimeResult;
  liquiditySweep?: LiquiditySweep;
}): ConfluenceScore {
  const { price, ema, vwap, vwapBands, ichimoku, rsi,
    rsiDivergence, macdMomentumShift, marketStructure, volumes } = params;

  const breakdown: Record<string, number> = {};
  const signals: string[] = [];
  let raw = 0;

  // === ICHIMOKU (weight: ±25) ===
  if (ichimoku.priceAboveCloud) {
    breakdown.ichimoku = ichimoku.tkCross === 'bullish' ? 25 : 18;
    signals.push(`Ichimoku: Price above ${ichimoku.cloudColor} cloud ↑`);
  } else if (ichimoku.priceBelowCloud) {
    breakdown.ichimoku = ichimoku.tkCross === 'bearish' ? -25 : -18;
    signals.push(`Ichimoku: Price below ${ichimoku.cloudColor} cloud ↓`);
  } else {
    breakdown.ichimoku = 0;
    signals.push('Ichimoku: Price in cloud (uncertain)');
  }

  // TK Cross bonus
  if (ichimoku.tkCross === 'bullish' && ichimoku.priceAboveCloud) {
    breakdown.tkCross = 8;
    signals.push('TK Cross Bullish ⚡ (strong)');
  } else if (ichimoku.tkCross === 'bearish' && ichimoku.priceBelowCloud) {
    breakdown.tkCross = -8;
  } else {
    breakdown.tkCross = 0;
  }

  // Chikou bullish
  breakdown.chikou = ichimoku.chikouBullish ? 5 : -5;

  // === VWAP (weight: ±20) ===
  if (price > vwap) {
    if (price > vwapBands.upper1) {
      breakdown.vwap = 10; // Stretched above VWAP — momentum but watch for rejection
      signals.push('Above VWAP +1σ (stretched, watch resistance)');
    } else {
      breakdown.vwap = 18;
      signals.push('Above VWAP (bullish bias) ↑');
    }
  } else {
    if (price < vwapBands.lower1) {
      breakdown.vwap = -10;
      signals.push('Below VWAP -1σ (stretched, watch support)');
    } else {
      breakdown.vwap = -18;
      signals.push('Below VWAP (bearish bias) ↓');
    }
  }

  // === MARKET STRUCTURE (weight: ±20) ===
  if (marketStructure.type === 'uptrend' && marketStructure.lastBOS === 'bullish') {
    breakdown.structure = 20;
  } else if (marketStructure.type === 'downtrend' && marketStructure.lastBOS === 'bearish') {
    breakdown.structure = -20;
  } else if (marketStructure.lastCHoCH === 'bullish') {
    breakdown.structure = 12;
  } else if (marketStructure.lastCHoCH === 'bearish') {
    breakdown.structure = -12;
  } else {
    breakdown.structure = 0;
  }

  // === RSI DIVERGENCE (weight: ±15) — leading signal ===
  if (rsiDivergence.hiddenBullish) {
    breakdown.divergence = 15; // Strong trend continuation signal
    signals.push('Hidden Bullish Divergence (trend continuation) ↑');
  } else if (rsiDivergence.hiddenBearish) {
    breakdown.divergence = -15;
    signals.push('Hidden Bearish Divergence (trend continuation) ↓');
  } else if (rsiDivergence.regularBullish) {
    breakdown.divergence = 12; // Reversal signal
    signals.push('Regular Bullish Divergence (reversal) ⚡');
  } else if (rsiDivergence.regularBearish) {
    breakdown.divergence = -12;
    signals.push('Regular Bearish Divergence (reversal) ⚠️');
  } else {
    breakdown.divergence = 0;
  }

  // === MACD MOMENTUM SHIFT (weight: ±8) ===
  breakdown.macdMomentum = macdMomentumShift === 'up' ? 8 : macdMomentumShift === 'down' ? -8 : 0;

  // === EMA TREND FILTER (weight: ±10) — only as filter, not trigger ===
  // EMA50 vs EMA200 (golden/death cross zone)
  if (ema.ema50 > ema.ema200 && price > ema.ema50) {
    breakdown.emaTrend = 10;
  } else if (ema.ema50 < ema.ema200 && price < ema.ema50) {
    breakdown.emaTrend = -10;
  } else if (ema.ema50 > ema.ema200) {
    breakdown.emaTrend = 5; // Above golden cross area but below EMA50
  } else {
    breakdown.emaTrend = -5;
  }

  // === VOLUME CONFIRMATION (weight: ±5) ===
  const recentVolAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const latestVol = volumes.at(-1) ?? 0;
  breakdown.volume = latestVol > recentVolAvg * 1.3 ? 5 : latestVol < recentVolAvg * 0.7 ? -3 : 0;
  if (breakdown.volume > 0) signals.push('High Volume Confirmation 📊');

  // Sum all components
  raw = Object.values(breakdown).reduce((a, b) => a + b, 0);

  // === FVG BONUS (weight: ±8) — Price near unfilled FVG ===
  if (params.fvgs) {
    const nearFVG = params.fvgs.find(f => f.active && params.price >= f.low && params.price <= f.high);
    if (nearFVG) {
      breakdown.fvg = nearFVG.type === 'bullish' ? 8 * nearFVG.strength / 3 : -8 * nearFVG.strength / 3;
      signals.push(`Price in ${nearFVG.type} FVG (imbalance zone) ⚡`);
      raw += breakdown.fvg;
    }
  }

  // === ORDER BLOCK BONUS (weight: ±10) — Price at institutional OB ===
  if (params.orderBlocks) {
    const nearOB = params.orderBlocks.find(ob => ob.fresh && params.price >= ob.low && params.price <= ob.high);
    if (nearOB) {
      breakdown.orderBlock = nearOB.type === 'bullish' ? 10 * nearOB.strength / 3 : -10 * nearOB.strength / 3;
      signals.push(`Price at ${nearOB.type} Order Block 🏛️`);
      raw += breakdown.orderBlock;
    }
  }

  const total = Math.max(-100, Math.min(100, Math.round(raw)));
  return { total, breakdown, signals };
}

// ============================================================
// TREND DETERMINATION (Multi-factor, not EMA-only)
// ============================================================

function determineTrend(params: {
  price: number;
  ema: { ema9: number; ema21: number; ema50: number; ema200: number };
  ichimoku: IchimokuData;
  marketStructure: MarketStructure;
  confluence: ConfluenceScore;
}): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  const { confluence } = params;
  if (confluence.total >= 30) return 'BULLISH';
  if (confluence.total <= -30) return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================================
// CANDLESTICK PATTERNS (enhanced)
// ============================================================

function detectPatterns(candles: Candle[]): string[] {
  const patterns: string[] = [];
  if (candles.length < 3) return patterns;

  const c = candles.at(-1)!;
  const p = candles.at(-2)!;
  const pp = candles.at(-3)!;

  const cBody = Math.abs(c.close - c.open);
  const cRange = c.high - c.low;
  const cLowerShadow = Math.min(c.open, c.close) - c.low;
  const cUpperShadow = c.high - Math.max(c.open, c.close);

  // Doji (indecision)
  if (cBody < cRange * 0.08) patterns.push('Doji 🕯️');

  // Pin Bar / Hammer (strong reversal)
  if (cLowerShadow > cBody * 2.5 && cUpperShadow < cBody * 0.5) {
    patterns.push(c.close > c.open ? 'Hammer (Bullish) 🔨' : 'Hanging Man (Bearish)');
  }

  // Inverted Hammer / Shooting Star
  if (cUpperShadow > cBody * 2.5 && cLowerShadow < cBody * 0.5) {
    patterns.push(c.close > c.open ? 'Inverted Hammer' : 'Shooting Star (Bearish) ⭐');
  }

  // Engulfing (strong reversal signal)
  const pBody = Math.abs(p.close - p.open);
  if (c.open < Math.min(p.open, p.close) && c.close > Math.max(p.open, p.close) && c.close > c.open) {
    patterns.push('Bullish Engulfing 🟢');
  }
  if (c.open > Math.max(p.open, p.close) && c.close < Math.min(p.open, p.close) && c.close < c.open) {
    patterns.push('Bearish Engulfing 🔴');
  }

  // Three candle patterns
  if (pp.close < pp.open && // First bearish
    Math.abs(p.close - p.open) < (p.high - p.low) * 0.25 && // Star (small body)
    c.close > c.open && c.close > pp.open) { // Third bullish closing above first
    patterns.push('Morning Star ⭐ (Bullish Reversal)');
  }
  if (pp.close > pp.open &&
    Math.abs(p.close - p.open) < (p.high - p.low) * 0.25 &&
    c.close < c.open && c.close < pp.open) {
    patterns.push('Evening Star ⭐ (Bearish Reversal)');
  }

  return patterns;
}

// ============================================================
// EMPTY FALLBACK
// ============================================================

function emptyTech(price: number): TechnicalSummary {
  return {
    trend: 'NEUTRAL', rsi: 50,
    macd: { line: 0, signal: 0, histogram: 0 },
    bbands: { upper: price * 1.02, middle: price, lower: price * 0.98 },
    ema: { ema9: price, ema21: price, ema50: price, ema200: price },
    atr: 0, stochastic: { k: 50, d: 50 },
    support: price * 0.97, resistance: price * 1.03,
    patterns: [], score: 0,
  } as TechnicalSummary;
}

// ============================================================
// FAIR VALUE GAPS (FVG / Imbalance Zones)
//
// A Fair Value Gap is a 3-candle pattern where:
// - Bullish FVG: candle[i+2].low > candle[i].high → gap between
// - Bearish FVG: candle[i+2].high < candle[i].low → gap between
// These are areas where price moved so fast it left no overlap,
// creating an imbalance that tends to be revisited.
// ============================================================

interface FVG {
  type: 'bullish' | 'bearish';
  high: number; low: number;
  midpoint: number;
  active: boolean;
  strength: number; // 1-3
}

function detectFairValueGaps(candles: Candle[]): FVG[] {
  const fvgs: FVG[] = [];
  const currentPrice = candles.at(-1)?.close ?? 0;

  // ATR for strength classification
  const closes = candles.map(c => c.close);
  const atrApprox = closes.slice(-10).reduce((s, c, i, a) => i === 0 ? s : s + Math.abs(c - a[i-1]), 0) / 9;

  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    // Bullish FVG: gap between c1.high and c3.low
    if (c3.low > c1.high) {
      const gapSize = c3.low - c1.high;
      const strength = Math.min(3, Math.ceil(gapSize / (atrApprox || gapSize) * 1.5));
      const isActive = currentPrice <= c3.low || currentPrice >= c1.high; // not filled
      fvgs.push({
        type: 'bullish', high: c3.low, low: c1.high,
        midpoint: (c1.high + c3.low) / 2,
        active: isActive && currentPrice >= c1.high * 0.95, // within reach
        strength,
      });
    }

    // Bearish FVG: gap between c3.high and c1.low
    if (c3.high < c1.low) {
      const gapSize = c1.low - c3.high;
      const strength = Math.min(3, Math.ceil(gapSize / (atrApprox || gapSize) * 1.5));
      const isActive = currentPrice >= c3.high || currentPrice <= c1.low;
      fvgs.push({
        type: 'bearish', high: c1.low, low: c3.high,
        midpoint: (c1.low + c3.high) / 2,
        active: isActive && currentPrice <= c1.low * 1.05,
        strength,
      });
    }
  }

  // Return most recent 5 active FVGs (closest to current price)
  return fvgs
    .filter(f => f.active)
    .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice))
    .slice(0, 5);
}

// ============================================================
// ORDER BLOCKS (Institutional Entry Zones)
//
// An Order Block is the LAST candle of the OPPOSITE color before
// a strong move (displacement) in the opposite direction.
// Bullish OB: Last bearish candle before a bullish impulse move
// Bearish OB: Last bullish candle before a bearish impulse move
//
// These are zones where institutions placed their entries,
// creating strong support/resistance when price returns.
// ============================================================

interface OrderBlock {
  type: 'bullish' | 'bearish';
  high: number; low: number;
  midpoint: number;
  fresh: boolean;   // Not yet retested
  strength: number; // 1-3
}

function detectOrderBlocks(candles: Candle[]): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  const currentPrice = candles.at(-1)?.close ?? 0;
  const n = candles.length;

  for (let i = 2; i < n - 3; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const next2 = candles.slice(i + 1, i + 4); // 3 candles after

    // Check for displacement move (strong impulse)
    const impulseRange = next2.reduce((max, nc) => Math.max(max, Math.abs(nc.close - nc.open)), 0);
    const candleRange = Math.abs(c.close - c.open);
    const isDisplacement = impulseRange > candleRange * 2.0;

    if (!isDisplacement) continue;

    const overallUp = next2.at(-1)!.close > c.high;
    const overallDown = next2.at(-1)!.close < c.low;

    // Bullish OB: bearish candle (last down candle before bullish impulse)
    if (overallUp && c.close < c.open) {
      const isFresh = currentPrice > c.high || !next2.some(nc => nc.low <= c.high); // Not retested
      const strength = Math.min(3, Math.ceil(impulseRange / (candleRange || impulseRange) * 1.5));
      blocks.push({
        type: 'bullish', high: c.high, low: c.low,
        midpoint: (c.high + c.low) / 2,
        fresh: isFresh && currentPrice >= c.low * 0.98 && currentPrice <= c.high * 1.02,
        strength,
      });
    }

    // Bearish OB: bullish candle before bearish impulse
    if (overallDown && c.close > c.open) {
      const isFresh = currentPrice < c.low || !next2.some(nc => nc.high >= c.low);
      const strength = Math.min(3, Math.ceil(impulseRange / (candleRange || impulseRange) * 1.5));
      blocks.push({
        type: 'bearish', high: c.high, low: c.low,
        midpoint: (c.high + c.low) / 2,
        fresh: isFresh && currentPrice >= c.low * 0.98 && currentPrice <= c.high * 1.02,
        strength,
      });
    }
  }

  // Return most recent fresh blocks closest to current price
  return blocks
    .filter(ob => ob.fresh)
    .sort((a, b) => Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice))
    .slice(0, 4);
}

// ============================================================
// FIBONACCI RETRACEMENT
// ============================================================

export function fibonacciLevels(high: number, low: number): Record<string, number> {
  const diff = high - low;
  return {
    '0%': high, '23.6%': high - diff * 0.236,
    '38.2%': high - diff * 0.382, '50%': high - diff * 0.5,
    '61.8%': high - diff * 0.618, '78.6%': high - diff * 0.786,
    '100%': low,
  };
}
