import type { FeatureFlagConfig, FlagEvaluationContext, EvaluatedFlags, FlagListResult } from './types.js';
import { normalizeApiUrl, setRegistryValue, extractIdsFromRequest } from '@sessionsight/sdk-shared';

const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class FeatureFlagClient {
  private apiUrl: string;
  private secretApiKey: string;
  private propertyId: string;
  private environment: string;
  private flags: EvaluatedFlags = {};
  private context: FlagEvaluationContext = {};
  private initialized = false;

  constructor(config: FeatureFlagConfig) {
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
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/v1/flags/list?propertyId=${encodeURIComponent(this.propertyId)}`, {
        method: 'GET',
        headers: { 'x-api-key': this.secretApiKey },
      });

      if (!res.ok) {
        console.warn(`[SessionSight Flags] Failed to list flags: ${res.status}`);
        return { flags: [] };
      }

      const data = await res.json();
      return { flags: data.flags || [] };
    } catch (err) {
      console.warn('[SessionSight Flags] Failed to list flags:', err);
      return { flags: [] };
    }
  }

  destroy(): void {
    this.flags = {};
    this.context = {};
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
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
   */
  forRequest(req: unknown): BoundFeatureFlagClient {
    return new BoundFeatureFlagClient(this, extractIdsFromRequest(req));
  }

  private async fetchFlags(): Promise<void> {
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/v1/flags/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.secretApiKey,
        },
        body: JSON.stringify({
          propertyId: this.propertyId,
          environment: this.environment,
          context: this.context,
        }),
      });

      if (!res.ok) {
        console.warn(`[SessionSight Flags] Failed to fetch flags: ${res.status}`);
        return;
      }

      const data = await res.json();
      this.flags = data.flags || {};

      // Write opaque evaluation token to cross-SDK registry for insights SDK to pick up
      if (data.evaluationToken) {
        setRegistryValue('flagEvaluationToken', data.evaluationToken);
      }
    } catch (err) {
      console.warn('[SessionSight Flags] Failed to fetch flags:', err);
    }
  }
}

/**
 * Per-request flag evaluator. `init()` / `refresh()` merge bound `visitorId`
 * + `sessionId` (from the request's cookies) into the evaluation context so
 * segment targeting lands on the right visitor without the host plumbing it
 * through manually.
 *
 * Reads (`getBooleanFlag` / `getStringFlag` / `getFlags`) delegate to the
 * underlying client, since flag *values* are the same across requests once
 * fetched. Context only affects which values are fetched.
 *
 * Note: the underlying `FeatureFlagClient` holds a single shared flag cache.
 * If you need per-request evaluation (different flag values per visitor),
 * call `forRequest(req).refresh()` before reading — or instantiate a
 * per-request `FeatureFlagClient`.
 */
export class BoundFeatureFlagClient {
  constructor(
    private readonly client: FeatureFlagClient,
    private readonly bound: { visitorId: string | null; sessionId: string | null },
  ) {}

  async init(context?: FlagEvaluationContext): Promise<void> {
    return this.client.init(this.merge(context));
  }

  async refresh(context?: FlagEvaluationContext): Promise<void> {
    return this.client.refresh(this.merge(context));
  }

  getBooleanFlag(key: string, defaultValue: boolean): boolean {
    return this.client.getBooleanFlag(key, defaultValue);
  }

  getStringFlag(key: string, defaultValue: string): string {
    return this.client.getStringFlag(key, defaultValue);
  }

  getFlags(): Promise<FlagListResult> {
    return this.client.getFlags();
  }

  isInitialized(): boolean {
    return this.client.isInitialized();
  }

  private merge(context?: FlagEvaluationContext): FlagEvaluationContext {
    const merged: FlagEvaluationContext = { ...(context || {}) };
    if (!merged.visitorId && this.bound.visitorId) merged.visitorId = this.bound.visitorId;
    if (!merged.sessionId && this.bound.sessionId) merged.sessionId = this.bound.sessionId;
    return merged;
  }
}
