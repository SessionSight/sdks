import type { GoalsConfig, IncrementOptions, GoalOptions, GoalResult } from './types.js';
import {
  normalizeApiUrl,
  validateGoalId,
  validateGoalAmount,
  buildGoalPayload,
  extractIdsFromRequest,
  fetchWithTimeout,
} from '@sessionsight/sdk-shared';

export class GoalsClient {
  private apiUrl: string;
  private secretApiKey: string;
  private propertyId: string;
  private debug: boolean;

  constructor(config: GoalsConfig) {
    // Server-side only. We sniff for `window` plus the absence of `process`
    // because Bun browser builds shim `process` and Electron's renderer
    // exposes both, so neither check alone is reliable. Cosmetic guard;
    // the real constraint is the secret API key, which must never reach
    // a browser regardless of runtime detection.
    if (typeof window !== 'undefined' && !('process' in globalThis)) {
      throw new Error('@sessionsight/goals is a server-side SDK and cannot be used in the browser.');
    }
    if (!config.secretApiKey?.trim()) throw new Error('@sessionsight/goals: secretApiKey is required.');
    if (!config.propertyId?.trim()) throw new Error('@sessionsight/goals: propertyId is required.');
    this.secretApiKey = config.secretApiKey;
    this.propertyId = config.propertyId;
    this.apiUrl = normalizeApiUrl(config.apiUrl || '');
    this.debug = config.debug === true;
  }

  async increment(goalId: string, options?: IncrementOptions): Promise<GoalResult> {
    const idErr = validateGoalId(goalId);
    if (idErr) return { success: false, error: idErr };

    const amtErr = validateGoalAmount(options?.amount ?? 1);
    if (amtErr) return { success: false, error: amtErr };

    if (!options?.sessionId?.trim()) {
      return { success: false, error: 'sessionId is required (goals are session-scoped; thread sessionId through from the originating user action, e.g. Stripe metadata at checkout)' };
    }

    const { body } = buildGoalPayload(goalId, this.propertyId, options);
    return this.send('/v1/goals/increment', body);
  }

  async decrement(goalId: string, options?: GoalOptions): Promise<GoalResult> {
    const idErr = validateGoalId(goalId);
    if (idErr) return { success: false, error: idErr };

    const amtErr = validateGoalAmount(options?.amount ?? 1);
    if (amtErr) return { success: false, error: amtErr };

    if (!options?.sessionId?.trim()) {
      return { success: false, error: 'sessionId is required (goals are session-scoped)' };
    }

    const { body } = buildGoalPayload(goalId, this.propertyId, options);
    return this.send('/v1/goals/decrement', body);
  }

  private async send(path: string, body: Record<string, any>): Promise<GoalResult> {
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.secretApiKey,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Server returns `{ error: { code, message } }` (see
        // apps/api/src/utils/handleError.ts). Surface the message so
        // `error: string` actually carries a string.
        const errObj = (data as any)?.error;
        const message =
          (errObj && typeof errObj === 'object' ? (errObj.message ?? errObj.code) : errObj) ||
          `HTTP ${res.status}`;
        return { success: false, error: String(message) };
      }

      return { success: true };
    } catch (err) {
      let message: string;
      if (err instanceof Error) {
        // The shared fetchWithTimeout aborts after its default timeout;
        // surface a distinctive message so callers can tell timeouts apart
        // from generic network errors.
        message = err.name === 'AbortError' ? 'request timed out after 10s' : err.message;
      } else {
        message = 'Unknown error';
      }
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.warn('[SessionSight Goals] Request failed:', message);
      }
      return { success: false, error: message };
    }
  }

  destroy(): void {}

  /**
   * Bind this client to an inbound HTTP request so subsequent calls pick up
   * `ss_sid` (sessionId) from the request's cookies automatically. Works
   * across Node-style (`req.headers.cookie`), Fetch-style
   * (`req.headers.get('cookie')`), pre-parsed maps (`req.cookies`), or a raw
   * cookie header string.
   *
   *   app.post('/signup', (req, res) => {
   *     goals.forRequest(req).increment('signup');
   *   });
   */
  forRequest(req: unknown): BoundGoalsClient {
    const { sessionId } = extractIdsFromRequest(req);
    return new BoundGoalsClient(this, { sessionId });
  }
}

/**
 * Thin wrapper that auto-merges a bound `sessionId` into each method call.
 * Explicit `options.sessionId` passed by the caller wins over the bound
 * value, so you can still override when needed.
 */
export class BoundGoalsClient {
  constructor(
    private readonly client: GoalsClient,
    private readonly bound: { sessionId: string | null },
  ) {}

  increment(goalId: string, options?: IncrementOptions): Promise<GoalResult> {
    return this.client.increment(goalId, this.merge(options));
  }

  decrement(goalId: string, options?: GoalOptions): Promise<GoalResult> {
    return this.client.decrement(goalId, this.merge(options));
  }

  private merge<T extends GoalOptions>(options?: T): T {
    const merged = { ...(options || {}) } as T;
    if (!merged.sessionId && this.bound.sessionId) merged.sessionId = this.bound.sessionId;
    return merged;
  }
}
