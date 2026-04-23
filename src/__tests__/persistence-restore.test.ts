// ============================================================
// Phase 2 — Integration: Persistence / Restore / Restart-Safety
//
// Higher-level tests that verify restart-recovery assumptions:
//   1. Full snapshot roundtrip (save → simulate restart → load)
//   2. Persisted state reuse: restored balances/PnL survive
//   3. Stale circuit breaker resets on new day
//   4. Missing state produces clean defaults
//   5. Cycle count survives across runtime meta saves
//   6. Mixed scenario: some pairs persisted, some missing
//   7. Corrupt persisted state treated as missing (graceful)
//   8. Circuit halt state correctly preserved & restored
//
// These test the same flows orchestrator.initializePairs() uses
// but without importing the orchestrator (heavy deps).
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import type { PairState } from '../config';

let tmpDir: string;

// Redirect fs paths into an isolated tmpDir (same pattern as state-store.test.ts)
vi.mock('fs', async () => {
  const realFs: typeof import('fs') = await vi.importActual('fs');

  function tmp(pathname: string): string {
    if (pathname.includes('data/state') || pathname.includes('data' + path.sep + 'state')) {
      const rel = pathname.split(/data[\\/]state[\\/]/)[1] ?? '';
      return path.join(tmpDir, rel);
    }
    return pathname;
  }

  return {
    ...realFs,
    existsSync: (p: string) => realFs.existsSync(tmp(p)),
    readFileSync: (p: string, enc: string) => realFs.readFileSync(tmp(p), enc as BufferEncoding),
    writeFileSync: (p: string, data: string, enc: string) => {
      const tp = tmp(p);
      const dir = path.dirname(tp);
      if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
      realFs.writeFileSync(tp, data, enc as BufferEncoding);
    },
    renameSync: (oldPath: string, newPath: string) => {
      realFs.renameSync(tmp(oldPath), tmp(newPath));
    },
    mkdirSync: (p: string, opts?: Parameters<typeof realFs.mkdirSync>[1]) => {
      const tp = tmp(p);
      if (!realFs.existsSync(tp)) realFs.mkdirSync(tp, opts);
    },
    unlinkSync: (p: string) => {
      const tp = tmp(p);
      if (realFs.existsSync(tp)) realFs.unlinkSync(tp);
    },
    readdirSync: (p: string) => {
      const tp = tmp(p);
      if (realFs.existsSync(tp)) return realFs.readdirSync(tp);
      return [];
    },
  };
});

import * as realFs from 'fs';

import {
  loadPairState,
  savePairState,
  loadAllPairStates,
  saveAllPairStates,
  deletePairState,
  pruneOrphanPairStates,
  pruneStalePairStates,
  loadRuntimeMeta,
  saveRuntimeMeta,
  loadCircuitState,
  saveCircuitState,
  loadOrResetCircuit,
  saveSnapshot,
  loadSnapshot,
  type RuntimeMeta,
  type DailyCircuitState,
  type FullSnapshot,
} from '../persistence/state_store';

// ── Helpers ─────────────────────────────────────────────────

function makePair(pair: string, overrides: Partial<PairState> = {}): PairState {
  return {
    pair,
    balance: 1000,
    positions: [],
    closedTrades: [],
    totalPnl: 0,
    totalPnlPct: 0,
    winRate: 0.5,
    strategy: {
      name: 'default',
      tpPct: 3,
      slPct: 2,
      maxPositions: 3,
      signalThreshold: 0.6,
      indicators: ['RSI'],
      lastUpdated: Date.now(),
      winRate: 0.5,
      totalTrades: 0,
    },
    currentPrice: 42000,
    isAnalyzing: false,
    correctionCount: 0,
    ...overrides,
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════
// 1. FULL SNAPSHOT ROUNDTRIP (restart simulation)
// ════════════════════════════════════════════════════════════

describe('Integration — full snapshot roundtrip simulates restart', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves a complete snapshot and restores it with all fields intact', () => {
    const pairs = [
      makePair('BTCUSDT', {
        balance: 850,
        totalPnl: -150,
        totalPnlPct: -15,
        winRate: 0.33,
        closedTrades: [
          {
            id: 't1', pair: 'BTCUSDT', type: 'BUY', status: 'CLOSED',
            entryPrice: 42000, closePrice: 41000, quantity: 0.1,
            stopLoss: 41500, tp1: 43000, tp2: 44000, tp3: 45000,
            entryTime: Date.now() - 3600000, closeTime: Date.now(),
            pnl: -100, reasoning: 'test', confidence: 70,
            pyramidLayer: 1, currentUsdtValue: 0,
          } as any,
        ],
        correctionCount: 2,
      }),
      makePair('ETHUSDT', { balance: 1200, totalPnl: 200, winRate: 0.75 }),
    ];

    const runtime: RuntimeMeta = {
      startedAt: 1700000000000,
      lastHeartbeat: 1700000300000,
      cycleCount: 42,
      version: '2.0',
    };

    const circuit: DailyCircuitState = {
      date: today(),
      dailyPnlPct: -1.5,
      consecutiveLosses: 2,
      halted: false,
    };

    // Save everything
    saveSnapshot({ pairs, runtime, circuit });

    // Simulate restart: load everything back
    const restored = loadSnapshot(['BTCUSDT', 'ETHUSDT']);

    // Pair states restored with full fidelity
    expect(restored.pairs).toHaveLength(2);
    const btc = restored.pairs.find(p => p.pair === 'BTCUSDT')!;
    expect(btc.balance).toBe(850);
    expect(btc.totalPnl).toBe(-150);
    expect(btc.winRate).toBe(0.33);
    expect(btc.closedTrades).toHaveLength(1);
    expect(btc.closedTrades[0].pnl).toBe(-100);
    expect(btc.correctionCount).toBe(2);

    const eth = restored.pairs.find(p => p.pair === 'ETHUSDT')!;
    expect(eth.balance).toBe(1200);
    expect(eth.totalPnl).toBe(200);

    // Runtime meta preserved
    expect(restored.runtime).not.toBeNull();
    expect(restored.runtime!.cycleCount).toBe(42);
    expect(restored.runtime!.version).toBe('2.0');

    // Circuit state preserved
    expect(restored.circuit).not.toBeNull();
    expect(restored.circuit!.dailyPnlPct).toBe(-1.5);
    expect(restored.circuit!.consecutiveLosses).toBe(2);
  });

  it('cycle count survives across multiple save/load cycles', () => {
    // First "run" — cycles at 100
    saveRuntimeMeta({
      startedAt: 1,
      lastHeartbeat: 2,
      cycleCount: 100,
      version: '2.0',
    });

    // Load — simulates orchestrator reading cycleCount on restart
    const meta1 = loadRuntimeMeta();
    expect(meta1!.cycleCount).toBe(100);

    // Second "run" — continues from 100, adds 50 more cycles
    const continuedCycles = meta1!.cycleCount + 50;
    saveRuntimeMeta({
      startedAt: 3,
      lastHeartbeat: 4,
      cycleCount: continuedCycles,
      version: '2.0',
    });

    // Load again — cycle count should be 150
    const meta2 = loadRuntimeMeta();
    expect(meta2!.cycleCount).toBe(150);
  });
});

// ════════════════════════════════════════════════════════════
// 2. PERSISTED STATE REUSE — restored values actually used
// ════════════════════════════════════════════════════════════

describe('Integration — persisted pair state reuse', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restored balance reflects trading activity from previous run', () => {
    // Previous run ended with balance 750 (lost 250)
    savePairState(makePair('BTCUSDT', { balance: 750, totalPnl: -250 }));

    // Restart: load the state
    const restored = loadPairState('BTCUSDT');
    expect(restored).not.toBeNull();
    expect(restored!.balance).toBe(750);
    expect(restored!.totalPnl).toBe(-250);

    // Continue trading: save updated state
    restored!.balance = 900;
    restored!.totalPnl = -100;
    savePairState(restored!);

    // Another restart: should see the updated values
    const again = loadPairState('BTCUSDT');
    expect(again!.balance).toBe(900);
    expect(again!.totalPnl).toBe(-100);
  });

  it('positions array survives restore (open positions carried over)', () => {
    const openPosition = {
      id: 'pos-1',
      pair: 'ETHUSDT',
      type: 'BUY',
      status: 'OPEN',
      entryPrice: 3100,
      quantity: 0.5,
      stopLoss: 3050,
      tp1: 3200,
      tp2: 3300,
      tp3: 3400,
      entryTime: Date.now(),
      pnl: 25,
      reasoning: 'momentum',
      confidence: 75,
      pyramidLayer: 1,
      currentUsdtValue: 1550,
    };

    savePairState(makePair('ETHUSDT', {
      balance: 845,  // 1000 - 155 committed
      positions: [openPosition] as any,
    }));

    const restored = loadPairState('ETHUSDT')!;
    expect(restored.positions).toHaveLength(1);
    expect(restored.positions[0].status).toBe('OPEN');
    expect(restored.positions[0].entryPrice).toBe(3100);
    expect(restored.positions[0].quantity).toBe(0.5);
  });

  it('strategy win rate and total trades survive restore', () => {
    savePairState(makePair('SOLUSDT', {
      strategy: {
        name: 'Adaptive Momentum',
        tpPct: 3,
        slPct: 2,
        maxPositions: 2,
        signalThreshold: 65,
        indicators: ['RSI', 'MACD'],
        lastUpdated: 1700000000000,
        winRate: 62.5,
        totalTrades: 24,
      },
    }));

    const restored = loadPairState('SOLUSDT')!;
    expect(restored.strategy.winRate).toBe(62.5);
    expect(restored.strategy.totalTrades).toBe(24);
    expect(restored.strategy.indicators).toEqual(['RSI', 'MACD']);
  });
});

// ════════════════════════════════════════════════════════════
// 3. STALE / MISSING STATE — graceful degradation
// ════════════════════════════════════════════════════════════

describe('Integration — stale and missing state behavior', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('circuit breaker resets when date is stale (new day)', () => {
    // Yesterday's circuit had a halt
    const staleCircuit: DailyCircuitState = {
      date: yesterday(),
      dailyPnlPct: -4.5,
      consecutiveLosses: 6,
      halted: true,
      haltedAt: Date.now() - 86400000,
      haltReason: 'Max daily loss',
    };
    saveCircuitState(staleCircuit);

    // Verify stale data is saved
    const raw = loadCircuitState();
    expect(raw!.halted).toBe(true);

    // loadOrResetCircuit should give a fresh state for today
    const result = loadOrResetCircuit();
    expect(result.date).toBe(today());
    expect(result.dailyPnlPct).toBe(0);
    expect(result.consecutiveLosses).toBe(0);
    expect(result.halted).toBe(false);
    expect(result.haltedAt).toBeUndefined();
  });

  it('no persisted state at all yields clean defaults', () => {
    const snap = loadSnapshot(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']);
    expect(snap.pairs).toHaveLength(0);
    expect(snap.runtime).toBeNull();
    expect(snap.circuit).toBeNull();

    const circuit = loadOrResetCircuit();
    expect(circuit.date).toBe(today());
    expect(circuit.halted).toBe(false);
    expect(circuit.dailyPnlPct).toBe(0);
  });

  it('missing pair states produce empty map entries (orchestrator creates fresh)', () => {
    // Only BTC persisted
    savePairState(makePair('BTCUSDT', { balance: 500 }));

    const map = loadAllPairStates(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(map.size).toBe(1);
    expect(map.get('BTCUSDT')!.balance).toBe(500);
    expect(map.has('ETHUSDT')).toBe(false);
    expect(map.has('SOLUSDT')).toBe(false);
  });

  it('corrupt pair file treated as missing (no crash, null return)', () => {
    // Write corrupt JSON for BTC
    const pairFile = path.join(tmpDir, 'pairs', 'BTCUSDT.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, '{{invalid}}', 'utf8');

    // Also write a valid file for ETH
    savePairState(makePair('ETHUSDT', { balance: 999 }));

    const map = loadAllPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(map.size).toBe(1);
    expect(map.has('BTCUSDT')).toBe(false);
    expect(map.get('ETHUSDT')!.balance).toBe(999);
  });

  it('corrupt runtime meta returns null (orchestrator uses cycleCount=0)', () => {
    const rtFile = path.join(tmpDir, 'runtime.json');
    realFs.writeFileSync(rtFile, 'NOTJSON', 'utf8');
    expect(loadRuntimeMeta()).toBeNull();
  });

  it('corrupt circuit file yields fresh state via loadOrResetCircuit', () => {
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, 'BROKEN{', 'utf8');
    const circuit = loadOrResetCircuit();
    expect(circuit.date).toBe(today());
    expect(circuit.halted).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// 4. CIRCUIT BREAKER HALT — preserve and restore
// ════════════════════════════════════════════════════════════

describe('Integration — circuit breaker halt persistence', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('halt state with reason preserved across restart', () => {
    const halted: DailyCircuitState = {
      date: today(),
      dailyPnlPct: -3.8,
      consecutiveLosses: 5,
      halted: true,
      haltedAt: Date.now(),
      haltReason: 'Daily loss limit hit: -$38.00 (>3%)',
    };
    saveCircuitState(halted);

    // Simulate restart: loadOrResetCircuit should return the halted state
    const restored = loadOrResetCircuit();
    expect(restored.halted).toBe(true);
    expect(restored.dailyPnlPct).toBe(-3.8);
    expect(restored.consecutiveLosses).toBe(5);
    expect(restored.haltReason).toBe('Daily loss limit hit: -$38.00 (>3%)');
    expect(restored.date).toBe(today());
  });

  it('halt does not persist into a new day', () => {
    const halted: DailyCircuitState = {
      date: yesterday(),
      dailyPnlPct: -5,
      consecutiveLosses: 10,
      halted: true,
      haltedAt: Date.now() - 86400000,
      haltReason: 'Consecutive losses',
    };
    saveCircuitState(halted);

    // New day → fresh state, halt cleared
    const restored = loadOrResetCircuit();
    expect(restored.date).toBe(today());
    expect(restored.halted).toBe(false);
    expect(restored.dailyPnlPct).toBe(0);
    expect(restored.consecutiveLosses).toBe(0);
  });

  it('multiple save overwrites circuit state (latest wins)', () => {
    saveCircuitState({
      date: today(), dailyPnlPct: -1, consecutiveLosses: 1, halted: false,
    });
    saveCircuitState({
      date: today(), dailyPnlPct: -3, consecutiveLosses: 4, halted: true,
      haltedAt: Date.now(), haltReason: '4 consecutive losses — cooling off',
    });

    const restored = loadOrResetCircuit();
    expect(restored.dailyPnlPct).toBe(-3);
    expect(restored.consecutiveLosses).toBe(4);
    expect(restored.halted).toBe(true);
    expect(restored.haltReason).toBe('4 consecutive losses — cooling off');
  });
});

// ════════════════════════════════════════════════════════════
// 5. MIXED PERSISTENCE — some pairs persisted, some not
// ════════════════════════════════════════════════════════════

describe('Integration — mixed persisted/fresh pair scenario', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores available pairs and signals which are missing', () => {
    // Simulate a previous run that only tracked BTC and ETH
    savePairState(makePair('BTCUSDT', {
      balance: 1100, totalPnl: 100, closedTrades: [
        { id: 't1', pnl: 100 } as any,
      ],
    }));
    savePairState(makePair('ETHUSDT', { balance: 950, totalPnl: -50 }));

    // New run adds SOL (not yet persisted) and keeps BTC/ETH
    const allPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const restored = loadAllPairStates(allPairs);

    // BTC and ETH restored with their PnL
    expect(restored.size).toBe(2);
    expect(restored.get('BTCUSDT')!.totalPnl).toBe(100);
    expect(restored.get('ETHUSDT')!.totalPnl).toBe(-50);

    // SOL is missing → orchestrator would create fresh (balance=1000, PnL=0)
    expect(restored.has('SOLUSDT')).toBe(false);

    // Now save all three (simulating orchestrator persisting fresh state for SOL)
    saveAllPairStates([
      restored.get('BTCUSDT')!,
      restored.get('ETHUSDT')!,
      makePair('SOLUSDT'), // fresh
    ]);

    // Next restart: all three available
    const allRestored = loadAllPairStates(allPairs);
    expect(allRestored.size).toBe(3);
    expect(allRestored.get('BTCUSDT')!.totalPnl).toBe(100);
    expect(allRestored.get('SOLUSDT')!.balance).toBe(1000);
  });

  it('deleting a pair then loading returns null (simulates cleanup)', () => {
    savePairState(makePair('XRPUSDT', { balance: 1050 }));
    expect(loadPairState('XRPUSDT')).not.toBeNull();

    // Simulate cleanup (e.g., pair removed from config)
    deletePairState('XRPUSDT');
    expect(loadPairState('XRPUSDT')).toBeNull();

    // Other pairs unaffected
    savePairState(makePair('BTCUSDT', { balance: 2000 }));
    deletePairState('XRPUSDT'); // already gone, no throw
    expect(loadPairState('BTCUSDT')!.balance).toBe(2000);
  });
});

// ════════════════════════════════════════════════════════════
// 6. RUNTIME META — heartbeat and version tracking
// ════════════════════════════════════════════════════════════

describe('Integration — runtime meta across restarts', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks uptime via startedAt/shutdownAt', () => {
    const run1Start = Date.now() - 7200000; // 2 hours ago
    const run1End = Date.now() - 1000;

    saveRuntimeMeta({
      startedAt: run1Start,
      shutdownAt: run1End,
      lastHeartbeat: run1End,
      cycleCount: 500,
      version: '2.0',
    });

    const meta = loadRuntimeMeta()!;
    expect(meta.startedAt).toBe(run1Start);
    expect(meta.shutdownAt).toBe(run1End);
    // Uptime would be: meta.shutdownAt - meta.startedAt ≈ 2 hours
    expect(meta.shutdownAt! - meta.startedAt).toBeGreaterThanOrEqual(7199000);
  });

  it('new run overwrites startedAt but preserves cycleCount', () => {
    // Previous run
    saveRuntimeMeta({
      startedAt: 1000,
      lastHeartbeat: 2000,
      cycleCount: 75,
      version: '2.0',
    });

    const prev = loadRuntimeMeta()!;

    // New run starts
    const newStart = Date.now();
    saveRuntimeMeta({
      startedAt: newStart,
      lastHeartbeat: newStart,
      cycleCount: prev.cycleCount, // carried forward
      version: '2.0',
    });

    const current = loadRuntimeMeta()!;
    expect(current.startedAt).toBe(newStart);
    expect(current.cycleCount).toBe(75);
    expect(current.shutdownAt).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// 7. SNAPSHOT WITH PARTIAL DATA — null runtime/circuit
// ════════════════════════════════════════════════════════════

describe('Integration — snapshot with partial data', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves only pairs when runtime/circuit are null', () => {
    saveSnapshot({
      pairs: [makePair('BTCUSDT', { balance: 950 })],
      runtime: null,
      circuit: null,
    });

    const loaded = loadSnapshot(['BTCUSDT']);
    expect(loaded.pairs).toHaveLength(1);
    expect(loaded.pairs[0].balance).toBe(950);
    expect(loaded.runtime).toBeNull();
    expect(loaded.circuit).toBeNull();
  });

  it('pair deletion does not affect runtime or circuit files', () => {
    saveSnapshot({
      pairs: [makePair('BTCUSDT'), makePair('ETHUSDT')],
      runtime: { startedAt: 1, lastHeartbeat: 2, cycleCount: 10, version: '2.0' },
      circuit: { date: today(), dailyPnlPct: 1, consecutiveLosses: 0, halted: false },
    });

    deletePairState('BTCUSDT');
    // ETH, runtime, circuit still intact
    expect(loadPairState('ETHUSDT')).not.toBeNull();
    expect(loadRuntimeMeta()).not.toBeNull();
    expect(loadCircuitState()).not.toBeNull();
    expect(loadCircuitState()!.dailyPnlPct).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════
// 8. ORPHAN + STALE PRUNING — integration with restore flow
// ════════════════════════════════════════════════════════════

describe('Integration — orphan pruning during restore', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'persistence-restore-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('orphan files are removed before loadAllPairStates', () => {
    savePairState(makePair('BTCUSDT'));
    savePairState(makePair('REMOVED_PAIR'));

    const pruned = pruneOrphanPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(pruned).toEqual(['REMOVED_PAIR']);

    const restored = loadAllPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(restored.size).toBe(1);
    expect(restored.has('BTCUSDT')).toBe(true);
  });

  it('stale positionless states are pruned before loadAllPairStates', () => {
    const staleState = makePair('BTCUSDT', { balance: 500 });
    const filePath = path.join(tmpDir, 'pairs', 'BTCUSDT.json');
    realFs.mkdirSync(path.dirname(filePath), { recursive: true });
    realFs.writeFileSync(filePath, JSON.stringify({
      _schemaVersion: 1,
      data: { ...staleState, _savedAt: Date.now() - 80 * 3600000 },
    }), 'utf8');

    savePairState(makePair('ETHUSDT'));

    const pruned = pruneStalePairStates(['BTCUSDT', 'ETHUSDT']);
    expect(pruned).toEqual(['BTCUSDT']);

    const restored = loadAllPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(restored.has('BTCUSDT')).toBe(false);
    expect(restored.has('ETHUSDT')).toBe(true);
  });

  it('full restore flow: prune orphans then prune stale then load', () => {
    savePairState(makePair('BTCUSDT', { balance: 900, totalPnl: -100 }));
    savePairState(makePair('ORPHAN'));

    const staleState = makePair('SOLUSDT', { balance: 800 });
    const solFile = path.join(tmpDir, 'pairs', 'SOLUSDT.json');
    realFs.mkdirSync(path.dirname(solFile), { recursive: true });
    realFs.writeFileSync(solFile, JSON.stringify({
      _schemaVersion: 1,
      data: { ...staleState, _savedAt: Date.now() - 100 * 3600000 },
    }), 'utf8');

    const activePairs = ['BTCUSDT', 'SOLUSDT', 'ETHUSDT'];

    pruneOrphanPairStates(activePairs);
    pruneStalePairStates(activePairs);

    const restored = loadAllPairStates(activePairs);
    expect(restored.size).toBe(1);
    expect(restored.get('BTCUSDT')!.balance).toBe(900);
    expect(restored.get('BTCUSDT')!.totalPnl).toBe(-100);
    expect(restored.has('SOLUSDT')).toBe(false);
    expect(restored.has('ETHUSDT')).toBe(false);
  });
});
