// ============================================================
// MARKET SESSIONS — Kill Zones & Session Analysis  
//
// Professional traders focus on HIGH-PROBABILITY time windows:
//
//  ┌─ ASIAN SESSION ─────────────────────────────────────────┐
//  │ 00:00-08:00 UTC (08:00-16:00 WIB+8)                    │
//  │ Characteristics: Range-bound, low volatility            │
//  │ Best for: Gold, JPY pairs                               │
//  └─────────────────────────────────────────────────────────┘
//
//  ┌─ LONDON SESSION ────────────────────────────────────────┐
//  │ 07:00-16:00 UTC (15:00-00:00 WIB+8)                    │
//  │ Kill Zone: 07:00-10:00 UTC (London Open)               │
//  │ Characteristics: High breakout probability, trending    │
//  │ Best for: EUR, GBP, Gold, Oil                          │
//  └─────────────────────────────────────────────────────────┘
//
//  ┌─ NEW YORK SESSION ──────────────────────────────────────┐
//  │ 12:00-21:00 UTC (20:00-05:00 WIB+8)                    │
//  │ Kill Zone: 12:00-15:00 UTC (NY Open, London-NY overlap) │
//  │ Characteristics: Highest volume, major reversals       │
//  │ Best for: USD pairs, Crypto (correlated to US markets)  │
//  └─────────────────────────────────────────────────────────┘
//
// KILL ZONES: Highest institutional activity windows
// Use to PREFER entries during these periods (higher probability)
// ============================================================

export type Session = 'asian' | 'london' | 'london_kill_zone' | 'ny' | 'ny_kill_zone' | 'dead_zone';

export interface SessionInfo {
  current: Session;
  quality: 'excellent' | 'good' | 'low' | 'dead';
  isKillZone: boolean;
  sessionName: string;
  description: string;
  bestPairs: string[];
  multiplier: number;  // Score multiplier: 1.3 = 30% confidence boost required
}

// ============================================================
// PAIR → SESSION AFFINITY
// ============================================================
const PAIR_SESSION_AFFINITY: Record<string, Session[]> = {
  // Forex  
  EURUSD: ['london_kill_zone', 'london', 'ny'],
  GBPUSD: ['london_kill_zone', 'london', 'ny'],
  USDJPY: ['asian', 'ny'],
  AUDUSD: ['asian', 'london'],
  USDCHF: ['london', 'ny'],
  // Commodities
  XAUUSD: ['london_kill_zone', 'ny_kill_zone'],
  XAGUSD: ['london_kill_zone', 'ny_kill_zone'],
  USOIL:  ['london', 'ny'],
  // Crypto (not session-dependent, but boosted during NY)
  BTCUSDT: ['ny', 'ny_kill_zone', 'london'],
  ETHUSDT: ['ny', 'ny_kill_zone', 'london'],
  BNBUSDT: ['ny', 'london'],
  SOLUSDT: ['ny', 'london'],
  XRPUSDT: ['ny', 'london'],
  DOGEUSDT: ['ny'],
  ADAUSDT: ['ny'],
  AVAXUSDT: ['ny'],
  LINKUSDT: ['ny'],
  LTCUSDT: ['ny'],
};

// ============================================================
// GET CURRENT SESSION (based on UTC time)
// ============================================================
export function getCurrentSession(): Session {
  const nowUTC = new Date();
  const h = nowUTC.getUTCHours();
  const m = nowUTC.getUTCMinutes();
  const timeDecimal = h + m / 60;

  // London Kill Zone: 07:00-10:00 UTC
  if (timeDecimal >= 7 && timeDecimal < 10) return 'london_kill_zone';
  // NY Kill Zone: 12:00-15:00 UTC (overlaps with London)
  if (timeDecimal >= 12 && timeDecimal < 15) return 'ny_kill_zone';
  // London Session: 07:00-16:00 UTC
  if (timeDecimal >= 7 && timeDecimal < 16) return 'london';
  // NY Session: 12:00-21:00 UTC
  if (timeDecimal >= 12 && timeDecimal < 21) return 'ny';
  // Asian Session: 00:00-07:00 UTC and 21:00-24:00 UTC
  if (timeDecimal >= 21 || timeDecimal < 7) return 'asian';
  
  return 'dead_zone';
}

// ============================================================
// GET FULL SESSION ANALYSIS
// ============================================================
export function getSessionInfo(pair?: string): SessionInfo {
  const session = getCurrentSession();
  const nowUTC = new Date();
  const h = nowUTC.getUTCHours();

  const SESSION_MAP: Record<Session, Omit<SessionInfo, 'isKillZone'>> = {
    london_kill_zone: {
      current: 'london_kill_zone',
      quality: 'excellent',
      sessionName: '🏛️ London Kill Zone (07:00-10:00 UTC)',
      description: 'Highest institutional activity. Banks open, major moves. Best for Forex & Gold.',
      bestPairs: ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD'],
      multiplier: 1.0, // No extra requirement — best time
    },
    ny_kill_zone: {
      current: 'ny_kill_zone',
      quality: 'excellent',
      sessionName: '🗽 New York Kill Zone (12:00-15:00 UTC)',
      description: 'London-NY overlap. Maximum liquidity. Major reversals and continuations.',
      bestPairs: ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSDT', 'ETHUSDT'],
      multiplier: 1.0, // Best time
    },
    london: {
      current: 'london',
      quality: 'good',
      sessionName: '🇬🇧 London Session (07:00-16:00 UTC)',
      description: 'High activity European session. Good for trending moves.',
      bestPairs: ['EURUSD', 'GBPUSD', 'XAUUSD', 'USOIL'],
      multiplier: 1.0,
    },
    ny: {
      current: 'ny',
      quality: 'good',
      sessionName: '🇺🇸 New York Session (12:00-21:00 UTC)',
      description: 'US market hours. Crypto correlated with stock market.',
      bestPairs: ['BTCUSDT', 'ETHUSDT', 'USDJPY', 'USDCHF'],
      multiplier: 1.0,
    },
    asian: {
      current: 'asian',
      quality: 'low',
      sessionName: '🌏 Asian Session (21:00-07:00 UTC)',
      description: 'Range-bound, low volatility. More false signals for Forex.',
      bestPairs: ['USDJPY', 'AUDUSD', 'XAUUSD'],
      multiplier: 1.15, // Require 15% higher confidence in Asian session
    },
    dead_zone: {
      current: 'dead_zone',
      quality: 'dead',
      sessionName: '💤 Dead Zone',
      description: 'Very low liquidity. Avoid new positions.',
      bestPairs: [],
      multiplier: 1.3, // Require 30% higher confidence
    },
  };

  const info = SESSION_MAP[session];
  const isKillZone = session === 'london_kill_zone' || session === 'ny_kill_zone';

  return { ...info, isKillZone };
}

// ============================================================
// CHECK IF PAIR IS IN FAVORABLE SESSION
// ============================================================
export function isPairInFavorableSession(pair: string): {
  favorable: boolean;
  session: SessionInfo;
  minConfidenceBonus: number; // Extra confidence required if not in session
} {
  const session = getSessionInfo(pair);
  const pairAffinity = PAIR_SESSION_AFFINITY[pair] ?? ['ny', 'london'];
  const currentSession = session.current;
  const favorable = pairAffinity.includes(currentSession);

  return {
    favorable,
    session,
    // If not in favorable session, require higher confidence
    minConfidenceBonus: favorable ? 0 : Math.floor((session.multiplier - 1) * 100),
  };
}

// ============================================================
// SESSION LOGGER (for startup and cycle logs)
// ============================================================
export function logCurrentSession(): void {
  const info = getSessionInfo();
  const quality = { excellent: '🔥', good: '✅', low: '⚠️', dead: '💤' }[info.quality];
  console.log(`[Sessions] ${quality} ${info.sessionName} | ${info.description}`);
}
