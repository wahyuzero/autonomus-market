// ============================================================
// CONFIG - Autonomous Market AI System v2.5
// Multi-TP + Trailing SL + Pyramiding + Kelly + Sessions + Correlation
// ============================================================

export const CONFIG = {
  AI: {
    BASE_URL: process.env.AI_BASE_URL || 'https://ai.semutssh.com',
    API_KEY: process.env.AI_API_KEY || '',
    MODEL_PRIMARY: 'semut/opus-4.6',
    MODEL_FALLBACK: 'semut/sonnet-4.6',
    MAX_TOKENS: 4096,
    RETRY_DELAY_MS: 2000,
    MAX_RETRIES: 3,
  },

  TRADING: {
    STARTING_BALANCE_USDT: 1000,
    LOSS_THRESHOLD_PCT: -7,
    MAX_POSITION_SIZE_PCT: 20,
    SLIPPAGE_PCT: 0.1,
    COMMISSION_PCT: 0.1,

    // Circuit breakers (Professional Risk Management)
    DAILY_LOSS_LIMIT_PCT: 3,       // Halt trading if daily loss exceeds 3%
    MAX_CONSECUTIVE_LOSSES: 4,     // Pause after 4 consecutive losses
    TIME_BASED_EXIT_HOURS: 8,      // Close position if no movement after 8 hours

    // Multi-TP Configuration (ATR multipliers)
    MULTI_TP: {
      TP1_ATR: 1.5,      // TP1 = entry + 1.5 × ATR
      TP2_ATR: 3.0,      // TP2 = entry + 3.0 × ATR
      TP3_ATR: 5.0,      // TP3 = entry + 5.0 × ATR (swing trigger)
      TP1_CLOSE_PCT: 30, // Close 30% of position at TP1
      TP2_CLOSE_PCT: 30, // Close 30% of remaining at TP2
      TP3_CLOSE_PCT: 40, // Close 40% of remaining at TP3 (40% enters swing mode)
      TRAIL_ATR: 2.0,    // Trailing SL in swing mode = highest - 2×ATR
    },

    // Pyramiding (adding positions to same pair)
    PYRAMID: {
      ENABLED: true,
      MAX_LAYERS: 3,
      MIN_CONFLUENCE_SCORE: 70,   // Minimum score to add a layer
      LAYER_SIZES_PCT: [20, 10, 5], // Each layer is smaller
    },

    // Swing mode (default)
    SWING: {
      ANALYSIS_INTERVAL_MS: 15000,
      PRIMARY_INTERVAL: '1h',
      SIGNAL_THRESHOLD: 60,
      CANDLE_INTERVALS: ['1m', '5m', '15m', '1h', '4h'],
    },

    // Scalping mode
    SCALPING: {
      TAKE_PROFIT_PCT: 0.6,
      STOP_LOSS_PCT: 0.3,
      SIGNAL_THRESHOLD: 70,
      ANALYSIS_INTERVAL_MS: 5000,
      PRIMARY_INTERVAL: '5m',
      CANDLE_INTERVALS: ['1m', '5m', '15m'],
      ICHIMOKU: { TENKAN: 5, KIJUN: 13, SENKOU_B: 26 },
    },
  },

  // ── Kelly Criterion (Dynamic Position Sizing) ─────────────
  KELLY: {
    ENABLED: true,
    KELLY_FRACTION: 0.5,       // Half-Kelly (50%) — reduces variance vs full Kelly
    MIN_TRADES_FOR_KELLY: 20,  // Need ≥20 closed trades before using Kelly
    MAX_KELLY_PCT: 15,         // Hard cap: never go above 15% even if Kelly says more
  },

  // ── Correlation Filter (Avoid double exposure) ─────────────
  CORRELATION: {
    ENABLED: true,
    // Groups of highly correlated pairs — max 2 same-direction open per group
    CORRELATED_GROUPS: [
      ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'],   // Major crypto: 80%+ correlation
      ['XRPUSDT', 'ADAUSDT', 'LTCUSDT', 'DOGEUSDT'],  // Alt crypto: follow BTC
      ['AVAXUSDT', 'LINKUSDT'],                        // Small caps
      ['EURUSD', 'GBPUSD'],                            // EUR-GBP correlated vs USD
      ['XAUUSD', 'XAGUSD'],                            // Gold-Silver tandem
    ] as string[][],
    MAX_SAME_DIRECTION_IN_GROUP: 2, // Allow max 2 pairs in same group going same direction
  },

  // ── Portfolio Heat (Total Open Risk) ──────────────────────
  PORTFOLIO_HEAT: {
    ENABLED: true,
    MAX_HEAT_PCT: 10,  // Total open risk across all pairs ≤ 10% of total equity
  },

  MODE: 'SWING' as 'SWING' | 'SCALPING',

  ANALYSIS: {
    MAX_PARALLEL_PAIRS: 20,
    CANDLE_LIMIT: 200,
  },

  DASHBOARD: {
    PORT: 3000,
    WS_BROADCAST_INTERVAL_MS: 1000,
  },

  CRYPTO_PAIRS: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  ],
  FOREX_PAIRS: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF'],
  COMMODITY_PAIRS: ['XAUUSD', 'XAGUSD', 'USOIL'],

  ACTIVE_PAIRS: [] as string[],
};

CONFIG.ACTIVE_PAIRS = [
  ...CONFIG.CRYPTO_PAIRS,
  ...CONFIG.FOREX_PAIRS,
  ...CONFIG.COMMODITY_PAIRS,
];

export type MarketType = 'crypto' | 'forex' | 'stock' | 'commodity';

export interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

export interface MarketData {
  pair: string; type: MarketType; price: number;
  change24h: number; volume24h: number;
  candles: { [interval: string]: Candle[] };
  updatedAt: number;
}

export interface AnalysisResult {
  pair: string; signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; reasoning: string;
  technical: TechnicalSummary; fundamental: string;
  entryPrice: number; targetPrice: number; stopLoss: number; timestamp: number;
}

// ============================================================
// TRADE POSITION — Extended with Multi-TP + Trailing SL
// ============================================================
export type TPPhase =
  | 'initial'      // SL at original, price not yet 50% to TP1
  | 'breakeven'    // SL moved to entry (50% to TP1 reached)
  | 'tp1_hit'      // TP1 hit, 30% closed, SL at entry+ATR/2
  | 'tp2_hit'      // TP2 hit, 30% more closed, SL at TP1
  | 'swing';       // TP3+ hit, trailing SL active, let it run

export interface TradePosition {
  id: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  initialQuantity: number;    // Original quantity when opened
  quantity: number;           // Current remaining quantity
  usdtValue: number;          // Original USDT value allocated
  currentUsdtValue: number;   // Current value of remaining quantity

  // Multi-TP targets (ATR-based)
  tp1: number;
  tp2: number;
  tp3: number;
  originalSL: number;         // Original stop loss (never changes)
  stopLoss: number;           // Current SL (moves up over time)
  tpPhase: TPPhase;

  // Swing mode
  highestClose: number;       // For trailing SL in swing mode
  atr: number;                // ATR at entry (for trailing calculations)

  // Pyramiding metadata
  pyramidLayer: number;       // 1 = first entry, 2 = add1, 3 = add2
  parentId?: string;          // For layered positions

  openTime: number;
  status: 'OPEN' | 'CLOSED';
  closePrice?: number;
  closeTime?: number;
  pnl?: number;
  pnlPct?: number;
  reason?: string;

  // Partial close log
  partialCloses: Array<{ phase: string; qty: number; price: number; pnl: number }>;

  // Legacy fields (kept for dashboard compat)
  takeProfit: number;         // = tp1 for display
}

// ============================================================
// TECHNICAL SUMMARY — Advanced (unchanged, for compat)
// ============================================================
export interface TechnicalSummary {
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rsi: number;
  macd: { line: number; signal: number; histogram: number };
  bbands: { upper: number; middle: number; lower: number; width?: number };
  ema: { ema9: number; ema21: number; ema50: number; ema200: number };
  atr: number;
  stochastic: { k: number; d: number };
  support: number; resistance: number;
  patterns: string[];
  score: number;
  vwap?: number;
  vwapBands?: { upper1: number; upper2: number; lower1: number; lower2: number };
  ichimoku?: {
    tenkan: number; kijun: number; senkouA: number; senkouB: number;
    cloudTop: number; cloudBottom: number; cloudColor: 'green' | 'red';
    priceAboveCloud: boolean; priceBelowCloud: boolean; priceInCloud: boolean;
    tkCross: 'bullish' | 'bearish' | 'none'; chikouBullish: boolean; kumoTwist: boolean;
  };
  marketStructure?: {
    type: 'uptrend' | 'downtrend' | 'ranging';
    lastBOS: 'bullish' | 'bearish' | 'none';
    lastCHoCH: 'bullish' | 'bearish' | 'none';
    signals: string[];
  };
  rsiDivergence?: {
    regularBullish: boolean; regularBearish: boolean;
    hiddenBullish: boolean; hiddenBearish: boolean;
    signals: string[];
  };
  confluence?: { total: number; breakdown: Record<string, number>; signals: string[] };

  // Smart Money Concepts
  fvgs?: Array<{
    type: 'bullish' | 'bearish';
    high: number; low: number;
    midpoint: number;
    active: boolean;         // Not yet filled
    strength: number;        // 1-3 (gap size relative to ATR)
  }>;
  orderBlocks?: Array<{
    type: 'bullish' | 'bearish';
    high: number; low: number;
    midpoint: number;
    fresh: boolean;          // Not yet retested
    strength: number;        // 1-3
  }>;

  // Low Priority — Regime + Sweep Detection
  regime?: {
    regime: 'STRONG_BULL' | 'BULL' | 'RANGING' | 'BEAR' | 'STRONG_BEAR' | 'VOLATILE';
    strength: number;
    adx: number;
    bbWidth: number;
    priceVsEma50: number;
    priceVsEma200: number;
    description: string;
    adjustments: {
      minConfidenceBonus: number;
      positionSizeMult: number;
      tpMultiplier: number;
      avoidLong: boolean;
      avoidShort: boolean;
    };
  };
  liquiditySweep?: {
    type: 'BULLISH_SWEEP' | 'BEARISH_SWEEP' | 'NONE';
    strength: number;
    sweptLevel: number;
    candleIndex: number;
    description: string;
    confluenceBonus: number;
  };
}

export interface PairState {
  pair: string;
  balance: number;
  positions: TradePosition[];
  closedTrades: TradePosition[];
  totalPnl: number;
  totalPnlPct: number;
  winRate: number;
  strategy: StrategyConfig;
  lastAnalysis?: AnalysisResult;
  currentPrice: number;
  isAnalyzing: boolean;
  correctionCount: number;
}

export interface StrategyConfig {
  name: string; tpPct: number; slPct: number;
  maxPositions: number; signalThreshold: number;
  indicators: string[]; lastUpdated: number; winRate: number; totalTrades: number;
}

export function getPairType(pair: string): MarketType {
  if (CONFIG.COMMODITY_PAIRS.includes(pair)) return 'commodity';
  if (CONFIG.FOREX_PAIRS.includes(pair)) return 'forex';
  return 'crypto';
}

export function getModeConfig() {
  return CONFIG.MODE === 'SCALPING' ? CONFIG.TRADING.SCALPING : CONFIG.TRADING.SWING;
}
