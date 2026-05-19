import { test, expect, describe, beforeEach, afterAll, mock } from 'bun:test';
import { FeatureFlagClient } from '../src/client.js';

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response()));
globalThis.fetch = mockFetch as any;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchResponse(data: any, status = 200) {
  mockFetch.mockResolvedValue(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function lastInitContext(): Record<string, any> {
  const [, opts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as any[];
  return JSON.parse(opts.body).context;
}

describe('FeatureFlagClient.forRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetchResponse({ flags: {} });
  });

  test('forRequest merges visitorId and sessionId into evaluation context on init', async () => {
    const client = new FeatureFlagClient({
      secretApiKey: 'sk',
      environment: 'production',
      propertyId: 'p',
      apiUrl: 'http://x',
    });
    const req = { cookies: { ss_vid: 'v-flag', ss_sid: 's-flag' } };

    await client.forRequest(req).init({ userId: 'user-1' });

    const ctx = lastInitContext();
    expect(ctx.visitorId).toBe('v-flag');
    expect(ctx.sessionId).toBe('s-flag');
    expect(ctx.userId).toBe('user-1');
  });

  test('explicit context values win over bound cookie values', async () => {
    const client = new FeatureFlagClient({
      secretApiKey: 'sk',
      environment: 'production',
      propertyId: 'p',
      apiUrl: 'http://x',
    });
    const req = { cookies: { ss_vid: 'v-bound', ss_sid: 's-bound' } };

    await client.forRequest(req).init({ visitorId: 'v-explicit' });

    const ctx = lastInitContext();
    expect(ctx.visitorId).toBe('v-explicit');
    expect(ctx.sessionId).toBe('s-bound');
  });

  test('refresh also picks up bound ids', async () => {
    const client = new FeatureFlagClient({
      secretApiKey: 'sk',
      environment: 'production',
      propertyId: 'p',
      apiUrl: 'http://x',
    });
    await client.init(); // first fetch, no bound ids

    const req = { headers: { cookie: 'ss_vid=vr; ss_sid=sr' } };
    await client.forRequest(req).refresh({ userId: 'u' });

    const ctx = lastInitContext();
    expect(ctx.visitorId).toBe('vr');
    expect(ctx.sessionId).toBe('sr');
    expect(ctx.userId).toBe('u');
  });

  test('bound reads come from the bound instance map populated on init', async () => {
    mockFetchResponse({
      flags: { 'dark-mode': { value: true, type: 'boolean' } },
    });

    const client = new FeatureFlagClient({
      secretApiKey: 'sk',
      environment: 'production',
      propertyId: 'p',
      apiUrl: 'http://x',
    });
    const req = { cookies: { ss_vid: 'v', ss_sid: 's' } };

    const bound = client.forRequest(req);
    await bound.init();

    expect(bound.getBooleanFlag('dark-mode', false)).toBe(true);
    expect(bound.isInitialized()).toBe(true);
  });

  test('two forRequest instances with different visitor cookies do NOT see each other\'s flag values', async () => {
    const client = new FeatureFlagClient({
      secretApiKey: 'sk',
      environment: 'production',
      propertyId: 'p',
      apiUrl: 'http://x',
    });

    // Visitor A is in the rollout; server returns dark-mode=true.
    mockFetchResponse({
      flags: { 'dark-mode': { value: true, type: 'boolean' } },
    });
    const reqA = { cookies: { ss_vid: 'visitor-a', ss_sid: 'session-a' } };
    const boundA = client.forRequest(reqA);
    await boundA.init();

    // Visitor B is NOT in the rollout; server returns dark-mode=false.
    mockFetchResponse({
      flags: { 'dark-mode': { value: false, type: 'boolean' } },
    });
    const reqB = { cookies: { ss_vid: 'visitor-b', ss_sid: 'session-b' } };
    const boundB = client.forRequest(reqB);
    await boundB.init();

    // The invariant: A's bound view is unaffected by B's later evaluation.
    expect(boundA.getBooleanFlag('dark-mode', false)).toBe(true);
    expect(boundB.getBooleanFlag('dark-mode', true)).toBe(false);
  });
});
