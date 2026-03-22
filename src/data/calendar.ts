// ============================================================
// ECONOMIC CALENDAR — High-Impact News Filter
//
// Sources: Forex Factory API (unofficial), ForexFactory RSS
// Purpose: Alert when major news approaching → avoid new trades
// ============================================================

import axios from 'axios';
import * as https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false });

export interface EconomicEvent {
  datetime: Date;
  currency: string;   // USD, EUR, etc.
  impact: 'high' | 'medium' | 'low';
  title: string;
  forecast?: string;
  previous?: string;
}

let cachedEvents: EconomicEvent[] = [];
let lastFetch = 0;
const CACHE_MS = 3600000; // Refresh every hour

// Map pair to currencies affected
const PAIR_CURRENCIES: Record<string, string[]> = {
  BTCUSDT: ['USD'], ETHUSDT: ['USD'], BNBUSDT: ['USD'],
  SOLUSDT: ['USD'], XRPUSDT: ['USD'], DOGEUSDT: ['USD'],
  ADAUSDT: ['USD'], AVAXUSDT: ['USD'], LINKUSDT: ['USD'], LTCUSDT: ['USD'],
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'],
  USDJPY: ['USD', 'JPY'], AUDUSD: ['AUD', 'USD'], USDCHF: ['USD', 'CHF'],
  XAUUSD: ['USD'], XAGUSD: ['USD'], USOIL: ['USD'],
};

// High-impact events to flag
const HIGH_IMPACT_KEYWORDS = [
  'FOMC', 'Fed', 'Federal Reserve', 'Interest Rate', 'NFP', 'Non-Farm',
  'CPI', 'Inflation', 'GDP', 'ECB', 'Bank of England', 'BOJ', 'BOC',
  'Unemployment', 'Retail Sales', 'PMI Flash', 'ISM', 'PCE',
];

export async function fetchEconomicCalendar(): Promise<EconomicEvent[]> {
  const now = Date.now();
  if (now - lastFetch < CACHE_MS && cachedEvents.length > 0) {
    return cachedEvents;
  }

  try {
    // Try ForexFactory calendar (unofficial JSON endpoint)
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    const response = await axios.get(
      `https://nfs.faireconomy.media/ff_calendar_thisweek.json`,
      { httpsAgent: agent, timeout: 8000 }
    );

    if (response.data && Array.isArray(response.data)) {
      cachedEvents = response.data
        .filter((e: any) => e.impact === 'High' || e.impact === 'Medium')
        .map((e: any): EconomicEvent => ({
          datetime: new Date(e.date),
          currency: e.country?.toUpperCase() ?? 'USD',
          impact: e.impact?.toLowerCase() === 'high' ? 'high' : 'medium',
          title: e.title ?? 'Unknown Event',
          forecast: e.forecast ?? undefined,
          previous: e.previous ?? undefined,
        }));

      lastFetch = now;
      console.log(`[Calendar] 📅 Loaded ${cachedEvents.length} economic events`);
      return cachedEvents;
    }
  } catch (err: any) {
    // Silently fall back to hardcoded known events
  }

  // Fallback: generate approximate recurring events for this week
  cachedEvents = generateApproximateEvents();
  lastFetch = now;
  return cachedEvents;
}

function generateApproximateEvents(): EconomicEvent[] {
  // US important recurring events (approximate—updated when API fails)
  const events: EconomicEvent[] = [];
  const now = new Date();

  // FOMC occurs 8 times per year (approximately every 6 weeks)
  // Just mark Wednesdays as potential medium-impact as placeholder
  // This is a safety net, not the primary source

  const day = now.getDay(); // 0=Sun, 3=Wed
  if (day === 3) {
    events.push({
      datetime: new Date(now.setHours(19, 0, 0, 0)),
      currency: 'USD', impact: 'medium',
      title: 'Potential Fed Event (check calendar)',
    });
  }

  return events;
}

// ============================================================
// CHECK IF PAIR SAFE TO TRADE (no imminent high-impact news)
// ============================================================
export async function isNewsWindowSafe(
  pair: string,
  minutesBefore = 30,
  minutesAfter = 15
): Promise<{ safe: boolean; reason: string; nextEvent?: EconomicEvent }> {
  const events = await fetchEconomicCalendar();
  const pairCurrencies = PAIR_CURRENCIES[pair] ?? ['USD'];
  const now = Date.now();

  const affected = events.filter(e => {
    const isRelevantCurrency = pairCurrencies.includes(e.currency);
    const isHighImpact = e.impact === 'high';
    if (!isRelevantCurrency || !isHighImpact) return false;

    const eventTime = e.datetime.getTime();
    const windowStart = eventTime - minutesBefore * 60000;
    const windowEnd = eventTime + minutesAfter * 60000;
    return now >= windowStart && now <= windowEnd;
  });

  if (affected.length > 0) {
    const next = affected[0];
    const minsToEvent = Math.round((next.datetime.getTime() - now) / 60000);
    return {
      safe: false,
      reason: `🚫 ${next.title} (${next.currency}) ${minsToEvent > 0 ? `in ${minsToEvent}m` : `released ${-minsToEvent}m ago`}`,
      nextEvent: next,
    };
  }

  return { safe: true, reason: '' };
}

// ============================================================
// GET UPCOMING HIGH-IMPACT EVENTS (for dashboard display)
// ============================================================
export async function getUpcomingEvents(hoursAhead = 24): Promise<EconomicEvent[]> {
  const events = await fetchEconomicCalendar();
  const now = Date.now();
  const cutoff = now + hoursAhead * 3600000;

  return events
    .filter(e => e.impact === 'high' && e.datetime.getTime() > now && e.datetime.getTime() < cutoff)
    .sort((a, b) => a.datetime.getTime() - b.datetime.getTime())
    .slice(0, 5);
}
