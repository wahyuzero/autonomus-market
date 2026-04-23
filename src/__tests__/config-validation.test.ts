import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We import CONFIG and validateConfig, then override env-driven fields via vi.mock
// or by mutating CONFIG directly (since it's a mutable object).

const ORIGINAL_ENV = { ...process.env };

describe('validateConfig', () => {
  let CONFIG: typeof import('../config').CONFIG;
  let validateConfig: typeof import('../config').validateConfig;

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    const mod = await import('../config');
    CONFIG = mod.CONFIG;
    validateConfig = mod.validateConfig;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reports error when AI_API_KEY is empty', () => {
    CONFIG.AI.API_KEY = '';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'AI.API_KEY')).toBe(true);
  });

  it('reports error when AI_API_KEY is too short', () => {
    CONFIG.AI.API_KEY = 'abc';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const keyError = result.errors.find(e => e.field === 'AI.API_KEY');
    expect(keyError).toBeDefined();
    expect(keyError!.message).toContain('too short');
  });

  it('accepts a valid AI_API_KEY', () => {
    CONFIG.AI.API_KEY = 'sk-abcdefghijklmnop1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.example.com';
    CONFIG.DASHBOARD.PORT = 3000;
    const result = validateConfig();
    expect(result.errors.some(e => e.field === 'AI.API_KEY')).toBe(false);
  });

  it('reports error when AI_BASE_URL is not a valid URL', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'not-a-url';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const urlError = result.errors.find(e => e.field === 'AI.BASE_URL');
    expect(urlError).toBeDefined();
    expect(urlError!.message).toContain('not a valid URL');
  });

  it('reports error when AI_BASE_URL uses unsupported protocol', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'ftp://ai.example.com';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const urlError = result.errors.find(e => e.field === 'AI.BASE_URL');
    expect(urlError).toBeDefined();
    expect(urlError!.message).toContain('http or https');
  });

  it('accepts valid http AI_BASE_URL', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'http://localhost:8080';
    CONFIG.DASHBOARD.PORT = 3000;
    const result = validateConfig();
    expect(result.errors.some(e => e.field === 'AI.BASE_URL')).toBe(false);
  });

  it('reports error when DASHBOARD.PORT is out of range (low)', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.example.com';
    CONFIG.DASHBOARD.PORT = 0;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const portError = result.errors.find(e => e.field === 'DASHBOARD.PORT');
    expect(portError).toBeDefined();
    expect(portError!.message).toContain('1-65535');
  });

  it('reports error when DASHBOARD.PORT is out of range (high)', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.example.com';
    CONFIG.DASHBOARD.PORT = 70000;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const portError = result.errors.find(e => e.field === 'DASHBOARD.PORT');
    expect(portError).toBeDefined();
    expect(portError!.message).toContain('1-65535');
  });

  it('reports error when DASHBOARD.PORT is not an integer', () => {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.example.com';
    CONFIG.DASHBOARD.PORT = 3.5;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'DASHBOARD.PORT')).toBe(true);
  });

  it('returns valid=true with all fields correct', () => {
    CONFIG.AI.API_KEY = 'sk-abcdefghijklmnop1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.semutssh.com';
    CONFIG.DASHBOARD.PORT = 3000;
    CONFIG.DASHBOARD.HOST = '127.0.0.1';
    const result = validateConfig();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects multiple errors at once', () => {
    CONFIG.AI.API_KEY = '';
    CONFIG.AI.BASE_URL = 'bad';
    CONFIG.DASHBOARD.PORT = 99999;
    CONFIG.DASHBOARD.HOST = '127.0.0.1';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('DASHBOARD.HOST', () => {
  let CONFIG: typeof import('../config').CONFIG;
  let validateConfig: typeof import('../config').validateConfig;

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    const mod = await import('../config');
    CONFIG = mod.CONFIG;
    validateConfig = mod.validateConfig;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  function setValidDefaults() {
    CONFIG.AI.API_KEY = 'sk-valid-key-1234567890';
    CONFIG.AI.BASE_URL = 'https://ai.example.com';
    CONFIG.DASHBOARD.PORT = 3000;
  }

  it('defaults to 127.0.0.1 when DASHBOARD_HOST env is not set', () => {
    delete process.env.DASHBOARD_HOST;
    expect(CONFIG.DASHBOARD.HOST).toBe('127.0.0.1');
  });

  it('reads DASHBOARD_HOST from environment', async () => {
    process.env.DASHBOARD_HOST = '0.0.0.0';
    vi.resetModules();
    const mod = await import('../config');
    expect(mod.CONFIG.DASHBOARD.HOST).toBe('0.0.0.0');
  });

  it('accepts 127.0.0.1 as valid', () => {
    setValidDefaults();
    CONFIG.DASHBOARD.HOST = '127.0.0.1';
    const result = validateConfig();
    expect(result.errors.some(e => e.field === 'DASHBOARD.HOST')).toBe(false);
  });

  it('accepts 0.0.0.0 as valid', () => {
    setValidDefaults();
    CONFIG.DASHBOARD.HOST = '0.0.0.0';
    const result = validateConfig();
    expect(result.errors.some(e => e.field === 'DASHBOARD.HOST')).toBe(false);
  });

  it('accepts localhost as valid', () => {
    setValidDefaults();
    CONFIG.DASHBOARD.HOST = 'localhost';
    const result = validateConfig();
    expect(result.errors.some(e => e.field === 'DASHBOARD.HOST')).toBe(false);
  });

  it('reports error when HOST is empty string', () => {
    setValidDefaults();
    CONFIG.DASHBOARD.HOST = '';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    const hostError = result.errors.find(e => e.field === 'DASHBOARD.HOST');
    expect(hostError).toBeDefined();
    expect(hostError!.message).toContain('non-empty');
  });

  it('reports error when HOST is whitespace-only', () => {
    setValidDefaults();
    CONFIG.DASHBOARD.HOST = '   ';
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'DASHBOARD.HOST')).toBe(true);
  });

  it('accepts valid startup readiness defaults', () => {
    setValidDefaults();
    const result = validateConfig();
    expect(result.errors.some(e => e.field.startsWith('STARTUP.'))).toBe(false);
  });

  it('rejects negative startup readiness timeout', () => {
    setValidDefaults();
    CONFIG.STARTUP.READINESS_TIMEOUT_MS = -1;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'STARTUP.READINESS_TIMEOUT_MS')).toBe(true);
  });

  it('rejects invalid startup readiness mode', () => {
    setValidDefaults();
    CONFIG.STARTUP.READINESS_MODE = 'broken' as any;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'STARTUP.READINESS_MODE')).toBe(true);
  });

  it('rejects invalid startup readiness failure policy', () => {
    setValidDefaults();
    CONFIG.STARTUP.READINESS_FAILURE_POLICY = 'broken' as any;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'STARTUP.READINESS_FAILURE_POLICY')).toBe(true);
  });

  it('accepts valid per-market readiness requirements', () => {
    setValidDefaults();
    CONFIG.STARTUP.READINESS_REQUIREMENTS.crypto = 'LIVE';
    CONFIG.STARTUP.READINESS_REQUIREMENTS.forex = 'DEGRADED';
    CONFIG.STARTUP.READINESS_REQUIREMENTS.commodity = 'SIMULATION';
    const result = validateConfig();
    expect(result.errors.some(e => e.field.startsWith('STARTUP.READINESS_REQUIREMENTS.'))).toBe(false);
  });

  it('rejects invalid per-market readiness requirement', () => {
    setValidDefaults();
    CONFIG.STARTUP.READINESS_REQUIREMENTS.crypto = 'BROKEN' as any;
    const result = validateConfig();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'STARTUP.READINESS_REQUIREMENTS.crypto')).toBe(true);
  });
});
