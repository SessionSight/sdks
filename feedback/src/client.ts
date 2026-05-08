import type { FeedbackConfig, FeedbackOptions, FeedbackResult } from './types.js';
import { normalizeApiUrl, extractIdsFromRequest } from '@sessionsight/sdk-shared';

const FETCH_TIMEOUT_MS = 10_000;

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class FeedbackClient {
  private apiUrl: string;
  private secretApiKey: string;
  private propertyId: string;

  constructor(config: FeedbackConfig) {
    if (typeof window !== 'undefined' && !('process' in globalThis)) {
      throw new Error('@sessionsight/feedback is a server-side SDK and cannot be used in the browser.');
    }
    if (!config.secretApiKey?.trim()) throw new Error('@sessionsight/feedback: secretApiKey is required.');
    if (!config.propertyId?.trim()) throw new Error('@sessionsight/feedback: propertyId is required.');
    this.secretApiKey = config.secretApiKey;
    this.propertyId = config.propertyId;
    this.apiUrl = normalizeApiUrl(config.apiUrl || '');
  }

  async submit(feedbackTypeId: string, options?: FeedbackOptions): Promise<FeedbackResult> {
    if (!options?.sessionId?.trim()) {
      return { success: false, error: 'sessionId is required (feedback is session-scoped; thread sessionId from the originating request)' };
    }
    try {
      const res = await fetchWithTimeout(`${this.apiUrl}/v1/feedback/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.secretApiKey,
        },
        body: JSON.stringify({
          feedbackTypeId,
          propertyId: this.propertyId,
          sessionId: options.sessionId,
          ...(options?.option ? { option: options.option } : {}),
          ...(options?.message ? { message: options.message } : {}),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { success: false, error: (data as any).error || `HTTP ${res.status}` };
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn('[SessionSight Feedback] Failed to submit feedback:', message);
      return { success: false, error: message };
    }
  }

  destroy(): void {}

  /**
   * Bind this client to an inbound HTTP request so `submit()` auto-attaches
   * `sessionId` (from the `ss_sid` cookie). Accepts Node-style requests,
   * Fetch-style requests, pre-parsed cookie maps, or a raw cookie header
   * string.
   */
  forRequest(req: unknown): BoundFeedbackClient {
    const { sessionId } = extractIdsFromRequest(req);
    return new BoundFeedbackClient(this, { sessionId });
  }
}

export class BoundFeedbackClient {
  constructor(
    private readonly client: FeedbackClient,
    private readonly bound: { sessionId: string | null },
  ) {}

  submit(feedbackTypeId: string, options?: FeedbackOptions): Promise<FeedbackResult> {
    const merged: FeedbackOptions = { ...(options || {}) };
    if (!merged.sessionId && this.bound.sessionId) merged.sessionId = this.bound.sessionId;
    return this.client.submit(feedbackTypeId, merged);
  }
}
