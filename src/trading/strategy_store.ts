// ============================================================
// STRATEGY STORE - Persist and load best strategies per pair
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { StrategyConfig } from '../config';

const STORE_DIR = path.resolve(__dirname, '../../data/strategies');

export function getDefaultStrategy(pair: string): StrategyConfig {
  // Slightly different defaults for forex vs crypto
  const isForex = !pair.endsWith('USDT');
  return {
    name: 'Adaptive Momentum',
    tpPct: isForex ? 1.5 : 3.0,
    slPct: isForex ? 0.8 : 2.0,
    maxPositions: 2,
    signalThreshold: 65,
    indicators: ['RSI', 'MACD', 'EMA', 'BB'],
    lastUpdated: Date.now(),
    winRate: 0,
    totalTrades: 0,
  };
}

export function loadStrategy(pair: string): StrategyConfig {
  const file = path.join(STORE_DIR, `${pair}.json`);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Corrupt file → use default
    }
  }
  return getDefaultStrategy(pair);
}

export function saveStrategy(pair: string, strategy: StrategyConfig): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
  const file = path.join(STORE_DIR, `${pair}.json`);
  fs.writeFileSync(file, JSON.stringify(strategy, null, 2), 'utf8');
}

export function updateStrategyIfBetter(
  pair: string,
  current: StrategyConfig,
  candidate: StrategyConfig
): StrategyConfig {
  // Update if candidate has better win rate AND more trades
  if (
    candidate.totalTrades >= 5 &&
    candidate.winRate > current.winRate + 5 // Must be 5% better
  ) {
    const updated = { ...candidate, lastUpdated: Date.now() };
    saveStrategy(pair, updated);
    console.log(`[Strategy] ✨ Updated best strategy for ${pair}: ${candidate.winRate.toFixed(1)}% win rate`);
    return updated;
  }
  return current;
}

export function applyCorrection(
  pair: string,
  current: StrategyConfig,
  corrections: { newStrategy: string; newTpPct?: number; newSlPct?: number; newSignalThreshold?: number }
): StrategyConfig {
  const corrected: StrategyConfig = {
    ...current,
    name: corrections.newStrategy || `Corrected-${current.name}`,
    tpPct: corrections.newTpPct ?? current.tpPct,
    slPct: corrections.newSlPct ?? current.slPct,
    signalThreshold: corrections.newSignalThreshold ?? Math.min(80, current.signalThreshold + 5),
    totalTrades: 0,
    winRate: 0,
    lastUpdated: Date.now(),
  };
  saveStrategy(pair, corrected);
  return corrected;
}
