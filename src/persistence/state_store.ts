// ============================================================
// STATE STORE - File-based JSON persistence for restart safety
// Phase 2: Pair state, runtime metadata, daily circuit-breaker
// Phase 2.1: Schema version markers + compatibility guards
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { PairState } from '../config';

// ── Paths ──────────────────────────────────────────────────
const DATA_DIR   = path.resolve(__dirname, '../../data/state');
const PAIR_DIR   = path.join(DATA_DIR, 'pairs');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const CIRCUIT_FILE = path.join(DATA_DIR, 'circuit.json');
const STALE_PAIR_STATE_MS = 24 * 60 * 60 * 1000;  // 24h — warning threshold
const PRUNE_STALE_MS      = 3 * 24 * 60 * 60 * 1000; // 72h — auto-discard threshold for positionless states

// ── Schema versioning ──────────────────────────────────────

/** Bumped when the on-disk format changes incompatibly. */
export const SCHEMA_VERSION = 1;

/** Shape written to disk for every persisted file. */
interface VersionedEnvelope<T> {
  _schemaVersion: number;
  data: T;
}

// ── Internal helpers ───────────────────────────────────────

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read JSON from disk with schema version check.
 *
 * - **No version marker** → legacy file, return as-is (backward compat).
 * - **Version == SCHEMA_VERSION** → current, unwrap and return.
 * - **Version > SCHEMA_VERSION** → future/unknown, return `null` + warn.
 * - **Parse error or missing file** → return `null`.
 */
function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    // Legacy files that predate versioning: treat as raw data
    if (parsed === null || typeof parsed !== 'object' || !('_schemaVersion' in (parsed as Record<string, unknown>))) {
      return parsed as T;
    }

    const envelope = parsed as VersionedEnvelope<T>;
    if (envelope._schemaVersion > SCHEMA_VERSION) {
      console.warn(
        `[Persistence] ⚠️ ${path.basename(filePath)} has schema version ${envelope._schemaVersion}, ` +
        `but this build supports up to ${SCHEMA_VERSION}. File skipped.`
      );
      return null;
    }

    return envelope.data;
  } catch {
    return null;
  }
}

/** Write JSON to disk wrapped in a versioned envelope (atomic via temp file). */
function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const envelope: VersionedEnvelope<unknown> = { _schemaVersion: SCHEMA_VERSION, data };
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(envelope, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

type PersistedPairState = PairState & { _savedAt?: number };

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function validatePairState(raw: unknown): PersistedPairState | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const strategy = candidate.strategy as Record<string, unknown> | undefined;

  const valid =
    isString(candidate.pair) &&
    isNumber(candidate.balance) &&
    Array.isArray(candidate.positions) &&
    Array.isArray(candidate.closedTrades) &&
    isNumber(candidate.totalPnl) &&
    isNumber(candidate.totalPnlPct) &&
    isNumber(candidate.winRate) &&
    isNumber(candidate.currentPrice) &&
    typeof candidate.isAnalyzing === 'boolean' &&
    isNumber(candidate.correctionCount) &&
    !!strategy &&
    isString(strategy.name) &&
    isNumber(strategy.tpPct) &&
    isNumber(strategy.slPct) &&
    isNumber(strategy.maxPositions) &&
    isNumber(strategy.signalThreshold) &&
    Array.isArray(strategy.indicators) &&
    isNumber(strategy.lastUpdated) &&
    isNumber(strategy.winRate) &&
    isNumber(strategy.totalTrades);

  if (!valid) return null;

  return candidate as unknown as PersistedPairState;
}

// ============================================================
// PAIR STATE — one file per pair
// ============================================================

export function loadPairState(pair: string): PairState | null {
  const raw = readJson<PersistedPairState>(path.join(PAIR_DIR, `${pair}.json`));
  const validState = validatePairState(raw);
  if (!validState) return null;

  if (isNumber(validState._savedAt)) {
    const ageMs = Date.now() - validState._savedAt;
    if (ageMs > PRUNE_STALE_MS) {
      const hasOpenPositions = validState.positions.some(p => p.status === 'OPEN');
      if (!hasOpenPositions) {
        console.warn(`[Persistence] 🗑️ Discarding stale positionless state for ${pair} (${Math.round(ageMs / 3600000)}h old)`);
        deletePairState(pair);
        return null;
      }
      console.warn(`[Persistence] ⚠️ Pair state for ${pair} is ${Math.round(ageMs / 3600000)}h old — has open positions, preserving`);
    } else if (ageMs > STALE_PAIR_STATE_MS) {
      console.warn(`[Persistence] ⚠️ Pair state for ${pair} is ${Math.round(ageMs / 3600000)}h old`);
    }
  }

  const { _savedAt, ...state } = validState;
  return state as PairState;
}

export function savePairState(state: PairState): void {
  writeJson(path.join(PAIR_DIR, `${state.pair}.json`), { ...state, _savedAt: Date.now() });
}

export function loadAllPairStates(pairs: string[]): Map<string, PairState> {
  const map = new Map<string, PairState>();
  for (const pair of pairs) {
    const state = loadPairState(pair);
    if (state) map.set(pair, state);
  }
  return map;
}

export function saveAllPairStates(states: PairState[]): void {
  for (const state of states) {
    savePairState(state);
  }
}

export function deletePairState(pair: string): void {
  const file = path.join(PAIR_DIR, `${pair}.json`);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

export function pruneOrphanPairStates(activePairs: string[]): string[] {
  const pruned: string[] = [];
  const activeSet = new Set(activePairs);

  try {
    if (!fs.existsSync(PAIR_DIR)) return pruned;
    const files = fs.readdirSync(PAIR_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const pair = file.slice(0, -5);
      if (!activeSet.has(pair)) {
        try {
          fs.unlinkSync(path.join(PAIR_DIR, file));
          pruned.push(pair);
          console.warn(`[Persistence] 🗑️ Pruned orphan state file for ${pair}`);
        } catch { /* ignore unlink errors */ }
      }
    }
  } catch { /* ignore readdir errors */ }

  return pruned;
}

export function pruneStalePairStates(pairs: string[]): string[] {
  const pruned: string[] = [];
  for (const pair of pairs) {
    const filePath = path.join(PAIR_DIR, `${pair}.json`);
    const raw = readJson<PersistedPairState>(filePath);
    if (!raw) continue;

    const validState = validatePairState(raw);
    if (!validState || !isNumber(validState._savedAt)) continue;

    const ageMs = Date.now() - validState._savedAt;
    if (ageMs > PRUNE_STALE_MS) {
      const hasOpenPositions = validState.positions.some(p => p.status === 'OPEN');
      if (!hasOpenPositions) {
        deletePairState(pair);
        pruned.push(pair);
        console.warn(`[Persistence] 🗑️ Pruned stale positionless state for ${pair} (${Math.round(ageMs / 3600000)}h old)`);
      }
    }
  }
  return pruned;
}

// ============================================================
// RUNTIME METADATA — single file for process-level state
// ============================================================

export interface RuntimeMeta {
  startedAt: number;
  shutdownAt?: number;
  lastHeartbeat: number;
  cycleCount: number;
  version: string;
}

export function loadRuntimeMeta(): RuntimeMeta | null {
  return readJson<RuntimeMeta>(RUNTIME_FILE);
}

export function saveRuntimeMeta(meta: RuntimeMeta): void {
  writeJson(RUNTIME_FILE, meta);
}

export function wasCleanShutdown(): boolean {
  const meta = loadRuntimeMeta();
  return !!meta?.shutdownAt && meta.shutdownAt > 0 && meta.shutdownAt <= Date.now();
}

// ============================================================
// DAILY CIRCUIT BREAKER — reset each new calendar day
// ============================================================

export interface DailyCircuitState {
  date: string;            // YYYY-MM-DD
  dailyPnlPct: number;
  consecutiveLosses: number;
  halted: boolean;
  haltedAt?: number;
  haltReason?: string;
}

export function loadCircuitState(): DailyCircuitState | null {
  return readJson<DailyCircuitState>(CIRCUIT_FILE);
}

export function saveCircuitState(state: DailyCircuitState): void {
  writeJson(CIRCUIT_FILE, state);
}

/** Check if stored circuit state belongs to today; if stale, return a fresh state. */
export function loadOrResetCircuit(): DailyCircuitState {
  const today = new Date().toISOString().slice(0, 10);
  const stored = loadCircuitState();
  if (stored && stored.date === today) return stored;
  return { date: today, dailyPnlPct: 0, consecutiveLosses: 0, halted: false };
}

// ============================================================
// AGGREGATE — save / restore everything in one call
// ============================================================

export interface FullSnapshot {
  pairs: PairState[];
  runtime: RuntimeMeta | null;
  circuit: DailyCircuitState | null;
}

export function saveSnapshot(snap: FullSnapshot): void {
  saveAllPairStates(snap.pairs);
  if (snap.runtime) saveRuntimeMeta(snap.runtime);
  if (snap.circuit) saveCircuitState(snap.circuit);
}

export function loadSnapshot(pairs: string[]): FullSnapshot {
  const pairStates = loadAllPairStates(pairs);
  return {
    pairs: Array.from(pairStates.values()),
    runtime: loadRuntimeMeta(),
    circuit: loadCircuitState(),
  };
}
