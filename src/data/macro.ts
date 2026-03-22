// ============================================================
// MACRO OVERLAY — DXY & Market Context
//
// Professional traders always check macro context:
//   - USD Strength (DXY) → weak DXY = risk-on = crypto/gold up
//   - VIX equivalent    → high fear = reduce position sizes
//   - Market Regime     → correlated to major assets
//
// Sources:
//   - DXY (US Dollar Index) via Yahoo Finance (UUP ETF approximation)
//   - Fear & Greed for general sentiment
//   - Gold correlation (positive when risk-off)
//
// Output: MacroContext used by orchestrator to adjust bias
// ============================================================

import axios from 'axios';

export interface MacroContext {
  dxy: number;          // Current DXY value (approx via UUP)
  dxyChange24h: number; // % change
  dxyBias: 'STRONG' | 'WEAK' | 'NEUTRAL'; // Strong DXY = bearish for crypto/gold
  goldPrice: number;
  goldChange24h: number;
  riskSentiment: 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL';
  description: string;
  // Strategy implications
  cryptoBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  forexBias: 'USD_STRONG' | 'USD_WEAK' | 'NEUTRAL';
  goldBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  updatedAt: number;
}

let cachedMacro: MacroContext | null = null;
let lastFetch = 0;
const CACHE_MS = 15 * 60 * 1000; // 15-minute cache

// ── Fetch DXY from Yahoo Finance (UUP ETF = USD bullish ETF) ─
async function fetchDXY(): Promise<{ price: number; change: number }> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB';
    const { data } = await axios.get(url, {
      params: { interval: '1d', range: '5d' },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No DXY data');

    const closes: number[] = result.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(Boolean);
    if (validCloses.length < 2) throw new Error('Insufficient DXY data');

    const price = validCloses.at(-1)!;
    const prev = validCloses.at(-2)!;
    const change = ((price - prev) / prev) * 100;

    return { price, change };
  } catch {
    // Default to neutral if unavailable
    return { price: 103.5, change: 0 };
  }
}

// ── Fetch Gold via Yahoo Finance ─────────────────────────────
async function fetchGold(): Promise<{ price: number; change: number }> {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF';
    const { data } = await axios.get(url, {
      params: { interval: '1d', range: '5d' },
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const result = data?.chart?.result?.[0];
    const closes: number[] = result?.indicators?.quote?.[0]?.close ?? [];
    const validCloses = closes.filter(Boolean);
    if (validCloses.length < 2) throw new Error('No gold data');
    const price = validCloses.at(-1)!;
    const change = ((price - validCloses.at(-2)!) / validCloses.at(-2)!) * 100;
    return { price, change };
  } catch {
    return { price: 3010, change: 0 };
  }
}

// ============================================================
// BUILD MACRO CONTEXT
// ============================================================
export async function getMacroContext(): Promise<MacroContext> {
  const now = Date.now();
  if (cachedMacro && now - lastFetch < CACHE_MS) {
    return cachedMacro;
  }

  const [dxyData, goldData] = await Promise.all([fetchDXY(), fetchGold()]);

  const { price: dxy, change: dxyChange } = dxyData;
  const { price: goldPrice, change: goldChange } = goldData;

  // DXY bias classification
  let dxyBias: MacroContext['dxyBias'];
  if (dxy > 104 && dxyChange > 0.2) dxyBias = 'STRONG';
  else if (dxy < 102 || dxyChange < -0.2) dxyBias = 'WEAK';
  else dxyBias = 'NEUTRAL';

  // Risk sentiment based on gold move + DXY
  let riskSentiment: MacroContext['riskSentiment'];
  if (goldChange > 0.5 && dxyBias === 'WEAK') riskSentiment = 'RISK_OFF'; // Flight to safety
  else if (dxyBias === 'STRONG' && goldChange < -0.3) riskSentiment = 'RISK_OFF';
  else if (dxyBias === 'WEAK' && goldChange > 0) riskSentiment = 'RISK_ON'; // Risk assets rally
  else riskSentiment = 'NEUTRAL';

  // Asset-specific implications
  const cryptoBias: MacroContext['cryptoBias'] =
    dxyBias === 'WEAK' ? 'BULLISH' : dxyBias === 'STRONG' ? 'BEARISH' : 'NEUTRAL';
  const forexBias: MacroContext['forexBias'] =
    dxyBias === 'STRONG' ? 'USD_STRONG' : dxyBias === 'WEAK' ? 'USD_WEAK' : 'NEUTRAL';
  const goldBias: MacroContext['goldBias'] =
    riskSentiment === 'RISK_OFF' ? 'BULLISH' : riskSentiment === 'RISK_ON' && dxyBias === 'STRONG' ? 'BEARISH' : 'NEUTRAL';

  const description = `DXY=${dxy.toFixed(2)} (${dxyChange >= 0 ? '+' : ''}${dxyChange.toFixed(2)}%) | Gold=$${goldPrice.toFixed(0)} (${goldChange >= 0 ? '+' : ''}${goldChange.toFixed(2)}%) | Sentiment: ${riskSentiment}`;

  cachedMacro = {
    dxy, dxyChange24h: dxyChange, dxyBias,
    goldPrice, goldChange24h: goldChange,
    riskSentiment, description,
    cryptoBias, forexBias, goldBias,
    updatedAt: now,
  };
  lastFetch = now;

  console.log(`[Macro] 🌐 ${description}`);
  return cachedMacro;
}

// ── Get macro confluence bonus for a given pair ──────────────
export function getMacroConfluenceForPair(
  pair: string,
  macro: MacroContext,
  signalDirection: 'BUY' | 'SELL' | 'HOLD'
): number {
  if (signalDirection === 'HOLD') return 0;

  const isCrypto = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'LTC'].some(s => pair.startsWith(s));
  const isGold = pair === 'XAUUSD' || pair === 'XAGUSD';
  const isOil = pair === 'USOIL';
  const isForex = !isCrypto && !isGold && !isOil;

  let bonus = 0;

  if (isCrypto) {
    if (signalDirection === 'BUY' && macro.cryptoBias === 'BULLISH') bonus = 8;
    else if (signalDirection === 'BUY' && macro.cryptoBias === 'BEARISH') bonus = -12;
  }
  if (isGold) {
    if (signalDirection === 'BUY' && macro.goldBias === 'BULLISH') bonus = 8;
    else if (signalDirection === 'BUY' && macro.goldBias === 'BEARISH') bonus = -10;
  }
  if (isForex) {
    // USD pairs: EURUSD — bullish EUR = weak USD
    if (macro.forexBias === 'USD_STRONG' && signalDirection === 'BUY' && pair.startsWith('EUR')) bonus = -6;
    else if (macro.forexBias === 'USD_WEAK' && signalDirection === 'BUY' && pair.startsWith('EUR')) bonus = 6;
  }

  return bonus;
}
