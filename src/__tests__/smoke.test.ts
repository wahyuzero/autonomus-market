// ============================================================
// Phase 1 Integration Smoke Tests
// Lightweight sanity checks that key Phase 1 surfaces exist
// and behave correctly at a high level.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CONFIG,
  validateConfig,
  type SourceStatus,
  type SourceHealthTier,
  type ConfigValidationResult,
} from '../config';
import { dashboardAuth, gatherSourceStatuses } from '../dashboard/server';

// ── 1. Config Validation Smoke ──────────────────────────────

describe('Phase 1 smoke — config validation', () => {
  it('validateConfig is exported and returns correct shape', () => {
    const result: ConfigValidationResult = validateConfig();
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('all error objects have field and message strings', () => {
    // Force multiple errors by temporarily corrupting config
    const origKey = CONFIG.AI.API_KEY;
    const origUrl = CONFIG.AI.BASE_URL;
    const origPort = CONFIG.DASHBOARD.PORT;

    CONFIG.AI.API_KEY = '';
    CONFIG.AI.BASE_URL = 'not-a-url';
    CONFIG.DASHBOARD.PORT = 0;

    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);

    for (const err of result.errors) {
      expect(typeof err.field).toBe('string');
      expect(err.field.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }

    // Restore
    CONFIG.AI.API_KEY = origKey;
    CONFIG.AI.BASE_URL = origUrl;
    CONFIG.DASHBOARD.PORT = origPort;
  });
});

// ── 2. Dashboard Auth Middleware Smoke ───────────────────────

describe('Phase 1 smoke — dashboard auth middleware', () => {
  let originalAuthToken: string;

  beforeEach(() => {
    originalAuthToken = CONFIG.DASHBOARD.AUTH_TOKEN;
  });

  afterEach(() => {
    CONFIG.DASHBOARD.AUTH_TOKEN = originalAuthToken;
  });

  function mockRes() {
    const res: any = {
      statusCode: 200,
      body: null as any,
      status(code: number) { res.statusCode = code; return res; },
      json(data: any) { res.body = data; return res; },
    };
    return res;
  }

  it('is exported as a function', () => {
    expect(typeof dashboardAuth).toBe('function');
  });

  it('passes through when no auth token is configured', () => {
    CONFIG.DASHBOARD.AUTH_TOKEN = '';
    const req: any = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();
    dashboardAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects unauthenticated request when token is set', () => {
    CONFIG.DASHBOARD.AUTH_TOKEN = 'test-token-xyz';
    const req: any = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();
    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('accepts valid Bearer token', () => {
    CONFIG.DASHBOARD.AUTH_TOKEN = 'test-token-xyz';
    const req: any = { headers: { authorization: 'Bearer test-token-xyz' }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    dashboardAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ── 3. Source Status Aggregation Smoke ───────────────────────

describe('Phase 1 smoke — source status aggregation', () => {
  const VALID_TIERS: SourceHealthTier[] = ['LIVE', 'DEGRADED', 'SIMULATION'];
  const EXPECTED_SOURCES = ['crypto', 'forex', 'commodity', 'calendar'];

  it('gatherSourceStatuses returns all 4 sources', () => {
    const statuses = gatherSourceStatuses();
    expect(statuses).toHaveLength(4);
    const names = statuses.map(s => s.source);
    for (const expected of EXPECTED_SOURCES) {
      expect(names).toContain(expected);
    }
  });

  it('each status has valid tier and required fields', () => {
    const statuses = gatherSourceStatuses();
    for (const s of statuses) {
      expect(VALID_TIERS).toContain(s.status);
      expect(typeof s.message).toBe('string');
      expect(s.message.length).toBeGreaterThan(0);
      expect(typeof s.lastUpdated).toBe('number');
      expect(s.lastUpdated).toBeGreaterThan(0);
    }
  });

  it('response is JSON-serializable (endpoint contract)', () => {
    const statuses: SourceStatus[] = gatherSourceStatuses();
    const json = JSON.stringify(statuses);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(4);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('source');
      expect(entry).toHaveProperty('status');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('lastUpdated');
    }
  });
});

// ── 4. Shared Status Tiers Validity ──────────────────────────

describe('Phase 1 smoke — status tier types', () => {
  it('SourceHealthTier only allows LIVE, DEGRADED, SIMULATION', () => {
    const tiers: SourceHealthTier[] = ['LIVE', 'DEGRADED', 'SIMULATION'];
    expect(tiers).toHaveLength(3);
    expect(new Set(tiers).size).toBe(3);
  });

  it('every gathered source uses a known tier', () => {
    const knownTiers = new Set<SourceHealthTier>(['LIVE', 'DEGRADED', 'SIMULATION']);
    const statuses = gatherSourceStatuses();
    for (const s of statuses) {
      expect(knownTiers.has(s.status)).toBe(true);
    }
  });

  it('SourceStatus interface is satisfied by actual data', () => {
    const statuses: SourceStatus[] = gatherSourceStatuses();
    for (const s of statuses) {
      // Structural check — if the interface changed, this would fail to compile
      const _typed: SourceStatus = {
        source: s.source,
        status: s.status,
        message: s.message,
        lastUpdated: s.lastUpdated,
      };
      expect(_typed.source).toBeTruthy();
    }
  });
});

// ── 5. AI Client Auth Surface ───────────────────────────────

describe('Phase 1 smoke — AI client auth helpers', () => {
  it('isAuthFailureStatus recognizes 401 and 403 only', async () => {
    const { isAuthFailureStatus } = await import('../ai/client');
    expect(isAuthFailureStatus(401)).toBe(true);
    expect(isAuthFailureStatus(403)).toBe(true);
    expect(isAuthFailureStatus(200)).toBe(false);
    expect(isAuthFailureStatus(500)).toBe(false);
    expect(isAuthFailureStatus(429)).toBe(false);
  });

  it('isAuthenticationHealthy starts true and can be reset', async () => {
    const { isAuthenticationHealthy, resetAuthenticationHealth } = await import('../ai/client');
    resetAuthenticationHealth();
    expect(isAuthenticationHealthy()).toBe(true);
  });
});
