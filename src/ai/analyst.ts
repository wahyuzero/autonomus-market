// ============================================================
// AI ANALYST - Market analysis via SemutSSH AI
// Upgraded prompt: includes Ichimoku, VWAP, Market Structure,
// RSI Divergence, Confluence Score, and Fundamental data
// ============================================================

import { askAI } from './client';
import { MarketData, AnalysisResult, TechnicalSummary, CONFIG } from '../config';

const SYSTEM_PROMPT = `You are an elite financial market analyst and quantitative trader with mastery of:

TECHNICAL ANALYSIS (ADVANCED):
- Ichimoku Cloud: Tenkan/Kijun cross, TK cross confirmation, cloud position, Chikou, Kumo Twist
- VWAP & Bands: Institutional price levels, mean reversion, breakout confirmation
- Market Structure: Break of Structure (BOS), Change of Character (CHoCH), Smart Money Concepts (SMC)
- RSI Divergence: Regular (reversal) and Hidden (continuation) divergences — leading signals
- Volume Profile: Point of Control (POC), High Volume Nodes as true S/R
- ATR-based dynamic TP/SL sizing

INDICATOR INTELLIGENCE:
- You KNOW that raw RSI overbought/oversold is unreliable in trending markets
- You KNOW raw MACD crossovers are double-lagging — you use momentum shifts instead
- You KNOW raw EMA crossovers are 60%+ false in ranging markets — you use them as FILTERS only
- You PRIORITIZE: Ichimoku position, VWAP level, market structure, divergences, volume

FUNDAMENTAL ANALYSIS:
- Fear & Greed Index: extreme readings are contrarian signals
- Funding Rate: extreme positive = long squeeze risk; extreme negative = short squeeze risk
- Open Interest trends: rising OI with rising price = healthy trend
- Long/Short Ratio: extreme crowding = contrarian signal
- BTC Dominance: affects altcoin behavior

RISK MANAGEMENT:
- R:R ratio must be at least 1.5:1 for any trade
- ATR-based TP/SL preferred over fixed percentages
- Never trade against strong fundamental headwinds

Always respond ONLY with valid JSON as specified. Be precise and decisive.`;

export async function analyzeMarket(
  data: MarketData,
  technical: TechnicalSummary,
  fundamentalContext: string,
  strategyName: string
): Promise<AnalysisResult> {
  const prompt = buildAnalysisPrompt(data, technical, fundamentalContext, strategyName);
  const raw = await askAI(SYSTEM_PROMPT, prompt);
  return parseAnalysisResponse(raw, data, technical);
}

function buildAnalysisPrompt(
  data: MarketData,
  tech: TechnicalSummary,
  fundamental: string,
  strategy: string
): string {
  const ich = tech.ichimoku;
  const ms = tech.marketStructure;
  const div = tech.rsiDivergence;
  const conf = tech.confluence;
  const latestCandles1h = data.candles['1h']?.slice(-5) ?? [];
  const latestCandles4h = data.candles['4h']?.slice(-5) ?? [];

  return `
## MARKET ANALYSIS REQUEST

**Pair**: ${data.pair} (${data.type.toUpperCase()})
**Price**: $${data.price.toFixed(6)}
**24h Change**: ${data.change24h.toFixed(2)}%
**Strategy**: ${strategy}
**Time**: ${new Date().toISOString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## WEIGHTED CONFLUENCE SCORE: ${tech.score}/100
─── Signal Quality ────────────────────
${conf ? Object.entries(conf.breakdown).map(([k, v]) => `  ${k}: ${v > 0 ? '+' : ''}${v}`).join('\n') : 'N/A'}
${conf?.signals?.length ? '\nActive Signals:\n' + conf.signals.map(s => `  → ${s}`).join('\n') : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ICHIMOKU CLOUD (Most Reliable Trend System)
${ich ? `
- Tenkan (Conv.): $${ich.tenkan.toFixed(4)} | Kijun (Base): $${ich.kijun.toFixed(4)}
- Cloud: ${ich.cloudColor.toUpperCase()} | Top: $${ich.cloudTop.toFixed(4)} | Bottom: $${ich.cloudBottom.toFixed(4)}
- Price Position: ${ich.priceAboveCloud ? '✅ ABOVE CLOUD (bullish)' : ich.priceBelowCloud ? '❌ BELOW CLOUD (bearish)' : '⚠️ INSIDE CLOUD (uncertain)'}
- TK Cross: ${ich.tkCross === 'bullish' ? '🟢 BULLISH TK Cross' : ich.tkCross === 'bearish' ? '🔴 BEARISH TK Cross' : '⚪ No TK Cross'}
- Chikou: ${ich.chikouBullish ? '🟢 Bullish (above price 26 bars ago)' : '🔴 Bearish'}
- Kumo Twist: ${ich.kumoTwist ? '⚡ YES — Major reversal signal!' : 'No'}
` : 'Insufficient candles for Ichimoku'}

## VWAP (Institutional Level)
- VWAP: $${tech.vwap?.toFixed(4) ?? 'N/A'}
${tech.vwapBands ? `
- VWAP +1σ: $${tech.vwapBands.upper1.toFixed(4)} | +2σ: $${tech.vwapBands.upper2.toFixed(4)}
- VWAP -1σ: $${tech.vwapBands.lower1.toFixed(4)} | -2σ: $${tech.vwapBands.lower2.toFixed(4)}
- Price vs VWAP: ${tech.vwap && data.price > tech.vwap ? `+${((data.price/tech.vwap - 1)*100).toFixed(2)}% above` : tech.vwap ? `${((data.price/tech.vwap - 1)*100).toFixed(2)}% below` : 'N/A'}` : ''}

## MARKET STRUCTURE (Zero Lag - Price Action)
${ms ? `
- Type: ${ms.type.toUpperCase()}
- Last BOS: ${ms.lastBOS !== 'none' ? ms.lastBOS.toUpperCase() + ' Break of Structure' : 'None'}
- CHoCH: ${ms.lastCHoCH !== 'none' ? '⚡ ' + ms.lastCHoCH.toUpperCase() + ' Change of Character' : 'None'}
- Signals: ${ms.signals.join(', ') || 'None'}
` : 'N/A'}

## RSI DIVERGENCE (Leading Signals)
${div ? `
- Regular Bullish: ${div.regularBullish ? '⚡ YES — potential reversal UP' : 'No'}
- Regular Bearish: ${div.regularBearish ? '⚠️ YES — potential reversal DOWN' : 'No'}
- Hidden Bullish: ${div.hiddenBullish ? '↑ YES — trend continuation UP' : 'No'}
- Hidden Bearish: ${div.hiddenBearish ? '↓ YES — trend continuation DOWN' : 'No'}
` : 'N/A'}

## CLASSICAL INDICATORS (Reference Only)
- RSI(14): ${tech.rsi.toFixed(2)} ${tech.rsi > 70 ? '(overbought zone — not a sell signal alone in trends)' : tech.rsi < 30 ? '(oversold zone — not a buy signal alone in trends)' : '(normal range)'}
- MACD Histogram: ${tech.macd.histogram.toFixed(4)} ${tech.macd.histogram > 0 ? '(bullish momentum)' : '(bearish momentum)'}
- BB Context: Width=${((tech.bbands.upper - tech.bbands.lower) / tech.bbands.middle * 100).toFixed(2)}% ${((tech.bbands.upper - tech.bbands.lower) / tech.bbands.middle) < 0.02 ? '(SQUEEZE — breakout imminent)' : ''}
- ATR(14): $${tech.atr.toFixed(4)} — use for TP/SL sizing
- EMA50/200: ${tech.ema.ema50 > tech.ema.ema200 ? 'Above (golden cross zone)' : 'Below (death cross zone)'}
- Patterns: ${tech.patterns.length > 0 ? tech.patterns.join(', ') : 'None'}
- Key S/R: Support $${tech.support.toFixed(4)} | Resistance $${tech.resistance.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## FUNDAMENTAL DATA
${fundamental}

## Recent H1 Candles
${latestCandles1h.map(c => `O:${c.open.toFixed(4)} H:${c.high.toFixed(4)} L:${c.low.toFixed(4)} C:${c.close.toFixed(4)}`).join('\n')}

## Recent H4 Candles
${latestCandles4h.map(c => `O:${c.open.toFixed(4)} H:${c.high.toFixed(4)} L:${c.low.toFixed(4)} C:${c.close.toFixed(4)}`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## YOUR TASK

Synthesize ALL data above using professional-grade analysis.
Consider: Ichimoku position, VWAP level, market structure, divergences, fundamental bias.
Do NOT just use RSI level alone. Do NOT use EMA crossovers as primary signals.
Set TP/SL based on ATR($${tech.atr.toFixed(4)}) and nearby S/R levels.
Required R:R ratio ≥ 1.5:1.

Respond ONLY with valid JSON:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": <0-100>,
  "reasoning": "<detailed reasoning: what specific indicators aligned? Ichimoku status, VWAP position, market structure signals, divergence? Why this confidence level?>",
  "entryPrice": <number>,
  "targetPrice": <number>,
  "stopLoss": <number>,
  "fundamental": "<3-sentence fundamental summary: Fear&Greed, funding rate implications, macro bias>"
}
`;
}

function parseAnalysisResponse(raw: string, data: MarketData, tech: TechnicalSummary): AnalysisResult {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in AI response');
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      pair: data.pair,
      signal: (['BUY', 'SELL', 'HOLD'].includes(parsed.signal) ? parsed.signal : 'HOLD') as any,
      confidence: Math.min(100, Math.max(0, Number(parsed.confidence) || 50)),
      reasoning: String(parsed.reasoning || 'No reasoning provided'),
      technical: tech,
      fundamental: String(parsed.fundamental || ''),
      entryPrice: Number(parsed.entryPrice) || data.price,
      targetPrice: Number(parsed.targetPrice) || data.price * 1.02,
      stopLoss: Number(parsed.stopLoss) || data.price * 0.98,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(`[Analyst] Parse error for ${data.pair}:`, (err as any)?.message);
    return {
      pair: data.pair,
      signal: 'HOLD',
      confidence: 0,
      reasoning: `Parse error: ${raw.slice(0, 100)}`,
      technical: tech,
      fundamental: '',
      entryPrice: data.price,
      targetPrice: data.price,
      stopLoss: data.price,
      timestamp: Date.now(),
    };
  }
}

export async function requestSelfCorrection(
  pair: string,
  currentStrategy: string,
  tradeHistory: any[],
  currentLossPct: number
): Promise<{ newStrategy: string; adjustments: string; analysis: string }> {
  const prompt = `
## Self-Correction Analysis

**Pair**: ${pair}
**Loss**: ${currentLossPct.toFixed(2)}% (threshold: ${CONFIG.TRADING.LOSS_THRESHOLD_PCT}%)
**Strategy**: ${currentStrategy}

## Trade History (last 10):
${JSON.stringify(tradeHistory.slice(-10), null, 2)}

What went wrong? Consider:
1. Trading against trend/Ichimoku cloud?
2. Ignoring VWAP levels?
3. Missing divergence signals?
4. Bad timing relative to market structure?

Respond with valid JSON:
{
  "analysis": "<root cause of losses>",
  "adjustments": "<specific fixes with indicator-based reasoning>",
  "newStrategy": "<strategy name>",
  "newTpPct": <number>,
  "newSlPct": <number>,
  "newSignalThreshold": <60-90>
}
`;

  const raw = await askAI(
    'You are a trading strategy analyst. Identify losses root cause and fix the strategy. JSON only.',
    prompt
  );

  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    const p = JSON.parse(m[0]);
    return {
      newStrategy: String(p.newStrategy || 'Corrected Strategy'),
      adjustments: String(p.adjustments || ''),
      analysis: String(p.analysis || ''),
    };
  } catch {
    return {
      newStrategy: 'Conservative Recovery',
      adjustments: 'Tighter SL, higher confidence, wait for Ichimoku + VWAP alignment',
      analysis: 'Parse error during correction',
    };
  }
}
