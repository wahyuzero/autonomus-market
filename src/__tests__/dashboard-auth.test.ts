import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('dashboardAuth middleware', () => {
  let dashboardAuth: typeof import('../dashboard/server').dashboardAuth;
  let originalAuthToken: string;

  beforeEach(async () => {
    const config = await import('../config');
    originalAuthToken = config.CONFIG.DASHBOARD.AUTH_TOKEN;
    const mod = await import('../dashboard/server');
    dashboardAuth = mod.dashboardAuth;
  });

  afterEach(async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = originalAuthToken;
  });

  function mockRes() {
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) { res.statusCode = code; return res; },
      json(data: any) { res.body = data; return res; },
    };
    return res;
  }

  it('passes through when AUTH_TOKEN is empty', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = '';

    const req: any = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('rejects request with no credentials when token is set', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('accepts valid Bearer token in Authorization header', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: { authorization: 'Bearer secret123' }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('accepts valid token via query parameter', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: {}, query: { token: 'secret123' } };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('rejects wrong Bearer token', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: { authorization: 'Bearer wrongtoken' }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects wrong query token', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: {}, query: { token: 'wrongtoken' } };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('ignores non-string query token', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: {}, query: { token: ['secret123'] } };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('ignores Authorization header without Bearer prefix', async () => {
    const config = await import('../config');
    config.CONFIG.DASHBOARD.AUTH_TOKEN = 'secret123';

    const req: any = { headers: { authorization: 'secret123' }, query: {} };
    const res = mockRes();
    const next = vi.fn();

    dashboardAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

import { afterEach } from 'vitest';
