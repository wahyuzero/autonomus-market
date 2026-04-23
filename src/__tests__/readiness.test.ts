import { describe, it, expect, vi } from 'vitest';
import {
  waitForDataReadiness,
  DEFAULT_PROBES,
  isSourceReady,
  modeToRequiredTier,
  resolveRequiredTier,
  type ReadinessProbe,
} from '../engine/readiness';
import type { SourceStatus } from '../config';

function makeProbe(name: string, status: SourceStatus): ReadinessProbe {
  return { name, getStatus: () => ({ ...status }) };
}

const READY_STATUS: SourceStatus = {
  source: 'test',
  status: 'SIMULATION',
  message: 'ready',
  lastUpdated: Date.now(),
};

const NOT_READY_STATUS: SourceStatus = {
  source: 'test',
  status: 'SIMULATION',
  message: '',
  lastUpdated: 0,
};

describe('waitForDataReadiness', () => {
  it('returns ready immediately when all probes report ready', async () => {
    const probes = [
      makeProbe('a', READY_STATUS),
      makeProbe('b', READY_STATUS),
    ];

    const result = await waitForDataReadiness({
      timeoutMs: 2000,
      probeIntervalMs: 50,
      probes,
    });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(500);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].name).toBe('a');
    expect(result.sources[1].name).toBe('b');
  });

  it('returns ready after retries when probes become ready', async () => {
    let callCount = 0;
    const lazyProbe: ReadinessProbe = {
      name: 'lazy',
      getStatus: () => {
        callCount++;
        if (callCount < 3) return { ...READY_STATUS, status: 'DEGRADED' };
        return { ...READY_STATUS, status: 'LIVE' };
      },
    };

    const result = await waitForDataReadiness({
      timeoutMs: 2000,
      probeIntervalMs: 30,
      probes: [lazyProbe],
      mode: 'live',
    });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('times out when probes never become ready', async () => {
    const probe = makeProbe('stuck', { ...READY_STATUS, status: 'DEGRADED' });

    const result = await waitForDataReadiness({
      timeoutMs: 150,
      probeIntervalMs: 30,
      probes: [probe],
      mode: 'live',
    });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(140);
    expect(result.sources).toHaveLength(1);
  });

  it('reports sources snapshot on timeout', async () => {
    const probe = makeProbe('flaky', {
      source: 'test',
      status: 'DEGRADED',
      message: 'not live yet',
      lastUpdated: Date.now(),
    });

    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probeIntervalMs: 30,
      probes: [probe],
      mode: 'live',
    });

    expect(result.ready).toBe(false);
    expect(result.sources[0].status).toBe('DEGRADED');
  });

  it('works with empty probes array (vacuously ready)', async () => {
    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probes: [],
    });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.sources).toHaveLength(0);
  });

  it('usable mode accepts DEGRADED and SIMULATION as ready', async () => {
    const probes = [
      makeProbe('a', { ...READY_STATUS, status: 'DEGRADED' }),
      makeProbe('b', { ...READY_STATUS, status: 'SIMULATION' }),
    ];

    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probes,
      mode: 'usable',
    });

    expect(result.ready).toBe(true);
  });

  it('live mode requires LIVE status', async () => {
    const probes = [
      makeProbe('a', { ...READY_STATUS, status: 'LIVE' }),
      makeProbe('b', { ...READY_STATUS, status: 'DEGRADED' }),
    ];

    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probeIntervalMs: 20,
      probes,
      mode: 'live',
    });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('per-market requirement can override usable mode', async () => {
    const probes = [
      makeProbe('crypto', { ...READY_STATUS, source: 'crypto', status: 'DEGRADED' }),
      makeProbe('forex', { ...READY_STATUS, source: 'forex', status: 'SIMULATION' }),
    ];

    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probeIntervalMs: 20,
      probes,
      mode: 'usable',
      requirements: { crypto: 'LIVE', forex: 'SIMULATION' },
    });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('per-market requirement passes when source meets minimum tier', async () => {
    const probes = [
      makeProbe('crypto', { ...READY_STATUS, source: 'crypto', status: 'LIVE' }),
      makeProbe('forex', { ...READY_STATUS, source: 'forex', status: 'DEGRADED' }),
    ];

    const result = await waitForDataReadiness({
      timeoutMs: 100,
      probes,
      mode: 'usable',
      requirements: { crypto: 'LIVE', forex: 'DEGRADED' },
    });

    expect(result.ready).toBe(true);
  });
});

describe('isSourceReady', () => {
  it('usable mode accepts initialized statuses', () => {
    expect(isSourceReady({ ...READY_STATUS, status: 'SIMULATION' }, 'usable')).toBe(true);
    expect(isSourceReady({ ...READY_STATUS, status: 'DEGRADED' }, 'usable')).toBe(true);
    expect(isSourceReady({ ...READY_STATUS, status: 'LIVE' }, 'usable')).toBe(true);
  });

  it('live mode only accepts LIVE', () => {
    expect(isSourceReady({ ...READY_STATUS, status: 'LIVE' }, 'live')).toBe(true);
    expect(isSourceReady({ ...READY_STATUS, status: 'DEGRADED' }, 'live')).toBe(false);
    expect(isSourceReady({ ...READY_STATUS, status: 'SIMULATION' }, 'live')).toBe(false);
  });

  it('honors explicit per-market minimum tier overrides', () => {
    expect(isSourceReady({ ...READY_STATUS, source: 'crypto', status: 'DEGRADED' }, 'usable', { crypto: 'LIVE' }, 'crypto')).toBe(false);
    expect(isSourceReady({ ...READY_STATUS, source: 'forex', status: 'DEGRADED' }, 'usable', { forex: 'DEGRADED' }, 'forex')).toBe(true);
    expect(isSourceReady({ ...READY_STATUS, source: 'commodity', status: 'SIMULATION' }, 'live', { commodity: 'SIMULATION' }, 'commodity')).toBe(true);
  });
});

describe('required tier helpers', () => {
  it('maps modes to default required tiers', () => {
    expect(modeToRequiredTier('usable')).toBe('SIMULATION');
    expect(modeToRequiredTier('live')).toBe('LIVE');
  });

  it('resolves per-market requirement overrides', () => {
    expect(resolveRequiredTier('crypto', 'usable', { crypto: 'LIVE' })).toBe('LIVE');
    expect(resolveRequiredTier('forex', 'usable', { crypto: 'LIVE' })).toBe('SIMULATION');
    expect(resolveRequiredTier('commodity', 'live')).toBe('LIVE');
  });
});

describe('DEFAULT_PROBES', () => {
  it('contains crypto, forex, and commodity probes', () => {
    const names = DEFAULT_PROBES.map(p => p.name);
    expect(names).toContain('crypto');
    expect(names).toContain('forex');
    expect(names).toContain('commodity');
    expect(DEFAULT_PROBES).toHaveLength(3);
  });

  it('each probe returns a valid SourceStatus', () => {
    for (const probe of DEFAULT_PROBES) {
      const status = probe.getStatus();
      expect(status).toHaveProperty('source');
      expect(status).toHaveProperty('status');
      expect(status).toHaveProperty('message');
      expect(status).toHaveProperty('lastUpdated');
    }
  });
});
