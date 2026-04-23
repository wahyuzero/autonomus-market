import { describe, it, expect } from 'vitest';
import { getSourceStatus as getCryptoStatus, isWsConnected } from '../data/crypto';
import { getSourceStatus as getForexStatus, getForexPrice } from '../data/forex';
import { getSourceStatus as getCommodityStatus, getCommodityPrice } from '../data/commodity';
import { getSourceStatus as getCalendarStatus } from '../data/calendar';
import type { SourceStatus, SourceHealthTier } from '../config';

const VALID_TIERS: SourceHealthTier[] = ['LIVE', 'DEGRADED', 'SIMULATION'];

function assertValidSourceStatus(result: SourceStatus, expectedSource: string) {
  expect(result.source).toBe(expectedSource);
  expect(VALID_TIERS).toContain(result.status);
  expect(typeof result.message).toBe('string');
  expect(result.message.length).toBeGreaterThan(0);
  expect(typeof result.lastUpdated).toBe('number');
  expect(result.lastUpdated).toBeGreaterThan(0);
}

describe('crypto source status', () => {
  it('returns a valid SourceStatus with source "crypto"', () => {
    const status = getCryptoStatus();
    assertValidSourceStatus(status, 'crypto');
  });

  it('reports SIMULATION when ws is not connected and not simulating', () => {
    const status = getCryptoStatus();
    if (!isWsConnected()) {
      expect(status.status).toMatch(/^(SIMULATION|DEGRADED)$/);
    }
  });

  it('includes trackedPairs in metadata', () => {
    const status = getCryptoStatus();
    expect(status.metadata).toHaveProperty('trackedPairs');
    expect(typeof (status.metadata as any).trackedPairs).toBe('number');
  });
});

describe('forex source status', () => {
  it('returns a valid SourceStatus with source "forex"', () => {
    const status = getForexStatus();
    assertValidSourceStatus(status, 'forex');
  });

  it('reports SIMULATION before any fetch', () => {
    const status = getForexStatus();
    if (getForexPrice('EURUSD') === 0) {
      expect(status.status).toBe('SIMULATION');
    }
  });

  it('includes pairsLoaded in metadata', () => {
    const status = getForexStatus();
    expect(status.metadata).toHaveProperty('pairsLoaded');
  });
});

describe('commodity source status', () => {
  it('returns a valid SourceStatus with source "commodity"', () => {
    const status = getCommodityStatus();
    assertValidSourceStatus(status, 'commodity');
  });

  it('includes pairsTracked in metadata', () => {
    const status = getCommodityStatus();
    expect(status.metadata).toHaveProperty('pairsTracked');
    expect((status.metadata as any).pairsTracked).toBeGreaterThanOrEqual(3);
  });

  it('seed prices are always available', () => {
    const price = getCommodityPrice('XAUUSD');
    expect(price).toBeGreaterThan(0);
  });
});

describe('calendar source status', () => {
  it('returns a valid SourceStatus with source "calendar"', () => {
    const status = getCalendarStatus();
    assertValidSourceStatus(status, 'calendar');
  });

  it('includes eventsCount in metadata', () => {
    const status = getCalendarStatus();
    expect(status.metadata).toHaveProperty('eventsCount');
    expect(typeof (status.metadata as any).eventsCount).toBe('number');
  });
});

describe('all sources produce consistent shape', () => {
  const sources = [
    { name: 'crypto', fn: getCryptoStatus },
    { name: 'forex', fn: getForexStatus },
    { name: 'commodity', fn: getCommodityStatus },
    { name: 'calendar', fn: getCalendarStatus },
  ];

  for (const { name, fn } of sources) {
    it(`${name}: lastUpdated is recent (within 2s)`, () => {
      const before = Date.now();
      const status = fn();
      const after = Date.now();
      expect(status.lastUpdated).toBeGreaterThanOrEqual(before - 100);
      expect(status.lastUpdated).toBeLessThanOrEqual(after + 100);
    });
  }
});
