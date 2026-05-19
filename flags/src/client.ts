import type { FeatureFlagConfig, FlagEvaluationContext, EvaluatedFlags, FlagListResult, FlagLogger } from './types.js';
import {
  normalizeApiUrl,
  setRegistryValue,
  extractIdsFromRequest,
  fetchWithTimeout,
  FETCH_TIMEOUT_MS,
} from '@sessionsight/sdk-shared';

/**
 * Truncate a response body for logging. We don't want to dump 5MB of HTML
 * into a user's logger if the upstream returned an error page.
 */
async function readBodyExcerpt(res: Response, max = 500): Promise<string> {
  try {
    const text = await res.text();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}... (truncated)`;
  } catch {
    return '<unreadable body>';
  }
}

export class FeatureFlagClient {
  private apiUrl: string;
  private secretApiKey: string;
  private propertyId: string;
  private environment: string;
  private flags: EvaluatedFlags = {};
  private context: FlagEvaluationContext = {};
  private initialized = false;
  private timeoutMs: number;
  private logger: FlagLogger;

  constructor(config: FeatureFlagConfig) {
    // Heuristic: a real browser has `window` but no `process`. Bun, Node,
    // Deno, and Cloudflare Workers all have `process` (Bun shims it on the
    // global). Known limits: Electron renderer and some bundler-shimmed
    // browser builds (Vite/webpack `define: { process }`) will pass; this
    // is acceptable because the *real* protection is the secretApiKey
    // never reaching a browser bundle. Don't "simplify" this casually.
    if (typeof window !== 'undefined' && !('process' in globalThis)) {
      throw new Error('@sessionsight/flags is a server-side SDK and cannot be used in the browser.');
    }
    if (!config.secretApiKey?.trim()) throw new Error('@sessionsight/flags: secretApiKey is required.');
    if (!config.propertyId?.trim()) throw new Error('@sessionsight/flags: propertyId is required.');
    if (!config.environment?.trim()) throw new Error('@sessionsight/flags: environment is required.');
    this.secretApiKey = config.secretApiKey;
    this.propertyId = config.propertyId;
    this.environment = config.environment;
    this.apiUrl = normalizeApiUrl(config.apiUrl || '');
    this.timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : FETCH_TIMEOUT_MS;
    this.logger = config.logger ?? console;
  }

  async init(context?: FlagEvaluationContext): Promise<void> {
    if (context) this.context = context;
    await this.fetchFlags();
    this.initialized = true;
  }

  getBooleanFlag(key: string, defaultValue: boolean): boolean {
    const flag = this.flags[key];
    if (!flag || flag.type !== 'boolean') return defaultValue;
    return typeof flag.value === 'boolean' ? flag.value : defaultValue;
  }

  getStringFlag(key: string, defaultValue: string): string {
    const flag = this.flags[key];
    if (!flag || flag.type !== 'string') return defaultValue;
    return typeof flag.value === 'string' ? flag.value : defaultValue;
  }

  async refresh(context?: FlagEvaluationContext): Promise<void> {
    if (context) this.context = { ...this.context, ...context };
    await this.fetchFlags();
  }

  async getFlags(): Promise<FlagListResult> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.apiUrl}/v1/flags/list?propertyId=${encodeURIComponent(this.propertyId)}`,
        {
          method: 'GET',
          headers: { 'x-api-key': this.secretApiKey },
        },
        this.timeoutMs,
      );
    } catch (error) {
      // The shared fetchWithTimeout aborts via AbortController on timeout,
      // surfacing an AbortError. Preserve the distinctive timeout log so
      // operators can tell timeouts apart from generic network errors.
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        this.logger.warn(`[SessionSight Flags] Failed to list flags: request timed out after ${this.timeoutMs}ms`);
      } else {
        this.logger.warn('[SessionSight Flags] Failed to list flags:', error);
      }
      return { flags: [] };
    }

    if (!response.ok) {
      const body = await readBodyExcerpt(response);
      this.logger.warn(`[SessionSight Flags] HTTP ${response.status}: ${body}`);
      return { flags: [] };
    }

    try {
      const data = await response.json();
      return { flags: data.flags || [] };
    } catch (err) {
      this.logger.warn('[SessionSight Flags] Failed to parse flags list response:', err);
      return { flags: [] };
    }
  }

  /**
   * Drop all client state, including credentials. After `destroy()` the
   * instance is unusable; create a new client to resume.
   */
  destroy(): void {
    this.flags = {};
    this.context = {};
    this.initialized = false;
    this.secretApiKey = '';
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** Read-only snapshot of currently-cached flags. Used by per-request wrappers. */
  getFlagSnapshot(): EvaluatedFlags {
    return this.flags;
  }

  /**
   * Internal: evaluate flags for a one-off context without mutating the
   * shared `this.flags` map. Used by `BoundFeatureFlagClient` to cache
   * flags per-request, so concurrent requests with different visitors
   * don't see each other's evaluations.
   */
  async evaluateForContext(context: FlagEvaluationContext): Promise<EvaluatedFlags> {
    return this.fetchFlagsRaw(context);
  }

  /**
   * Return a per-request evaluator that auto-populates `visitorId` and
   * `sessionId` in the evaluation context from the request's cookies.
   * Accepts any Node/Fetch/Express-style request shape, or a raw cookie
   * header string.
   *
   *   const flags = client.forRequest(req);
   *   await flags.init({ userId: req.user.id });
   *   flags.getBooleanFlag('new-ui', false);
   *
   * The returned `BoundFeatureFlagClient` carries its OWN flag cache:
   * each `forRequest(...)` instance evaluates and stores flags in
   * isolation, so two concurrent requests with different visitor cookies
   * never see each other's values.
   */
  forRequest(req: unknown): BoundFeatureFlagClient {
    return new BoundFeatureFlagClient(this, extractIdsFromRequest(req));
  }

  private async fetchFlags(): Promise<void> {
    const flags = await this.fetchFlagsRaw(this.context);
    if (flags) this.flags = flags;
  }

  /**
   * Pure transport: POST `/v1/flags/evaluate` with the given context and
   * return the evaluated flags map (or an empty map on failure).
   * Does not touch any instance state except `apiUrl`/credentials/logger.
   */
  private async fetchFlagsRaw(context: FlagEvaluationContext): Promise<EvaluatedFlags> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${this.apiUrl}/v1/flags/evaluate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.secretApiKey,
          },
          body: JSON.stringify({
            propertyId: this.propertyId,
            environment: this.environment,
            context,
          }),
        },
        this.timeoutMs,
      );
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        this.logger.warn(`[SessionSight Flags] Failed to fetch flags: request timed out after ${this.timeoutMs}ms`);
      } else {
        this.logger.warn('[SessionSight Flags] Failed to fetch flags:', error);
      }
      return {};
    }

    if (!response.ok) {
      const body = await readBodyExcerpt(response);
      this.logger.warn(`[SessionSight Flags] HTTP ${response.status}: ${body}`);
      return {};
    }

    try {
      const data = await response.json();
      // Write opaque evaluation token to cross-SDK registry for insights SDK to pick up
      if (data.evaluationToken) {
        setRegistryValue('flagEvaluationToken', data.evaluationToken);
      }
      return data.flags || {};
    } catch (err) {
      this.logger.warn('[SessionSight Flags] Failed to parse evaluate response:', err);
      return {};
    }
  }
}

/**
 * Per-request flag evaluator. `init()` / `refresh()` merge bound `visitorId`
 * + `sessionId` (from the request's cookies) into the evaluation context so
 * segment targeting lands on the right visitor without the host plumbing it
 * through manually.
 *
 * Each `BoundFeatureFlagClient` carries its own `flags` map populated on
 * `init()`/`refresh()`. Reads (`getBooleanFlag` / `getStringFlag`) hit this
 * per-request map, so two concurrent requests with different visitor
 * cookies never see each other's values.
 *
 * `getFlags()` (flag-definition list) delegates to the underlying client
 * since definitions are property-wide and don't depend on context.
 */
export class BoundFeatureFlagClient {
  private flags: EvaluatedFlags = {};
  private initialized = false;

  constructor(
    private readonly client: FeatureFlagClient,
    private readonly bound: { visitorId: string | null; sessionId: string | null },
  ) {}

  async init(context?: FlagEvaluationContext): Promise<void> {
    this.flags = await this.client.evaluateForContext(this.merge(context));
    this.initialized = true;
  }

  async refresh(context?: FlagEvaluationContext): Promise<void> {
    this.flags = await this.client.evaluateForContext(this.merge(context));
  }

  getBooleanFlag(key: string, defaultValue: boolean): boolean {
    const flag = this.flags[key];
    if (!flag || flag.type !== 'boolean') return defaultValue;
    return typeof flag.value === 'boolean' ? flag.value : defaultValue;
  }

  getStringFlag(key: string, defaultValue: string): string {
    const flag = this.flags[key];
    if (!flag || flag.type !== 'string') return defaultValue;
    return typeof flag.value === 'string' ? flag.value : defaultValue;
  }

  getFlags(): Promise<FlagListResult> {
    return this.client.getFlags();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private merge(context?: FlagEvaluationContext): FlagEvaluationContext {
    const merged: FlagEvaluationContext = { ...(context || {}) };
    if (!merged.visitorId && this.bound.visitorId) merged.visitorId = this.bound.visitorId;
    if (!merged.sessionId && this.bound.sessionId) merged.sessionId = this.bound.sessionId;
    return merged;
  }
}
