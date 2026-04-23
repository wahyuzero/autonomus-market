// ============================================================
// Phase 2 — State Store Persistence Tests
// Covers: roundtrip save/load, aggregate snapshot, graceful
// null/empty handling for missing & corrupt files.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import type { PairState } from '../config';

let tmpDir: string;

// Mock fs to redirect all data/state paths into an isolated tmpDir.
// Uses vi.importActual('fs') so the real fs is available inside the mock
// for reading/writing temp files — the mock just rewrites paths.
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

// Real fs for test setup/teardown (imported after mock declaration but
// before the mocked module, so vitest hoists the mock correctly).
import * as realFs from 'fs';

// Import after mock is in place
import {
  loadPairState,
  savePairState,
  loadAllPairStates,
  saveAllPairStates,
  deletePairState,
  pruneOrphanPairStates,
  pruneStalePairStates,
  SCHEMA_VERSION,
  loadRuntimeMeta,
  saveRuntimeMeta,
  wasCleanShutdown,
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

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('state_store — pair state', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no pair file exists', () => {
    expect(loadPairState('BTCUSDT')).toBeNull();
  });

  it('roundtrips a single pair state', () => {
    const state = makePair('ETHUSDT', { balance: 2500, totalPnl: 120 });
    savePairState(state);
    const loaded = loadPairState('ETHUSDT');
    expect(loaded).not.toBeNull();
    expect(loaded!.pair).toBe('ETHUSDT');
    expect(loaded!.balance).toBe(2500);
    expect(loaded!.totalPnl).toBe(120);
    expect(loaded!.strategy.name).toBe('default');
  });

  it('overwrites existing pair state on re-save', () => {
    const s1 = makePair('BTCUSDT', { balance: 1000 });
    savePairState(s1);
    const s2 = makePair('BTCUSDT', { balance: 900 });
    savePairState(s2);
    const loaded = loadPairState('BTCUSDT');
    expect(loaded!.balance).toBe(900);
  });

  it('deletes a pair state file', () => {
    savePairState(makePair('SOLUSDT'));
    expect(loadPairState('SOLUSDT')).not.toBeNull();
    deletePairState('SOLUSDT');
    expect(loadPairState('SOLUSDT')).toBeNull();
  });

  it('deletePairState is idempotent (no throw on missing)', () => {
    expect(() => deletePairState('NONEXISTENT')).not.toThrow();
  });

  it('rejects invalid pair state shape on load', () => {
    const pairFile = path.join(tmpDir, 'pairs', 'BADSHAPE.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, JSON.stringify({ pair: 'BADSHAPE', balance: 'oops' }), 'utf8');
    expect(loadPairState('BADSHAPE')).toBeNull();
  });

  it('persists pair state via atomic temp write without leaving tmp file behind', () => {
    savePairState(makePair('ATOMUSDT', { balance: 777 }));
    const pairDir = path.join(tmpDir, 'pairs');
    const files = realFs.readdirSync(pairDir);
    expect(files).toContain('ATOMUSDT.json');
    expect(files.some(file => file.endsWith('.tmp'))).toBe(false);
  });
});

describe('state_store — batch pair operations', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveAllPairStates + loadAllPairStates roundtrips multiple pairs', () => {
    const states = [
      makePair('BTCUSDT', { balance: 100 }),
      makePair('ETHUSDT', { balance: 200 }),
      makePair('SOLUSDT', { balance: 300 }),
    ];
    saveAllPairStates(states);
    const map = loadAllPairStates(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(map.size).toBe(3);
    expect(map.get('BTCUSDT')!.balance).toBe(100);
    expect(map.get('ETHUSDT')!.balance).toBe(200);
    expect(map.get('SOLUSDT')!.balance).toBe(300);
  });

  it('loadAllPairStates skips missing pairs gracefully', () => {
    savePairState(makePair('BTCUSDT'));
    const map = loadAllPairStates(['BTCUSDT', 'MISSING']);
    expect(map.size).toBe(1);
    expect(map.has('BTCUSDT')).toBe(true);
    expect(map.has('MISSING')).toBe(false);
  });

  it('loadAllPairStates returns empty map for all-missing', () => {
    const map = loadAllPairStates(['A', 'B', 'C']);
    expect(map.size).toBe(0);
  });
});

describe('state_store — runtime metadata', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no runtime file exists', () => {
    expect(loadRuntimeMeta()).toBeNull();
  });

  it('roundtrips runtime metadata', () => {
    const meta: RuntimeMeta = {
      startedAt: 1700000000000,
      shutdownAt: 1700000050000,
      lastHeartbeat: 1700000049000,
      cycleCount: 42,
      version: '2.0.0',
    };
    saveRuntimeMeta(meta);
    const loaded = loadRuntimeMeta();
    expect(loaded).not.toBeNull();
    expect(loaded!.startedAt).toBe(1700000000000);
    expect(loaded!.cycleCount).toBe(42);
    expect(loaded!.version).toBe('2.0.0');
    expect(loaded!.shutdownAt).toBe(1700000050000);
  });

  it('detects clean shutdown from runtime metadata', () => {
    saveRuntimeMeta({
      startedAt: 1,
      shutdownAt: Date.now() - 1000,
      lastHeartbeat: Date.now() - 1000,
      cycleCount: 5,
      version: '2.0.0',
    });
    expect(wasCleanShutdown()).toBe(true);
  });

  it('treats missing shutdownAt as unclean shutdown', () => {
    saveRuntimeMeta({
      startedAt: 1,
      lastHeartbeat: Date.now(),
      cycleCount: 5,
      version: '2.0.0',
    });
    expect(wasCleanShutdown()).toBe(false);
  });
});

describe('state_store — circuit breaker', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no circuit file exists', () => {
    expect(loadCircuitState()).toBeNull();
  });

  it('roundtrips circuit state', () => {
    const state: DailyCircuitState = {
      date: today(),
      dailyPnlPct: -3.5,
      consecutiveLosses: 4,
      halted: true,
      haltedAt: Date.now(),
      haltReason: 'Max daily loss reached',
    };
    saveCircuitState(state);
    const loaded = loadCircuitState();
    expect(loaded).not.toBeNull();
    expect(loaded!.date).toBe(today());
    expect(loaded!.dailyPnlPct).toBe(-3.5);
    expect(loaded!.halted).toBe(true);
    expect(loaded!.haltReason).toBe('Max daily loss reached');
  });

  it('loadOrResetCircuit returns fresh state when no file exists', () => {
    const result = loadOrResetCircuit();
    expect(result.date).toBe(today());
    expect(result.dailyPnlPct).toBe(0);
    expect(result.consecutiveLosses).toBe(0);
    expect(result.halted).toBe(false);
  });

  it('loadOrResetCircuit returns stored state when date matches today', () => {
    const state: DailyCircuitState = {
      date: today(),
      dailyPnlPct: -2,
      consecutiveLosses: 2,
      halted: false,
    };
    saveCircuitState(state);
    const result = loadOrResetCircuit();
    expect(result.dailyPnlPct).toBe(-2);
    expect(result.consecutiveLosses).toBe(2);
  });

  it('loadOrResetCircuit resets when stored date is stale', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const stale: DailyCircuitState = {
      date: yesterday,
      dailyPnlPct: -5,
      consecutiveLosses: 10,
      halted: true,
      haltedAt: Date.now(),
      haltReason: 'Stale',
    };
    saveCircuitState(stale);
    const result = loadOrResetCircuit();
    expect(result.date).toBe(today());
    expect(result.dailyPnlPct).toBe(0);
    expect(result.halted).toBe(false);
  });
});

describe('state_store — aggregate snapshot', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrips a full snapshot', () => {
    const snap: FullSnapshot = {
      pairs: [
        makePair('BTCUSDT', { balance: 5000 }),
        makePair('ETHUSDT', { balance: 3000 }),
      ],
      runtime: {
        startedAt: 1700000000000,
        lastHeartbeat: 1700000100000,
        cycleCount: 100,
        version: '2.1.0',
      },
      circuit: {
        date: today(),
        dailyPnlPct: 1.2,
        consecutiveLosses: 0,
        halted: false,
      },
    };
    saveSnapshot(snap);
    const loaded = loadSnapshot(['BTCUSDT', 'ETHUSDT']);
    expect(loaded.pairs).toHaveLength(2);
    expect(loaded.runtime).not.toBeNull();
    expect(loaded.runtime!.version).toBe('2.1.0');
    expect(loaded.circuit).not.toBeNull();
    expect(loaded.circuit!.dailyPnlPct).toBe(1.2);
  });

  it('snapshot with null runtime/circuit only saves pairs', () => {
    const snap: FullSnapshot = {
      pairs: [makePair('SOLUSDT')],
      runtime: null,
      circuit: null,
    };
    saveSnapshot(snap);
    const loaded = loadSnapshot(['SOLUSDT']);
    expect(loaded.pairs).toHaveLength(1);
    expect(loaded.pairs[0].pair).toBe('SOLUSDT');
    // runtime/circuit remain null since no files were written
    expect(loaded.runtime).toBeNull();
    expect(loaded.circuit).toBeNull();
  });

  it('loadSnapshot with empty pairs returns empty array', () => {
    const loaded = loadSnapshot([]);
    expect(loaded.pairs).toHaveLength(0);
    expect(loaded.runtime).toBeNull();
    expect(loaded.circuit).toBeNull();
  });
});

describe('state_store — corrupt / missing file handling', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for a corrupt pair file (invalid JSON)', () => {
    // Write garbage directly via realFs into the mocked temp dir
    const pairFile = path.join(tmpDir, 'pairs', 'BADPAIR.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, '{not valid json!!!', 'utf8');
    expect(loadPairState('BADPAIR')).toBeNull();
  });

  it('returns null for an empty pair file', () => {
    const pairFile = path.join(tmpDir, 'pairs', 'EMPTY.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, '', 'utf8');
    expect(loadPairState('EMPTY')).toBeNull();
  });

  it('returns null for corrupt runtime file', () => {
    const rtFile = path.join(tmpDir, 'runtime.json');
    realFs.writeFileSync(rtFile, '<<<corrupt>>>', 'utf8');
    expect(loadRuntimeMeta()).toBeNull();
  });

  it('returns null for corrupt circuit file', () => {
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, 'null', 'utf8');
    expect(loadCircuitState()).toBeNull();
  });

  it('loadOrResetCircuit returns fresh state when file is corrupt', () => {
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, 'BROKEN{', 'utf8');
    const result = loadOrResetCircuit();
    expect(result.date).toBe(today());
    expect(result.halted).toBe(false);
    expect(result.dailyPnlPct).toBe(0);
  });

  it('loadAllPairStates skips corrupt files without throwing', () => {
    const pairFile = path.join(tmpDir, 'pairs', 'CORRUPT.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, 'NOTJSON', 'utf8');
    const map = loadAllPairStates(['CORRUPT', 'ALSO_MISSING']);
    expect(map.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
// SCHEMA VERSION — marker, legacy compat, future rejection
// ════════════════════════════════════════════════════════════

describe('state_store — schema versioning', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SCHEMA_VERSION is exported and is a positive number', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });

  it('saved pair file contains _schemaVersion envelope', () => {
    savePairState(makePair('BTCUSDT', { balance: 500 }));
    const pairFile = path.join(tmpDir, 'pairs', 'BTCUSDT.json');
    const raw = JSON.parse(realFs.readFileSync(pairFile, 'utf8'));
    expect(raw._schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.data).toBeDefined();
    expect(raw.data.balance).toBe(500);
    expect(raw.data._savedAt).toBeDefined();
  });

  it('saved runtime file contains _schemaVersion envelope', () => {
    saveRuntimeMeta({
      startedAt: 1,
      lastHeartbeat: 2,
      cycleCount: 10,
      version: '2.0.0',
    });
    const rtFile = path.join(tmpDir, 'runtime.json');
    const raw = JSON.parse(realFs.readFileSync(rtFile, 'utf8'));
    expect(raw._schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.data.cycleCount).toBe(10);
  });

  it('saved circuit file contains _schemaVersion envelope', () => {
    saveCircuitState({
      date: today(),
      dailyPnlPct: 0,
      consecutiveLosses: 0,
      halted: false,
    });
    const ctFile = path.join(tmpDir, 'circuit.json');
    const raw = JSON.parse(realFs.readFileSync(ctFile, 'utf8'));
    expect(raw._schemaVersion).toBe(SCHEMA_VERSION);
    expect(raw.data.date).toBe(today());
  });

  it('roundtrip still works with versioned envelope (pair, runtime, circuit)', () => {
    savePairState(makePair('ETHUSDT', { balance: 999 }));
    const loaded = loadPairState('ETHUSDT');
    expect(loaded).not.toBeNull();
    expect(loaded!.balance).toBe(999);
  });

  it('legacy file without _schemaVersion loads successfully (backward compat)', () => {
    const legacyRuntime = {
      startedAt: 1000,
      lastHeartbeat: 2000,
      cycleCount: 42,
      version: '1.0.0',
    };
    const rtFile = path.join(tmpDir, 'runtime.json');
    realFs.writeFileSync(rtFile, JSON.stringify(legacyRuntime), 'utf8');

    const loaded = loadRuntimeMeta();
    expect(loaded).not.toBeNull();
    expect(loaded!.cycleCount).toBe(42);
    expect(loaded!.version).toBe('1.0.0');
  });

  it('legacy pair file without _schemaVersion loads successfully', () => {
    const legacyPair = {
      pair: 'SOLUSDT',
      balance: 1234,
      positions: [],
      closedTrades: [],
      totalPnl: 50,
      totalPnlPct: 5,
      winRate: 0.6,
      strategy: {
        name: 'legacy',
        tpPct: 3,
        slPct: 2,
        maxPositions: 3,
        signalThreshold: 0.5,
        indicators: ['RSI'],
        lastUpdated: Date.now(),
        winRate: 0.6,
        totalTrades: 10,
      },
      currentPrice: 100,
      isAnalyzing: false,
      correctionCount: 0,
      _savedAt: Date.now(),
    };
    const pairFile = path.join(tmpDir, 'pairs', 'SOLUSDT.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, JSON.stringify(legacyPair), 'utf8');

    const loaded = loadPairState('SOLUSDT');
    expect(loaded).not.toBeNull();
    expect(loaded!.balance).toBe(1234);
    expect(loaded!.totalPnl).toBe(50);
  });

  it('legacy circuit file without _schemaVersion loads successfully', () => {
    const legacyCircuit = {
      date: today(),
      dailyPnlPct: -1.5,
      consecutiveLosses: 2,
      halted: false,
    };
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, JSON.stringify(legacyCircuit), 'utf8');

    const loaded = loadCircuitState();
    expect(loaded).not.toBeNull();
    expect(loaded!.dailyPnlPct).toBe(-1.5);
  });

  it('future schema version is rejected (returns null)', () => {
    const futureRuntime = {
      _schemaVersion: SCHEMA_VERSION + 99,
      data: { startedAt: 1, lastHeartbeat: 2, cycleCount: 99, version: '99.0.0' },
    };
    const rtFile = path.join(tmpDir, 'runtime.json');
    realFs.writeFileSync(rtFile, JSON.stringify(futureRuntime), 'utf8');

    expect(loadRuntimeMeta()).toBeNull();
  });

  it('future version pair file is rejected (returns null)', () => {
    const futurePair = {
      _schemaVersion: SCHEMA_VERSION + 5,
      data: {
        pair: 'XRPUSDT',
        balance: 5000,
        positions: [],
        closedTrades: [],
        totalPnl: 0,
        totalPnlPct: 0,
        winRate: 0.5,
        strategy: { name: 'x', tpPct: 1, slPct: 1, maxPositions: 1, signalThreshold: 0.5, indicators: [], lastUpdated: 1, winRate: 0.5, totalTrades: 0 },
        currentPrice: 1,
        isAnalyzing: false,
        correctionCount: 0,
      },
    };
    const pairFile = path.join(tmpDir, 'pairs', 'XRPUSDT.json');
    realFs.mkdirSync(path.dirname(pairFile), { recursive: true });
    realFs.writeFileSync(pairFile, JSON.stringify(futurePair), 'utf8');

    expect(loadPairState('XRPUSDT')).toBeNull();
  });

  it('future version circuit file is rejected', () => {
    const futureCircuit = {
      _schemaVersion: SCHEMA_VERSION + 10,
      data: { date: today(), dailyPnlPct: 0, consecutiveLosses: 0, halted: false },
    };
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, JSON.stringify(futureCircuit), 'utf8');

    expect(loadCircuitState()).toBeNull();
  });

  it('future version circuit falls back to fresh state via loadOrResetCircuit', () => {
    const futureCircuit = {
      _schemaVersion: SCHEMA_VERSION + 10,
      data: { date: today(), dailyPnlPct: -5, consecutiveLosses: 3, halted: true },
    };
    const ctFile = path.join(tmpDir, 'circuit.json');
    realFs.writeFileSync(ctFile, JSON.stringify(futureCircuit), 'utf8');

    const result = loadOrResetCircuit();
    expect(result.date).toBe(today());
    expect(result.dailyPnlPct).toBe(0);
    expect(result.halted).toBe(false);
  });

  it('full snapshot roundtrip with versioned envelope preserves all data', () => {
    const snap: FullSnapshot = {
      pairs: [makePair('BTCUSDT', { balance: 7500 })],
      runtime: { startedAt: 1, lastHeartbeat: 2, cycleCount: 77, version: '2.0' },
      circuit: { date: today(), dailyPnlPct: 2.5, consecutiveLosses: 0, halted: false },
    };
    saveSnapshot(snap);
    const loaded = loadSnapshot(['BTCUSDT']);

    expect(loaded.pairs[0].balance).toBe(7500);
    expect(loaded.runtime!.cycleCount).toBe(77);
    expect(loaded.circuit!.dailyPnlPct).toBe(2.5);
  });
});

// ════════════════════════════════════════════════════════════
// STALE PRUNING — auto-discard very old positionless states
// ════════════════════════════════════════════════════════════

describe('state_store — stale positionless pruning via loadPairState', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function saveWithAge(pair: string, ageMs: number, overrides: Partial<PairState> = {}) {
    const state = makePair(pair, overrides);
    const filePath = path.join(tmpDir, 'pairs', `${pair}.json`);
    realFs.mkdirSync(path.dirname(filePath), { recursive: true });
    const envelope = { _schemaVersion: SCHEMA_VERSION, data: { ...state, _savedAt: Date.now() - ageMs } };
    realFs.writeFileSync(filePath, JSON.stringify(envelope), 'utf8');
  }

  it('auto-discards state older than 72h with no open positions', () => {
    saveWithAge('BTCUSDT', 80 * 60 * 60 * 1000);
    expect(loadPairState('BTCUSDT')).toBeNull();
    const pairFile = path.join(tmpDir, 'pairs', 'BTCUSDT.json');
    expect(realFs.existsSync(pairFile)).toBe(false);
  });

  it('preserves state older than 72h that has open positions', () => {
    saveWithAge('ETHUSDT', 80 * 60 * 60 * 1000, {
      positions: [{ status: 'OPEN', entryPrice: 3000 } as any],
    });
    const loaded = loadPairState('ETHUSDT');
    expect(loaded).not.toBeNull();
    expect(loaded!.positions.length).toBeGreaterThan(0);
  });

  it('does not discard state between 24h-72h (only warns)', () => {
    saveWithAge('SOLUSDT', 30 * 60 * 60 * 1000);
    const loaded = loadPairState('SOLUSDT');
    expect(loaded).not.toBeNull();
  });

  it('does not discard fresh state', () => {
    saveWithAge('XRPUSDT', 1 * 60 * 60 * 1000);
    const loaded = loadPairState('XRPUSDT');
    expect(loaded).not.toBeNull();
  });

  it('state with only CLOSED positions is still pruned when old', () => {
    saveWithAge('DOGEUSDT', 80 * 60 * 60 * 1000, {
      positions: [{ status: 'CLOSED', entryPrice: 0.1 } as any],
    });
    expect(loadPairState('DOGEUSDT')).toBeNull();
  });
});

describe('state_store — pruneStalePairStates', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function saveWithAge(pair: string, ageMs: number, overrides: Partial<PairState> = {}) {
    const state = makePair(pair, overrides);
    const filePath = path.join(tmpDir, 'pairs', `${pair}.json`);
    realFs.mkdirSync(path.dirname(filePath), { recursive: true });
    const envelope = { _schemaVersion: SCHEMA_VERSION, data: { ...state, _savedAt: Date.now() - ageMs } };
    realFs.writeFileSync(filePath, JSON.stringify(envelope), 'utf8');
  }

  it('prunes stale positionless states from a given pair list', () => {
    saveWithAge('BTCUSDT', 80 * 60 * 60 * 1000);
    saveWithAge('ETHUSDT', 80 * 60 * 60 * 1000);
    saveWithAge('SOLUSDT', 1 * 60 * 60 * 1000);

    const pruned = pruneStalePairStates(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(pruned).toContain('BTCUSDT');
    expect(pruned).toContain('ETHUSDT');
    expect(pruned).not.toContain('SOLUSDT');
    expect(loadPairState('SOLUSDT')).not.toBeNull();
  });

  it('does not prune states with open positions', () => {
    saveWithAge('BTCUSDT', 80 * 60 * 60 * 1000, {
      positions: [{ status: 'OPEN' } as any],
    });
    const pruned = pruneStalePairStates(['BTCUSDT']);
    expect(pruned).toHaveLength(0);
  });

  it('returns empty for pairs with no state files', () => {
    const pruned = pruneStalePairStates(['NONEXISTENT']);
    expect(pruned).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// ORPHAN PRUNING — remove state files for inactive pairs
// ════════════════════════════════════════════════════════════

describe('state_store — pruneOrphanPairStates', () => {
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'state-store-test-'));
  });
  afterEach(() => {
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes state files for pairs not in active list', () => {
    savePairState(makePair('BTCUSDT'));
    savePairState(makePair('ETHUSDT'));
    savePairState(makePair('REMOVED_COIN'));

    const pruned = pruneOrphanPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(pruned).toEqual(['REMOVED_COIN']);
    expect(loadPairState('REMOVED_COIN')).toBeNull();
    expect(loadPairState('BTCUSDT')).not.toBeNull();
    expect(loadPairState('ETHUSDT')).not.toBeNull();
  });

  it('returns empty array when all files match active pairs', () => {
    savePairState(makePair('BTCUSDT'));
    savePairState(makePair('ETHUSDT'));

    const pruned = pruneOrphanPairStates(['BTCUSDT', 'ETHUSDT']);
    expect(pruned).toHaveLength(0);
  });

  it('returns empty when PAIR_DIR does not exist', () => {
    const pruned = pruneOrphanPairStates(['BTCUSDT']);
    expect(pruned).toHaveLength(0);
  });

  it('ignores non-JSON files in PAIR_DIR', () => {
    savePairState(makePair('BTCUSDT'));
    const strayFile = path.join(tmpDir, 'pairs', 'notes.txt');
    realFs.mkdirSync(path.dirname(strayFile), { recursive: true });
    realFs.writeFileSync(strayFile, 'ignore me', 'utf8');

    const pruned = pruneOrphanPairStates(['BTCUSDT']);
    expect(pruned).toHaveLength(0);
    expect(realFs.existsSync(strayFile)).toBe(true);
  });

  it('handles multiple orphans in a single call', () => {
    savePairState(makePair('OLD1'));
    savePairState(makePair('OLD2'));
    savePairState(makePair('OLD3'));
    savePairState(makePair('BTCUSDT'));

    const pruned = pruneOrphanPairStates(['BTCUSDT']);
    expect(pruned.sort()).toEqual(['OLD1', 'OLD2', 'OLD3']);
    expect(loadPairState('BTCUSDT')).not.toBeNull();
  });
});
