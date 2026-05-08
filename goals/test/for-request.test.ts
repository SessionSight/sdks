import { test, expect, mock, beforeEach, afterAll, describe } from 'bun:test';
import { GoalsClient } from '../src/client.js';

/**
 * Under the session-as-identity model the goals SDK wire payload is
 * sessionId-only. `forRequest(req)` extracts ss_sid from the request and
 * auto-attaches it to every call; the visitor is resolved from the
 * session by the backend.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockIngestOk() {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;
  return mockFetch;
}

function lastBody(mockFetch: any): Record<string, any> {
  const [, opts] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

describe('GoalsClient.forRequest', () => {
  test('auto-injects sessionId from pre-parsed cookies', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { cookies: { ss_vid: 'v-from-map', ss_sid: 's-from-map' } };

    await client.forRequest(req).increment('goal-a');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-from-map');
    expect(body.visitorId).toBeUndefined();
  });

  test('auto-injects from Node-style req.headers.cookie', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { headers: { cookie: 'ss_vid=v-node; ss_sid=s-node' } };

    await client.forRequest(req).increment('goal-a');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-node');
    expect(body.visitorId).toBeUndefined();
  });

  test('auto-injects from Fetch-style headers.get("cookie")', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = {
      headers: {
        get: (name: string) => (name === 'cookie' ? 'ss_vid=v-fetch; ss_sid=s-fetch' : null),
      },
    };

    await client.forRequest(req).increment('goal-a');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-fetch');
    expect(body.visitorId).toBeUndefined();
  });

  test('explicit per-call sessionId overrides bound sessionId', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { cookies: { ss_sid: 's-bound' } };

    await client.forRequest(req).increment('goal-a', { sessionId: 's-explicit' });

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-explicit');
  });

  test('missing cookie rejects without attempting the fetch', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { headers: { cookie: 'irrelevant=1' } };

    const result = await client.forRequest(req).increment('goal-a');

    expect(result.success).toBe(false);
    expect(result.error).toContain('sessionId is required');
    expect(mockFetch.mock.calls.length).toBe(0);
  });

  test('decrement also picks up bound sessionId', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { cookies: { ss_sid: 'ss' } };

    await client.forRequest(req).decrement('goal-a');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('ss');
  });

  test('two concurrent requests stay isolated (bound wrapper, not shared mutation)', async () => {
    const mockFetch = mockIngestOk();
    const client = new GoalsClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });

    const reqA = { cookies: { ss_sid: 'sa' } };
    const reqB = { cookies: { ss_sid: 'sb' } };

    await Promise.all([
      client.forRequest(reqA).increment('goal-a'),
      client.forRequest(reqB).increment('goal-b'),
    ]);

    const calls = mockFetch.mock.calls.map((c: any) => JSON.parse(c[1].body));
    const byGoal = Object.fromEntries(calls.map((b: any) => [b.goalId, b]));
    expect(byGoal['goal-a'].sessionId).toBe('sa');
    expect(byGoal['goal-b'].sessionId).toBe('sb');
  });
});
