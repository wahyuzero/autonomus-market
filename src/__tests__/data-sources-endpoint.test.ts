import { describe, it, expect } from 'vitest';
import { gatherSourceStatuses } from '../dashboard/server';
import type { SourceHealthTier } from '../config';

const VALID_TIERS: SourceHealthTier[] = ['LIVE', 'DEGRADED', 'SIMULATION'];
const EXPECTED_SOURCES = ['crypto', 'forex', 'commodity', 'calendar'];

describe('gatherSourceStatuses', () => {
  it('returns an array of exactly 4 source statuses', () => {
    const statuses = gatherSourceStatuses();
    expect(Array.isArray(statuses)).toBe(true);
    expect(statuses).toHaveLength(4);
  });

  it('contains all expected source names', () => {
    const statuses = gatherSourceStatuses();
    const names = statuses.map(s => s.source);
    for (const expected of EXPECTED_SOURCES) {
      expect(names).toContain(expected);
    }
  });

  it('each entry has the required SourceStatus fields', () => {
    const statuses = gatherSourceStatuses();
    for (const s of statuses) {
      expect(typeof s.source).toBe('string');
      expect(VALID_TIERS).toContain(s.status);
      expect(typeof s.message).toBe('string');
      expect(s.message.length).toBeGreaterThan(0);
      expect(typeof s.lastUpdated).toBe('number');
      expect(s.lastUpdated).toBeGreaterThan(0);
    }
  });

  it('lastUpdated timestamps are recent (within 2s of now)', () => {
    const before = Date.now();
    const statuses = gatherSourceStatuses();
    const after = Date.now();
    for (const s of statuses) {
      expect(s.lastUpdated).toBeGreaterThanOrEqual(before - 100);
      expect(s.lastUpdated).toBeLessThanOrEqual(after + 100);
    }
  });
});

describe('data-sources endpoint shape (response contract)', () => {
  it('response is JSON-serializable', () => {
    const statuses = gatherSourceStatuses();
    const json = JSON.stringify(statuses);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toHaveProperty('source');
    expect(parsed[0]).toHaveProperty('status');
    expect(parsed[0]).toHaveProperty('message');
    expect(parsed[0]).toHaveProperty('lastUpdated');
  });

  it('each source has a unique name', () => {
    const statuses = gatherSourceStatuses();
    const names = statuses.map(s => s.source);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
