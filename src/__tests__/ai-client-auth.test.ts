import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted ensures mockStream is available when vi.mock factory executes
const { mockStream } = vi.hoisted(() => ({ mockStream: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: mockStream };
  },
}));

import {
  isAuthFailureStatus,
  isAuthenticationHealthy,
  resetAuthenticationHealth,
} from '../ai/client';

let askAI: typeof import('../ai/client').askAI;

describe('AI client — auth failure handling', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetAuthenticationHealth();
    // Dynamic re-import so module-level state is fresh
    const mod = await import('../ai/client');
    askAI = mod.askAI;
    // Reset auth health again after re-import (module sets it to true)
    mod.resetAuthenticationHealth();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── isAuthFailureStatus ────────────────────────────────────

  describe('isAuthFailureStatus', () => {
    it('recognises 401 as auth failure', () => {
      expect(isAuthFailureStatus(401)).toBe(true);
    });

    it('recognises 403 as auth failure', () => {
      expect(isAuthFailureStatus(403)).toBe(true);
    });

    it('does NOT classify 429 as auth failure', () => {
      expect(isAuthFailureStatus(429)).toBe(false);
    });

    it('does NOT classify 500 as auth failure', () => {
      expect(isAuthFailureStatus(500)).toBe(false);
    });

    it('does NOT classify 200 as auth failure', () => {
      expect(isAuthFailureStatus(200)).toBe(false);
    });
  });

  // ── Authentication health flag ─────────────────────────────

  describe('authentication health flag', () => {
    it('starts healthy', () => {
      expect(isAuthenticationHealthy()).toBe(true);
    });

    it('resetAuthenticationHealth sets flag to true', () => {
      resetAuthenticationHealth();
      expect(isAuthenticationHealthy()).toBe(true);
    });
  });

  // ── askAI behaviour on auth errors ─────────────────────────

  describe('askAI on 401', () => {
    it('returns fallback immediately without retrying', async () => {
      const authErr: any = new Error('Unauthorized');
      authErr.status = 401;
      mockStream.mockRejectedValue(authErr);

      const result = await askAI('sys', 'msg');
      const parsed = JSON.parse(result);

      expect(parsed.signal).toBe('HOLD');
      expect(parsed.confidence).toBe(0);
      expect(parsed.reasoning).toContain('authentication failed');
      expect(parsed.reasoning).toContain('401');

      // Must NOT retry — stream called exactly once
      expect(mockStream).toHaveBeenCalledTimes(1);
    });

    it('sets authentication healthy to false', async () => {
      const authErr: any = new Error('Forbidden');
      authErr.status = 403;
      mockStream.mockRejectedValue(authErr);

      await askAI('sys', 'msg');
      expect(isAuthenticationHealthy()).toBe(false);
    });
  });

  describe('askAI on 403', () => {
    it('returns auth-specific fallback with 403 in reasoning', async () => {
      const authErr: any = new Error('Forbidden');
      authErr.status = 403;
      mockStream.mockRejectedValue(authErr);

      const result = await askAI('sys', 'msg');
      const parsed = JSON.parse(result);

      expect(parsed.signal).toBe('HOLD');
      expect(parsed.confidence).toBe(0);
      expect(parsed.reasoning).toContain('403');
      expect(parsed.fundamental).toContain('403');

      expect(mockStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('askAI on retryable errors (5xx) still retries', () => {
    it('retries on 500 error', async () => {
      const serverErr: any = new Error('Internal Server Error');
      serverErr.status = 500;
      mockStream.mockRejectedValue(serverErr);

      const result = await askAI('sys', 'msg');
      const parsed = JSON.parse(result);

      expect(mockStream).toHaveBeenCalledTimes(3);
      expect(parsed.signal).toBe('HOLD');
      expect(parsed.confidence).toBe(30);
    }, 20000);

    it('retries on 429 error', async () => {
      const rateErr: any = new Error('Too Many Requests');
      rateErr.status = 429;
      mockStream.mockRejectedValue(rateErr);

      const result = await askAI('sys', 'msg');
      const parsed = JSON.parse(result);

      expect(mockStream).toHaveBeenCalledTimes(3);
      expect(parsed.signal).toBe('HOLD');
    }, 20000);
  });

  describe('askAI success resets health flag', () => {
    it('sets authentication healthy to true after successful call', async () => {
      // First cause an auth failure
      const authErr: any = new Error('Forbidden');
      authErr.status = 403;
      mockStream.mockRejectedValueOnce(authErr);
      await askAI('sys', 'msg');
      expect(isAuthenticationHealthy()).toBe(false);

      // Then a successful call
      mockStream.mockResolvedValueOnce({
        finalMessage: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"signal":"BUY","confidence":80}' }],
        }),
      });
      await askAI('sys', 'msg');
      expect(isAuthenticationHealthy()).toBe(true);
    });
  });
});
