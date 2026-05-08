import { test, expect, mock, beforeEach, afterAll, describe } from 'bun:test';
import { FeedbackClient } from '../src/client.js';

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

describe('FeedbackClient.forRequest', () => {
  test('auto-injects sessionId from request cookies', async () => {
    const mockFetch = mockIngestOk();
    const client = new FeedbackClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { cookies: { ss_sid: 's-fb' } };

    await client.forRequest(req).submit('bug-report');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-fb');
    expect(body.visitorId).toBeUndefined();
  });

  test('explicit per-call sessionId overrides bound one', async () => {
    const mockFetch = mockIngestOk();
    const client = new FeedbackClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = { cookies: { ss_sid: 's-bound' } };

    await client.forRequest(req).submit('bug-report', {
      sessionId: 's-override',
    });

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('s-override');
  });

  test('works with Fetch-style Headers', async () => {
    const mockFetch = mockIngestOk();
    const client = new FeedbackClient({ secretApiKey: 'sk', propertyId: 'p', apiUrl: 'http://x' });
    const req = {
      headers: {
        get: (name: string) => (name === 'cookie' ? 'ss_sid=sf' : null),
      },
    };

    await client.forRequest(req).submit('survey');

    const body = lastBody(mockFetch);
    expect(body.sessionId).toBe('sf');
  });
});
