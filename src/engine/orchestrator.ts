// ============================================================
// ORCHESTRATOR v3.0 — Multi-TP + Analytics + Safety + Kelly + Sessions + Regime + Macro
// ============================================================

import { CONFIG, PairState, MarketData, getPairType, getModeConfig } from '../config';
import { buildCryptoMarketData } from '../data/crypto';
import { buildForexMarketData } from '../data/forex';
import { buildCommodityMarketData } from '../data/commodity';
import { isNewsWindowSafe } from '../data/calendar';
import { getMacroContext, getMacroConfluenceForPair } from '../data/macro';
import { computeTechnicals } from '../analysis/technical';
import { getFundamentalContext } from '../analysis/fundamental';
import { analyzeMultiTimeframe } from '../analysis/mtf';
import { analyzeMarket } from '../ai/analyst';
import {
  createPairState, executeBuy, executeSell,
  checkMultiTPAndTrail, getTotalEquity, getUnrealizedPnl,
} from '../trading/simulator';
import { isTradingHalted, recordTrade } from '../analytics/performance';
import { isPairInFavorableSession, getSessionInfo, logCurrentSession } from '../analytics/sessions';
import { computeKelly } from '../analytics/kelly';
import { loadStrategy, saveStrategy } from '../trading/strategy_store';
import { checkAndCorrect } from '../learning/corrector';
import { EventEmitter } from 'events';

export const orchestratorEmitter = new EventEmitter();
orchestratorEmitter.setMaxListeners(50);

export const pairStates: Map<string, PairState> = new Map();
let isRunning = false;
let cycleCount = 0;
let totalAICalls = 0;

export function initializePairs(): void {
  for (const pair of CONFIG.ACTIVE_PAIRS) {
    const strategy = loadStrategy(pair);
    const pairType = getPairType(pair);

    // Commodity pairs need wider SL due to higher volatility
    if (pairType === 'commodity') {
      strategy.slPct = Math.max(strategy.slPct, 1.5);
    }

    const state = createPairState(pair, strategy);
    pairStates.set(pair, state);
  }
  console.log(`[Orchestrator] Initialized ${CONFIG.ACTIVE_PAIRS.length} pairs (${CONFIG.MODE} mode)`);
  console.log(`[Orchestrator] 📊 Crypto: ${CONFIG.CRYPTO_PAIRS.length} | Forex: ${CONFIG.FOREX_PAIRS.length} | Commodities: ${CONFIG.COMMODITY_PAIRS.length}`);
  console.log(`[Orchestrator] 🎯 Multi-TP: TP1=1.5×ATR | TP2=3×ATR | TP3=5×ATR → Swing Trailing`);
}

export async function startOrchestrator(): Promise<void> {
  isRunning = true;
  const modeConf = getModeConfig();

  console.log(`\n[Orchestrator] 🚀 Starting autonomous market analysis...`);
  console.log(`[Orchestrator] Mode: ${CONFIG.MODE} | Interval: ${modeConf.ANALYSIS_INTERVAL_MS / 1000}s`);
  console.log(`[Orchestrator] Pairs: ${CONFIG.ACTIVE_PAIRS.join(', ')}\n`);
  logCurrentSession(); // Log market session at startup

  while (isRunning) {
    cycleCount++;
    const cycleStart = Date.now();
    console.log(`\n[Cycle #${cycleCount}] Parallel analysis of ${CONFIG.ACTIVE_PAIRS.length} pairs... (${CONFIG.MODE})`);
    if (cycleCount % 4 === 1) logCurrentSession(); // Log session every 4 cycles

    // Portfolio Heat check
    const totalHeat = getPortfolioHeat();
    if (totalHeat > CONFIG.PORTFOLIO_HEAT.MAX_HEAT_PCT) {
      console.log(`[Portfolio] 🔥 Heat: ${totalHeat.toFixed(1)}% > ${CONFIG.PORTFOLIO_HEAT.MAX_HEAT_PCT}% max — reducing new entries this cycle`);
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < CONFIG.ACTIVE_PAIRS.length; i += BATCH_SIZE) {
      const batch = CONFIG.ACTIVE_PAIRS.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(pair => analyzePair(pair)));
      if (i + BATCH_SIZE < CONFIG.ACTIVE_PAIRS.length) await sleep(800);
    }

    const elapsed = Date.now() - cycleStart;
    console.log(`\n[Cycle #${cycleCount}] ✅ Done in ${(elapsed / 1000).toFixed(1)}s | AI calls: ${totalAICalls}`);

    orchestratorEmitter.emit('cycle-complete', {
      cycle: cycleCount, states: Array.from(pairStates.values()), totalAICalls,
    });

    const waitTime = Math.max(0, modeConf.ANALYSIS_INTERVAL_MS - elapsed);
    await sleep(waitTime);
  }
}

async function analyzePair(pair: string): Promise<void> {
  const state = pairStates.get(pair);
  if (!state || state.isAnalyzing) return;
  state.isAnalyzing = true;

  try {
    // 1. Fetch market data
    const marketData = await getMarketData(pair);
    if (!marketData || marketData.price === 0) { state.isAnalyzing = false; return; }
    state.currentPrice = marketData.price;

    // 2. Check multi-TP phases + trailing SL for all open positions
    const modeConf = getModeConfig();
    const primaryCandles = marketData.candles[modeConf.PRIMARY_INTERVAL]
      ?? marketData.candles['1h']
      ?? marketData.candles['15m'] ?? [];
    const technical = primaryCandles.length >= 30 ? computeTechnicals(primaryCandles) : null;
    const confluenceScore = technical?.score ?? 0;

    const tpEvents = checkMultiTPAndTrail(state, marketData.price, confluenceScore);
    for (const evt of tpEvents) {
      const emoji = evt.event.includes('sl') ? '🛑' : evt.event.includes('time') ? '⏰' : evt.event.includes('swing') ? '⛵' : '🎯';
      if (evt.pnl !== undefined) {
        console.log(`[${pair}] ${emoji} ${evt.event} @ $${marketData.price.toFixed(4)} | PnL: $${evt.pnl.toFixed(2)}`);
        // Record to daily circuit breaker
        const halt = recordTrade(pair, evt.pnl);
        if (halt.halted) orchestratorEmitter.emit('circuit-breaker', { pair, reason: halt.reason });
      }
      orchestratorEmitter.emit('tp-event', { pair, event: evt.event, pnl: evt.pnl, price: marketData.price });
    }

    // 3. Self-correction check
    const { corrected, message } = await checkAndCorrect(state);
    if (corrected) orchestratorEmitter.emit('self-corrected', { pair, message });

    // 4. Technicals
    if (!technical || primaryCandles.length < 30) { state.isAnalyzing = false; return; }
    const atr = technical.atr || marketData.price * 0.01;

    // 5. Fundamental
    const fundamental = await getFundamentalContext(pair);

    // 6. AI Analysis
    totalAICalls++;
    const analysis = await analyzeMarket(marketData, technical, fundamental, state.strategy.name);
    state.lastAnalysis = analysis;

    const signalEmoji = analysis.signal === 'BUY' ? '🟢' : analysis.signal === 'SELL' ? '🔴' : '🟡';
    const typeTag = getPairType(pair).toUpperCase().slice(0, 4);
    const openPositions = state.positions.filter(p => p.status === 'OPEN');
    const layerInfo = openPositions.length > 0 ? ` [L${openPositions.map(p => p.pyramidLayer).join('+')}]` : '';
    console.log(`[${pair}] ${signalEmoji} ${analysis.signal} (${analysis.confidence}%) | $${marketData.price.toFixed(4)} | Score: ${technical.score}/100 [${typeTag}]${layerInfo}`);

    // 7. Execute trade based on signal
    if (analysis.signal === 'BUY') {
      // Circuit breaker check — skip if daily loss limit hit
      if (isTradingHalted(pair)) {
        console.log(`[${pair}] 🚨 Trading halted (daily limit) — skipping BUY`);
      } else {
        // Portfolio Heat check — skip if total portfolio risk too high
        const heat = getPortfolioHeat();
        if (CONFIG.PORTFOLIO_HEAT.ENABLED && heat > CONFIG.PORTFOLIO_HEAT.MAX_HEAT_PCT) {
          console.log(`[${pair}] 🔥 Portfolio heat ${heat.toFixed(1)}% > max — skipping BUY`);
        } else {
          // Correlation Filter — avoid double exposure in correlated pairs
          const corrBlock = isBlockedByCorrelation(pair);
          if (corrBlock.blocked) {
            console.log(`[${pair}] 🔗 Correlation block: ${corrBlock.reason}`);
          } else {
            // Session check — require higher confidence in unfavorable sessions
            const sessionCheck = isPairInFavorableSession(pair);
            let effectiveThreshold = state.strategy.signalThreshold + sessionCheck.minConfidenceBonus;
            if (sessionCheck.minConfidenceBonus > 0) {
              console.log(`[${pair}] 🌍 Session adj: need ${effectiveThreshold}% (${sessionCheck.session.sessionName})`);
            }

            // Regime check — block longs in STRONG_BEAR; boost threshold in BEAR
            const regime = technical.regime;
            let regimeBlocksLong = false;
            if (regime) {
              if (regime.adjustments.avoidLong) {
                console.log(`[${pair}] 📉 Regime ${regime.regime} — avoiding new longs`);
                regimeBlocksLong = true;
              } else if (regime.adjustments.minConfidenceBonus > 0) {
                effectiveThreshold += regime.adjustments.minConfidenceBonus;
                console.log(`[${pair}] 📊 Regime ${regime.regime}: +${regime.adjustments.minConfidenceBonus}% threshold`);
              }
            }

            if (!regimeBlocksLong) {
              // Macro overlay — DXY + gold context
              try {
                const macro = await getMacroContext();
                const macroBonus = getMacroConfluenceForPair(pair, macro, 'BUY');
                if (macroBonus !== 0) {
                  console.log(`[${pair}] 🌐 Macro overlay: ${macroBonus > 0 ? '+' : ''}${macroBonus} (DXY: ${macro.dxyBias}, ${macro.riskSentiment})`);
                  effectiveThreshold -= macroBonus;
                }
              } catch { /* ignore macro errors */ }

              // Economic Calendar check — skip near high-impact news
              const newsSafety = await isNewsWindowSafe(pair);
              if (!newsSafety.safe) {
                console.log(`[${pair}] 📅 Skipping BUY: ${newsSafety.reason}`);
              } else {
                // Check if we should pyramid (add to existing) or open fresh
                const existingOpen = state.positions.filter(p => p.status === 'OPEN');
                const canPyramid = existingOpen.length > 0 &&
                  CONFIG.TRADING.PYRAMID.ENABLED &&
                  existingOpen.length < CONFIG.TRADING.PYRAMID.MAX_LAYERS &&
                  existingOpen.every(p => marketData.price > p.entryPrice);

                if (existingOpen.length === 0 || canPyramid) {
                  if (analysis.confidence >= effectiveThreshold) {
                    const trade = executeBuy(state, marketData.price, analysis.confidence, analysis.reasoning.slice(0, 100), atr);
                    if (trade) {
                      const layerTag = trade.pyramidLayer > 1 ? ` (PYRAMID Layer ${trade.pyramidLayer})` : '';
                      const kellyInfo = computeKelly(state);
                      const kellyTag = state.closedTrades.length >= CONFIG.KELLY.MIN_TRADES_FOR_KELLY
                        ? ` Kelly:${kellyInfo.capped.toFixed(1)}%` : '';
                      console.log(`[${pair}] 🛒 BUY${layerTag}${kellyTag} @ $${trade.entryPrice.toFixed(4)}`);
                      console.log(`[${pair}]    TP1: $${trade.tp1.toFixed(4)} | TP2: $${trade.tp2.toFixed(4)} | TP3: $${trade.tp3.toFixed(4)}`);
                      console.log(`[${pair}]    SL: $${trade.stopLoss.toFixed(4)} (ATR: $${atr.toFixed(4)})`);
                      orchestratorEmitter.emit('trade-opened', { pair, trade });
                    }
                  }
                }
              }
            } // end: !regimeBlocksLong
          }
        }
      }
    } else if (analysis.signal === 'SELL' && analysis.confidence >= 75) {

      // High-confidence SELL: close all positions (including swing positions)
      for (const pos of [...state.positions]) {
        if (pos.status === 'OPEN') {
          const closed = executeSell(state, marketData.price, pos.id, `📉 AI SELL (${analysis.confidence}% conf)`);
          if (closed) {
            const totalPnl = (closed.pnl ?? 0);
            console.log(`[${pair}] 💰 SOLD (L${closed.pyramidLayer}) @ $${closed.closePrice?.toFixed(4)} | Total PnL: $${totalPnl.toFixed(2)}`);
            // Record to daily circuit breaker
            recordTrade(pair, totalPnl);
            orchestratorEmitter.emit('trade-closed', { pair, trade: closed });
          }
        }
      }
    }

    // 8. Update strategy stats
    state.strategy.totalTrades = state.closedTrades.length;
    state.strategy.winRate = state.winRate;
    saveStrategy(pair, state.strategy);

    orchestratorEmitter.emit('pair-analyzed', {
      pair, price: marketData.price, analysis, technical,
      equity: getTotalEquity(state, marketData.price),
      unrealizedPnl: getUnrealizedPnl(state, marketData.price),
      session: getSessionInfo(pair),
      portfolioHeat: getPortfolioHeat(),
    });

  } catch (err: any) {
    console.error(`[${pair}] Analysis error:`, err.message);
  } finally {
    state.isAnalyzing = false;
  }
}

async function getMarketData(pair: string): Promise<MarketData | null> {
  const type = getPairType(pair);
  try {
    if (type === 'commodity') return await buildCommodityMarketData(pair);
    if (type === 'forex') return await buildForexMarketData(pair);
    return await buildCryptoMarketData(pair);
  } catch (err: any) {
    console.error(`[${pair}] Data fetch failed:`, err.message);
    return null;
  }
}

export function stopOrchestrator(): void { isRunning = false; }

export function getPortfolioSummary() {
  let totalEquity = 0, totalPnl = 0, totalTrades = 0, totalWins = 0;
  for (const [, state] of pairStates) {
    totalEquity += getTotalEquity(state, state.currentPrice);
    totalPnl += state.totalPnl;
    totalTrades += state.closedTrades.length;
    totalWins += state.closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  }
  return {
    totalEquity, totalPnl,
    totalPnlPct: (totalPnl / (CONFIG.TRADING.STARTING_BALANCE_USDT * CONFIG.ACTIVE_PAIRS.length)) * 100,
    totalTrades, winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
    cycle: cycleCount, totalAICalls, activePairs: CONFIG.ACTIVE_PAIRS.length, mode: CONFIG.MODE,
  };
}

// ── Portfolio Heat (total open risk % of total equity) ──────
function getPortfolioHeat(): number {
  if (!CONFIG.PORTFOLIO_HEAT.ENABLED) return 0;

  let totalOpenValue = 0;
  let totalEquity = 0;

  for (const [, state] of pairStates) {
    const equity = getTotalEquity(state, state.currentPrice);
    totalEquity += equity;
    for (const pos of state.positions) {
      if (pos.status === 'OPEN') {
        totalOpenValue += pos.currentUsdtValue;
      }
    }
  }

  if (totalEquity <= 0) return 0;
  return (totalOpenValue / totalEquity) * 100;
}

// ── Correlation Filter ───────────────────────────────────────
function isBlockedByCorrelation(pair: string): { blocked: boolean; reason: string } {
  if (!CONFIG.CORRELATION.ENABLED) return { blocked: false, reason: '' };

  // Find which correlation group this pair belongs to
  const group = CONFIG.CORRELATION.CORRELATED_GROUPS.find(g => g.includes(pair));
  if (!group) return { blocked: false, reason: '' };

  // Count how many pairs in this group currently have open BUY positions
  let openLongCount = 0;
  const openLongPairs: string[] = [];

  for (const groupPair of group) {
    if (groupPair === pair) continue;
    const state = pairStates.get(groupPair);
    if (state) {
      const openLongs = state.positions.filter(p => p.status === 'OPEN' && p.type === 'BUY');
      if (openLongs.length > 0) {
        openLongCount++;
        openLongPairs.push(groupPair);
      }
    }
  }

  if (openLongCount >= CONFIG.CORRELATION.MAX_SAME_DIRECTION_IN_GROUP) {
    return {
      blocked: true,
      reason: `${openLongCount} correlated pairs already long: ${openLongPairs.join(', ')}`,
    };
  }

  return { blocked: false, reason: '' };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

