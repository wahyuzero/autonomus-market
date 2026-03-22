// ============================================================
// FUNDAMENTAL ANALYSIS — Real on-chain & sentiment data
// 
// Using free public APIs:
// - Fear & Greed Index (alternative.me)
// - Binance Futures: Funding Rate + Open Interest + Long/Short Ratio
// - CryptoCompare: News headlines
// - CoinGecko: BTC dominance + global market cap
// ============================================================

import axios from 'axios';
import { askAI } from '../ai/client';

// Cache strutures
const fundamentalCache: Map<string, { text: string; timestamp: number }> = new Map();
const globalDataCache: { data: GlobalData | null; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes
const GLOBAL_CACHE_TTL = 5 * 60 * 1000;

interface FundingData {
  fundingRate: number;
  openInterest: number;
  longShortRatio: number;
}

interface GlobalData {
  fearGreedIndex: number;
  fearGreedLabel: string;
  btcDominance: number;
  totalMarketCap: number;
  totalVolume24h: number;
}

// ============================================================
// Fetch Fear & Greed Index (alternative.me — completely free)
// ============================================================

async function fetchFearGreedIndex(): Promise<{ value: number; label: string }> {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/', {
      params: { limit: 1 },
      timeout: 8000,
    });
    const d = data?.data?.[0];
    return {
      value: parseInt(d?.value ?? '50'),
      label: d?.value_classification ?? 'Neutral',
    };
  } catch {
    return { value: 50, label: 'Neutral (unavailable)' };
  }
}

// ============================================================
// Fetch Binance Futures Data (funding rate, OI, long/short)
// ============================================================

async function fetchBinanceFuturesData(symbol: string): Promise<FundingData> {
  const baseSymbol = symbol.replace('USDT', '').replace('USD', '') + 'USDT';

  try {
    const [frRes, oiRes, lsRes] = await Promise.allSettled([
      axios.get('https://fapi.binance.com/fapi/v1/fundingRate', {
        params: { symbol: baseSymbol, limit: 1 }, timeout: 6000,
      }),
      axios.get('https://fapi.binance.com/fapi/v1/openInterest', {
        params: { symbol: baseSymbol }, timeout: 6000,
      }),
      axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
        params: { symbol: baseSymbol, period: '1h', limit: 1 }, timeout: 6000,
      }),
    ]);

    const fr = frRes.status === 'fulfilled' ? parseFloat(frRes.value.data?.[0]?.fundingRate ?? '0') : 0;
    const oi = oiRes.status === 'fulfilled' ? parseFloat(oiRes.value.data?.openInterest ?? '0') : 0;
    const ls = lsRes.status === 'fulfilled' ? parseFloat(lsRes.value.data?.[0]?.longShortRatio ?? '1') : 1;

    return { fundingRate: fr * 100, openInterest: oi, longShortRatio: ls };
  } catch {
    return { fundingRate: 0, openInterest: 0, longShortRatio: 1 };
  }
}

// ============================================================
// Fetch CoinGecko global market data (free, no key)
// ============================================================

async function fetchGlobalData(): Promise<GlobalData> {
  const now = Date.now();
  if (globalDataCache.data && now - globalDataCache.timestamp < GLOBAL_CACHE_TTL) {
    return globalDataCache.data;
  }

  try {
    const fearGreed = await fetchFearGreedIndex();
    const { data } = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 });

    const gd = data?.data;
    const result: GlobalData = {
      fearGreedIndex: fearGreed.value,
      fearGreedLabel: fearGreed.label,
      btcDominance: gd?.market_cap_percentage?.btc ?? 0,
      totalMarketCap: gd?.total_market_cap?.usd ?? 0,
      totalVolume24h: gd?.total_volume?.usd ?? 0,
    };

    globalDataCache.data = result;
    globalDataCache.timestamp = now;
    return result;
  } catch {
    const fearGreed = await fetchFearGreedIndex();
    const fallback: GlobalData = {
      fearGreedIndex: fearGreed.value,
      fearGreedLabel: fearGreed.label,
      btcDominance: 52,
      totalMarketCap: 0,
      totalVolume24h: 0,
    };
    globalDataCache.data = fallback;
    globalDataCache.timestamp = now;
    return fallback;
  }
}

// ============================================================
// Fetch crypto news (CryptoCompare — free)
// ============================================================

async function fetchCryptoNews(symbol: string): Promise<string[]> {
  const coin = symbol.replace('USDT', '').replace('USD', '');
  try {
    const { data } = await axios.get(
      `https://min-api.cryptocompare.com/data/v2/news/?categories=${coin},Blockchain&lang=EN&sortOrder=latest`,
      { timeout: 8000 }
    );
    return (data.Data ?? []).slice(0, 4).map((a: any) => `• ${a.title}`);
  } catch {
    return ['• News unavailable'];
  }
}

// ============================================================
// Build complete fundamental data package
// ============================================================

export interface FundamentalData {
  fearGreedIndex: number;
  fearGreedLabel: string;
  fundingRate: number;      // % (positive = longs paying, negative = shorts paying)
  fundingBias: string;      // interpretation
  openInterest: number;
  longShortRatio: number;
  btcDominance: number;
  newsHeadlines: string[];
  interpretation: string;   // AI-ready summary
}

async function fetchFundamentalData(pair: string): Promise<FundamentalData> {
  const isForex = !pair.endsWith('USDT');

  if (isForex) {
    // Forex: only global sentiment
    const global = await fetchGlobalData();
    return {
      fearGreedIndex: global.fearGreedIndex,
      fearGreedLabel: global.fearGreedLabel,
      fundingRate: 0,
      fundingBias: 'N/A (Forex pair)',
      openInterest: 0,
      longShortRatio: 1,
      btcDominance: global.btcDominance,
      newsHeadlines: [],
      interpretation: `Forex pair. Global risk sentiment: ${global.fearGreedLabel} (${global.fearGreedIndex}/100). BTC Dominance: ${global.btcDominance.toFixed(1)}%.`,
    };
  }

  const [global, futures, news] = await Promise.all([
    fetchGlobalData(),
    fetchBinanceFuturesData(pair),
    fetchCryptoNews(pair),
  ]);

  // Interpret funding rate
  let fundingBias = 'Neutral';
  if (futures.fundingRate > 0.1) fundingBias = '🔴 Extreme Long (squeeze risk)';
  else if (futures.fundingRate > 0.05) fundingBias = '⚠️ Overleveraged Long';
  else if (futures.fundingRate < -0.05) fundingBias = '⚠️ Overleveraged Short (potential squeeze)';
  else if (futures.fundingRate < -0.01) fundingBias = '🟢 Negative Rate (bullish for spot)';
  else fundingBias = '✅ Neutral Funding';

  // Interpret Fear & Greed
  const fgInterp = global.fearGreedIndex < 25
    ? '🟢 Extreme Fear — historically best buying zone'
    : global.fearGreedIndex < 40 ? '🟡 Fear — accumulation territory'
    : global.fearGreedIndex > 80 ? '🔴 Extreme Greed — high correction risk'
    : global.fearGreedIndex > 65 ? '🟠 Greed — elevated risk'
    : '⚪ Neutral';

  // Interpret Long/Short ratio
  const lsInterp = futures.longShortRatio > 1.5
    ? 'Crowd heavily long (contrarian bearish signal)'
    : futures.longShortRatio < 0.7
    ? 'Crowd heavily short (contrarian bullish — short squeeze risk)'
    : 'Balanced long/short';

  const interpretation = [
    `Fear & Greed: ${global.fearGreedIndex}/100 — ${fgInterp}`,
    `Funding Rate: ${futures.fundingRate > 0 ? '+' : ''}${futures.fundingRate.toFixed(4)}% — ${fundingBias}`,
    futures.longShortRatio > 0 ? `Long/Short Ratio: ${futures.longShortRatio.toFixed(2)} — ${lsInterp}` : '',
    `BTC Dominance: ${global.btcDominance.toFixed(1)}% (${global.btcDominance > 55 ? 'high = funds in BTC' : 'lower = altcoin season possible'})`,
  ].filter(Boolean).join('\n');

  return {
    fearGreedIndex: global.fearGreedIndex,
    fearGreedLabel: global.fearGreedLabel,
    fundingRate: futures.fundingRate,
    fundingBias,
    openInterest: futures.openInterest,
    longShortRatio: futures.longShortRatio,
    btcDominance: global.btcDominance,
    newsHeadlines: news,
    interpretation,
  };
}

// ============================================================
// PUBLIC: Get full fundamental context string for AI prompt
// ============================================================

export async function getFundamentalContext(pair: string): Promise<string> {
  const cached = fundamentalCache.get(pair);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.text;
  }

  const data = await fetchFundamentalData(pair);
  const coin = pair.replace('USDT', '').replace('USD', '');

  const prompt = `
## On-Chain & Market Data for ${pair}

${data.interpretation}

### Recent Headlines for ${coin}:
${data.newsHeadlines.length > 0 ? data.newsHeadlines.join('\n') : '• No news available'}

### Macro Context (March 2026):
- Global crypto market sentiment: ${data.fearGreedLabel}
- Institutional positioning: ${data.longShortRatio > 1.2 ? 'Bias toward longs' : data.longShortRatio < 0.8 ? 'Bias toward shorts' : 'Balanced'}
- ${data.btcDominance > 55 ? 'High BTC dominance suggests alts may underperform' : 'Lower BTC dominance suggests alt season dynamics'}

Provide a 2-3 sentence fundamental analysis for ${coin} relevant to the next 1-4 hours of trading.
Is the fundamental picture bullish, bearish, or neutral for a short-term trade? Key risks?
`;

  let text: string;
  try {
    text = await askAI(
      'You are a professional financial analyst specializing in on-chain data and crypto market microstructure. Be precise and brief.',
      prompt, undefined, 350
    );
  } catch {
    text = data.interpretation;
  }

  // Prepend raw data for AI context in analyst
  const fullContext = `${data.interpretation}\n\n### AI Fundamental Summary:\n${text}`;
  fundamentalCache.set(pair, { text: fullContext, timestamp: Date.now() });
  return fullContext;
}

export { fetchFundamentalData };
