import type {
  SplitTestConfig,
  SplitTestConfigResponse,
  SplitTestConfigEntry,
  Assignment,
  AssignedVariation,
  GetOptions,
} from './types.js';
import { splitTestHash, assignVariation } from './hash.js';
import {
  getOrCreateVisitorId,
  getCachedConfig,
  setCachedConfig,
  getCachedAssignments,
  setCachedAssignments,
  clearCache,
} from './cache.js';
import { readSessionCookie, extractIdsFromRequest } from '@sessionsight/sdk-shared';

const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

import { normalizeApiUrl } from '@sessionsight/sdk-shared';

const DEFAULT_STALE_TTL = 0;
const DEFAULT_MAX_AGE = 86_400_000; // 24 hours

export class SplitTestingClient {
  private apiUrl: string;
  private publicApiKey: string;
  private propertyId: string;
  private visitorId: string;
  private attributes: Record<string, string | number | boolean>;
  private bootstrap: Record<string, number> | null;
  private antiFlicker: boolean;
  private staleTTL: number;
  private maxAge: number;
  private onAssignment: ((testKey: string, variation: AssignedVariation) => void) | null;

  private config: SplitTestConfigResponse | null = null;
  private assignments: Record<string, Assignment> = {};
  private initialized = false;
  private antiFlickerStyle: HTMLStyleElement | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingExposures: Array<{
    splitTestKey: string;
    variationKey: string;
    sessionId: string;
    timestamp: number;
    attributes: Record<string, string | number | boolean>;
  }> = [];

  constructor(config: SplitTestConfig) {
    this.publicApiKey = config.publicApiKey;
    this.propertyId = config.propertyId;
    this.apiUrl = normalizeApiUrl(config.apiUrl || '');
    this.visitorId = getOrCreateVisitorId(config.visitorId);
    this.attributes = config.attributes || {};
    this.bootstrap = config.bootstrap || null;
    this.antiFlicker = config.antiFlicker || false;
    this.staleTTL = config.staleTTL ?? DEFAULT_STALE_TTL;
    this.maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
    this.onAssignment = config.onAssignment || null;
  }

  async init(): Promise<void> {
    // Step 1: Anti-flicker
    if (this.antiFlicker && typeof document !== 'undefined') {
      this.injectAntiFlicker();
    }

    try {
      // Step 2: Bootstrap (highest priority, zero-flicker)
      if (this.bootstrap) {
        // We still need config to know the test metadata (type, variations)
        // Try cache first, then fetch
        const cached = getCachedConfig(this.propertyId);
        if (cached) {
          this.config = cached.data;
          this.evaluateFromBootstrap();
          this.initialized = true;
          // Refresh in background
          this.fetchConfigInBackground();
          return;
        }
        // Must fetch to know test structure
        await this.fetchConfig();
        this.evaluateFromBootstrap();
        this.initialized = true;
        return;
      }

      // Step 3: Try cached assignments
      const cachedAssignments = getCachedAssignments(this.propertyId, this.visitorId);
      if (cachedAssignments) {
        this.assignments = cachedAssignments;
      }

      // Step 4: Check cached config
      const cachedConfig = getCachedConfig(this.propertyId);
      const now = Date.now();

      if (cachedConfig) {
        const age = now - cachedConfig.fetchedAt;

        if (age < this.maxAge) {
          this.config = cachedConfig.data;

          // Re-evaluate assignments from cached config (to ensure consistency)
          this.evaluateAssignments();
          this.initialized = true;

          // If stale, fetch in background
          if (age >= this.staleTTL) {
            this.fetchConfigInBackground();
          }
          return;
        }
      }

      // Step 5: No usable cache. Fetch fresh.
      await this.fetchConfig();
      this.evaluateAssignments();
      this.initialized = true;
    } finally {
      this.removeAntiFlicker();
    }
  }

  get(testKey: string, defaultValue: any, _options?: GetOptions): any {
    if (!this.initialized) {
      console.warn('[SessionSight SplitTesting] Not initialized. Call init() first.');
      return defaultValue;
    }

    // No-session state (consent withdrawn / not yet granted): fall back
    // to the control path. The SDK has no session to key an exposure
    // record to; surfacing the variant UI now would write no audit row
    // and desync what the user saw from what the dashboard reports.
    // Runs on every get() because the cookie can disappear at any time
    // (explicit setConsent(false) on the Insights SDK clears ss_sid).
    if (typeof document !== 'undefined' && !readSessionCookie()) {
      return defaultValue;
    }

    const assignment = this.assignments[testKey];
    if (!assignment) return defaultValue;

    // Track exposure (fire-and-forget)
    if (assignment.inTest) {
      this.trackExposure(testKey, assignment.variationKey);
    }

    switch (assignment.type) {
      case 'id':
        return assignment.variationKey;
      case 'text':
        return assignment.value || defaultValue;
      case 'json':
        try {
          return JSON.parse(assignment.value);
        } catch {
          return defaultValue;
        }
      default:
        return defaultValue;
    }
  }

  setAttributes(attrs: Record<string, string | number | boolean>): void {
    Object.assign(this.attributes, attrs);
  }

  getAssignments(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, assignment] of Object.entries(this.assignments)) {
      result[key] = assignment.variationIndex;
    }
    return result;
  }

  async refresh(): Promise<void> {
    await this.fetchConfig();
    this.evaluateAssignments();
  }

  clearCache(): void {
    clearCache(this.propertyId);
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushExposures();
    this.removeAntiFlicker();
    this.config = null;
    this.assignments = {};
    this.initialized = false;
    this.pendingExposures = [];
  }

  // ── Private ─────────────────────────────────────────────────────

  private evaluateFromBootstrap(): void {
    if (!this.config || !this.bootstrap) return;

    for (const test of this.config.tests) {
      const variationIndex = this.bootstrap[test.key];
      if (variationIndex === undefined) continue;

      const variation = test.variations[variationIndex];
      if (!variation) continue;

      this.assignments[test.key] = {
        testKey: test.key,
        variationIndex,
        variationKey: variation.key,
        value: variation.value,
        type: test.type,
        inTest: true,
      };

      if (this.onAssignment) {
        this.onAssignment(test.key, { key: variation.key, value: variation.value });
      }
    }

    setCachedAssignments(this.propertyId, this.visitorId, this.assignments);
  }

  private evaluateAssignments(): void {
    if (!this.config) return;

    for (const test of this.config.tests) {
      const hash = splitTestHash(test.hashSeed, this.visitorId);
      const result = assignVariation(hash, test.trafficAllocation, test.variations);
      const variation = test.variations[result.variationIndex];

      if (!variation) continue;

      this.assignments[test.key] = {
        testKey: test.key,
        variationIndex: result.variationIndex,
        variationKey: variation.key,
        value: variation.value,
        type: test.type,
        inTest: result.inTest,
      };

      if (this.onAssignment) {
        this.onAssignment(test.key, { key: variation.key, value: variation.value });
      }
    }

    setCachedAssignments(this.propertyId, this.visitorId, this.assignments);
  }

  private async fetchConfig(): Promise<void> {
    try {
      const url = `${this.apiUrl}/v1/split-testing/config?propertyId=${encodeURIComponent(this.propertyId)}`;
      const res = await fetchWithTimeout(url, {
        headers: { 'x-api-key': this.publicApiKey },
      });

      if (!res.ok) {
        console.warn(`[SessionSight SplitTesting] Failed to fetch config: ${res.status}`);
        return;
      }

      const data = await res.json();
      if (!data || !Array.isArray(data.tests)) {
        console.warn('[SessionSight SplitTesting] Invalid config response');
        return;
      }
      this.config = data as SplitTestConfigResponse;
      setCachedConfig(this.propertyId, data);
    } catch (err) {
      console.warn('[SessionSight SplitTesting] Failed to fetch config:', err);
    }
  }

  private fetchConfigInBackground(): void {
    this.fetchConfig().then(() => {
      if (this.config) {
        this.evaluateAssignments();
      }
    });
  }

  private trackExposure(testKey: string, variationKey: string): void {
    // Deduplicate: only track once per test per session
    if (this.pendingExposures.some((e) => e.splitTestKey === testKey)) return;

    // Pull sessionId from the ss_sid cookie. In the no-session state
    // (consent withdrawn / not yet granted) there is no session to key
    // the exposure to, so skip. The SDK still evaluated an allocation,
    // which the integrator's code can apply, but the backend audit
    // record is only written when the user consented.
    const sessionId = readSessionCookie();
    if (!sessionId) return;

    this.pendingExposures.push({
      splitTestKey: testKey,
      variationKey,
      sessionId,
      timestamp: Date.now(),
      attributes: this.attributes,
    });

    // Flush after a short delay to batch exposures
    if (this.pendingExposures.length === 1) {
      this.flushTimer = setTimeout(() => this.flushExposures(), 1000);
    }
  }

  private flushExposures(): void {
    if (this.pendingExposures.length === 0) return;

    const exposures = [...this.pendingExposures];
    this.pendingExposures = [];

    const body: Record<string, any> = {
      propertyId: this.propertyId,
      exposures,
    };

    this.sendBeacon(`${this.apiUrl}/v1/split-testing/expose`, body);
  }

  private sendBeacon(url: string, body: any): void {
    const json = JSON.stringify(body);

    // Try sendBeacon first (works during page unload)
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([json], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }

    // Fallback to fetch with keepalive
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.publicApiKey,
      },
      body: json,
      keepalive: true,
    }).catch(() => {
      // Fire-and-forget
    });
  }

  private injectAntiFlicker(): void {
    if (typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.id = 'ss-split-anti-flicker';
    style.textContent = '[data-ss-split]{visibility:hidden!important}';
    document.head.appendChild(style);
    this.antiFlickerStyle = style;
  }

  private removeAntiFlicker(): void {
    if (this.antiFlickerStyle) {
      this.antiFlickerStyle.remove();
      this.antiFlickerStyle = null;
    }
  }

  /**
   * Bind this client to an inbound HTTP request (SSR / Node path). Returns
   * a wrapper whose exposure flushes use the request's `ss_sid` cookie.
   * Accepts Node-style, Fetch-style, pre-parsed cookie maps, or a raw
   * cookie header string. In the browser this is unnecessary — ss_sid is
   * read fresh from `document.cookie` on each flush automatically.
   */
  forRequest(req: unknown): BoundSplitTestingClient {
    const { sessionId } = extractIdsFromRequest(req);
    return new BoundSplitTestingClient(this, { sessionId });
  }

  /** @internal Used by BoundSplitTestingClient to flush with a bound sessionId. */
  _flushWithBoundIds(ids: { sessionId: string | null }): void {
    if (this.pendingExposures.length === 0) return;
    const exposures = [...this.pendingExposures];
    this.pendingExposures = [];
    // The bound sessionId (from the inbound request) overrides whatever
    // was captured at track time. No session → skip the flush; there's
    // no audit record we can write coherently.
    if (!ids.sessionId) return;
    const body: Record<string, any> = {
      propertyId: this.propertyId,
      exposures: exposures.map(e => ({ ...e, sessionId: ids.sessionId as string })),
    };
    this.sendBeacon(`${this.apiUrl}/v1/split-testing/expose`, body);
  }
}

/**
 * Server-side wrapper that injects a bound `sessionId` from the inbound
 * request into exposure payloads. Read-only APIs delegate to the
 * underlying client.
 */
export class BoundSplitTestingClient {
  constructor(
    private readonly client: SplitTestingClient,
    private readonly bound: { sessionId: string | null },
  ) {}

  async init(): Promise<void> { return this.client.init(); }
  get<T extends string | boolean | number | object>(testKey: string, defaultValue: T, options?: GetOptions): T {
    return this.client.get(testKey, defaultValue, options);
  }
  destroy(): void { this.client.destroy(); }

  /** Force-flush pending exposures with bound request ids attached. */
  flush(): void { (this.client as any)._flushWithBoundIds(this.bound); }
}
