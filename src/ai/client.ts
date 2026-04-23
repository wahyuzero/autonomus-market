// ============================================================
// AI CLIENT - SemutSSH API via Anthropic SDK (Streaming Mode)
// SemutSSH gateway returns SSE streaming — must use stream mode
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG } from '../config';

let requestCount = 0;
let lastRequestTime = 0;

// ── Authentication health tracking ───────────────────────────
let _authenticationHealthy = true;

/** Returns true if the last AI request succeeded (or no auth failure has been seen). */
export function isAuthenticationHealthy(): boolean {
  return _authenticationHealthy;
}

/** Reset auth health to healthy — useful after key rotation or admin intervention. */
export function resetAuthenticationHealth(): void {
  _authenticationHealthy = true;
}

/** Check whether an HTTP status code represents an auth failure (401/403). */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export const aiClient = new Anthropic({
  apiKey: CONFIG.AI.API_KEY,
  baseURL: CONFIG.AI.BASE_URL,
});

export async function askAI(
  systemPrompt: string,
  userMessage: string,
  model: string = CONFIG.AI.MODEL_PRIMARY,
  maxTokens: number = CONFIG.AI.MAX_TOKENS
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CONFIG.AI.MAX_RETRIES; attempt++) {
    // Rate limiting
    const now = Date.now();
    if (now - lastRequestTime < 300) {
      await sleep(300 - (now - lastRequestTime));
    }
    lastRequestTime = Date.now();
    requestCount++;

    try {
      // Use streaming mode — required by SemutSSH gateway
      const stream = await aiClient.messages.stream({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      // Collect full streamed response
      const finalMessage = await stream.finalMessage();
      const text = finalMessage.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text)
        .join('');

      _authenticationHealthy = true;
      return text || fallbackResponse();

    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? err?.response?.status ?? 0;

      // ── Auth failures: stop retrying immediately ──────────
      if (isAuthFailureStatus(status)) {
        _authenticationHealthy = false;
        console.error(
          `[AI] Authentication failure ${status} — not retrying. ` +
          `Check AI_API_KEY / credentials.`
        );
        return fallbackAuthResponse(status);
      }

      if (status === 429 || status >= 500) {
        const delay = CONFIG.AI.RETRY_DELAY_MS * attempt;
        console.error(`[AI] Server error ${status} (attempt ${attempt}), retrying in ${delay}ms...`);
        await sleep(delay);
        if (attempt === 2) model = CONFIG.AI.MODEL_FALLBACK;
        continue;
      }

      // Network / parse errors — try fallback model
      if (attempt < CONFIG.AI.MAX_RETRIES) {
        console.warn(`[AI] Error (attempt ${attempt}): ${err.message?.slice(0, 80)}`);
        await sleep(CONFIG.AI.RETRY_DELAY_MS);
        model = CONFIG.AI.MODEL_FALLBACK;
        continue;
      }

      console.warn(`[AI] All attempts failed: ${err.message?.slice(0, 80)}`);
      return fallbackResponse();
    }
  }

  return fallbackResponse();
}

function fallbackResponse(): string {
  return JSON.stringify({
    signal: 'HOLD',
    confidence: 30,
    reasoning: 'AI temporarily unavailable. Holding position conservatively.',
    entryPrice: 0,
    targetPrice: 0,
    stopLoss: 0,
    fundamental: 'Data unavailable',
  });
}

/** Fallback specifically for auth failures — makes the cause visible to callers. */
function fallbackAuthResponse(status: number): string {
  return JSON.stringify({
    signal: 'HOLD',
    confidence: 0,
    reasoning: `AI authentication failed (${status}). Holding position — check API credentials.`,
    entryPrice: 0,
    targetPrice: 0,
    stopLoss: 0,
    fundamental: `Auth error ${status}`,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRequestCount() {
  return requestCount;
}
