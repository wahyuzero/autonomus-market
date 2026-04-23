// ============================================================
// DATA READINESS GATE — probes data sources before orchestrator
//
// Replaces the blind fixed-sleep warmup with bounded polling
// that checks whether crypto / forex / commodity feeds have
// at least SIMULATION-grade data available.
// ============================================================

import { getSourceStatus as getCryptoStatus } from '../data/crypto';
import { getSourceStatus as getForexStatus } from '../data/forex';
import { getSourceStatus as getCommodityStatus } from '../data/commodity';
import type { SourceHealthTier, SourceStatus } from '../config';

// ── Types ────────────────────────────────────────────────────

export interface ReadinessProbe {
  name: string;
  getStatus: () => SourceStatus;
}

export interface ReadinessResult {
  ready: boolean;
  timedOut: boolean;
  elapsedMs: number;
  sources: Array<{ name: string; status: string; message: string }>;
}

export type ReadinessMode = 'usable' | 'live';

export interface ReadinessOptions {
  /** Maximum time to wait (ms). Default 10 000. */
  timeoutMs?: number;
  /** Interval between probe attempts (ms). Default 500. */
  probeIntervalMs?: number;
  /** Injectable probes (for testing). Defaults to crypto+forex+commodity. */
  probes?: ReadinessProbe[];
  /** Readiness semantics: usable accepts any initialized tier, live requires LIVE status. */
  mode?: ReadinessMode;
  /** Optional per-source minimum tiers that override mode-derived defaults. */
  requirements?: Partial<Record<string, SourceHealthTier>>;
}

// ── Default probes (production) ──────────────────────────────

export const DEFAULT_PROBES: ReadinessProbe[] = [
  { name: 'crypto', getStatus: getCryptoStatus },
  { name: 'forex', getStatus: getForexStatus },
  { name: 'commodity', getStatus: getCommodityStatus },
];

const TIER_RANK: Record<SourceHealthTier, number> = {
  SIMULATION: 1,
  DEGRADED: 2,
  LIVE: 3,
};

export function modeToRequiredTier(mode: ReadinessMode): SourceHealthTier {
  return mode === 'live' ? 'LIVE' : 'SIMULATION';
}

export function resolveRequiredTier(
  probeName: string,
  mode: ReadinessMode,
  requirements?: Partial<Record<string, SourceHealthTier>>,
): SourceHealthTier {
  return requirements?.[probeName] ?? modeToRequiredTier(mode);
}

export function isSourceReady(
  status: SourceStatus,
  mode: ReadinessMode,
  requirements?: Partial<Record<string, SourceHealthTier>>,
  probeName?: string,
): boolean {
  const requiredTier = resolveRequiredTier(probeName ?? status.source, mode, requirements);
  return TIER_RANK[status.status] >= TIER_RANK[requiredTier];
}

// ── Helper ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll data-source probes until every source satisfies the configured
 * readiness semantics, or the timeout expires.
 *
 * `usable` mode accepts any initialized status (LIVE/DEGRADED/SIMULATION).
 * `live` mode only accepts LIVE.
 */
export async function waitForDataReadiness(
  opts: ReadinessOptions = {},
): Promise<ReadinessResult> {
  const {
    timeoutMs = 10_000,
    probeIntervalMs = 500,
    probes = DEFAULT_PROBES,
    mode = 'usable',
    requirements,
  } = opts;

  const deadline = Date.now() + timeoutMs;
  const startTime = Date.now();

  // Track which sources were seen ready at least once
  const readySet = new Set<string>();

  while (true) {
    const sources: ReadinessResult['sources'] = [];
    let allReady = true;

    for (const probe of probes) {
      const status = probe.getStatus();
      sources.push({
        name: probe.name,
        status: status.status,
        message: status.message,
      });

      const isReady = isSourceReady(status, mode, requirements, probe.name);
      if (isReady) {
        readySet.add(probe.name);
      } else {
        allReady = false;
      }
    }

    if (allReady) {
      const elapsedMs = Date.now() - startTime;
      console.log(
        `[Readiness] ✅ All ${probes.length} data sources ready in ${elapsedMs}ms`,
      );
      console.log(`[Readiness] Mode: ${mode}`);
      for (const s of sources) {
        const requiredTier = resolveRequiredTier(s.name, mode, requirements);
        console.log(`[Readiness]   ${s.name}: ${s.status} (requires ${requiredTier}) — ${s.message}`);
      }
      return { ready: true, timedOut: false, elapsedMs, sources };
    }

    if (Date.now() >= deadline) {
      const elapsedMs = Date.now() - startTime;
      const missing = probes
        .filter(p => !readySet.has(p.name))
        .map(p => p.name);
      console.warn(
        `[Readiness] ⏱ Timed out after ${elapsedMs}ms — not ready: ${missing.join(', ') || '(none)'}`,
      );
      console.warn(`[Readiness] Mode: ${mode}`);
      for (const s of sources) {
        const requiredTier = resolveRequiredTier(s.name, mode, requirements);
        console.warn(`[Readiness]   ${s.name}: ${s.status} (requires ${requiredTier}) — ${s.message}`);
      }
      return { ready: false, timedOut: true, elapsedMs, sources };
    }

    await sleep(probeIntervalMs);
  }
}
