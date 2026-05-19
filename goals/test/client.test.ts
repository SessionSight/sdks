import { test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { GoalsClient } from '../src/client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

// Restore fetch after this file finishes so later test files in the same
// bun process (e.g. apps/api/test/middleware/trustProxy.test.ts, which
// uses real fetch against an ephemeral Express server) don't inherit a
// mock from the last test that ran here.
afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('increment sends correct request', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
    apiUrl: 'https://api.example.com',
  });

  const result = await client.increment('user-signups', { sessionId: 's-test' });

  expect(result).toEqual({ success: true });
  expect(mockFetch).toHaveBeenCalledTimes(1);

  const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.example.com/v1/goals/increment');
  expect(opts.method).toBe('POST');
  expect(opts.headers).toEqual({
    'Content-Type': 'application/json',
    'x-api-key': 'sk_test_123',
  });
  const body = JSON.parse(opts.body as string);
  expect(body.goalId).toBe('user-signups');
  expect(body.propertyId).toBe('prop-1');
  expect(body.amount).toBe(1);
});

test('increment sends custom amount and metadata', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.increment('revenue', { sessionId: 's-test', amount: 49, metadata: { plan: 'pro' } });

  const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
  expect(body.amount).toBe(49);
  expect(body.metadata).toEqual({ plan: 'pro' });
});

test('increment returns error message from server error object', async () => {
  // Server contract is `{ error: { code, message } }` (handleError.ts).
  // The SDK must surface the string `message`, not the object.
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } }),
        { status: 400 },
      ),
    ),
  );

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('nonexistent', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Invalid request');
  expect(typeof result.error).toBe('string');
});

test('increment falls back to error.code when message missing', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429 }),
    ),
  );

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('x', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('RATE_LIMITED');
});

test('increment falls back to HTTP <status> when body has no error', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response('not json at all', { status: 502 })),
  );

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('x', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('HTTP 502');
});

test('increment returns error on network failure', async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('user-signups', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Network error');
});

test('send() does not log to console.warn unless debug=true', async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

  const warnSpy = mock((..._args: unknown[]) => {});
  const originalWarn = console.warn;
  console.warn = warnSpy as unknown as typeof console.warn;

  try {
    const client = new GoalsClient({
      secretApiKey: 'sk_test_123',
      propertyId: 'prop-1',
    });
    const result = await client.increment('g', { sessionId: 's-test' });
    expect(result.success).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(0);
  } finally {
    console.warn = originalWarn;
  }
});

test('send() logs to console.warn when debug=true', async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

  const warnSpy = mock((..._args: unknown[]) => {});
  const originalWarn = console.warn;
  console.warn = warnSpy as unknown as typeof console.warn;

  try {
    const client = new GoalsClient({
      secretApiKey: 'sk_test_123',
      propertyId: 'prop-1',
      debug: true,
    });
    const result = await client.increment('g', { sessionId: 's-test' });
    expect(result.success).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  } finally {
    console.warn = originalWarn;
  }
});

test('AbortError surfaces a distinctive timeout message', async () => {
  // Simulate the abort path. We don't wait the real 10s; we throw an
  // AbortError synchronously from the mocked fetch so the catch branch
  // sees the same `name === 'AbortError'` it would in production.
  globalThis.fetch = mock(() => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    return Promise.reject(e);
  });

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('g', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('request timed out after 10s');
});

test('non-Error thrown from fetch surfaces "Unknown error"', async () => {
  // Forces the non-Error branch of the catch block.
  globalThis.fetch = mock(() => Promise.reject('weird string')) as any;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('g', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Unknown error');
});

test('strips trailing slash from apiUrl', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
    apiUrl: 'https://api.example.com/',
  });

  await client.increment('test', { sessionId: 's-test' });
  const url = (mockFetch.mock.calls[0] as [string, RequestInit])[0];
  expect(url).toBe('https://api.example.com/v1/goals/increment');
});

test('increment never sends value or currency', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.increment('user-signups', { sessionId: 's-test', amount: 5, metadata: { plan: 'pro' } } as any);

  const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
  expect(body.value).toBeUndefined();
  expect(body.currency).toBeUndefined();
  expect(body.amount).toBe(5);
  expect(body.metadata).toEqual({ plan: 'pro' });
});

test('decrement sends correct request', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
    apiUrl: 'https://api.example.com',
  });

  const result = await client.decrement('user-signups', { sessionId: 's-test' });

  expect(result).toEqual({ success: true });
  const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.example.com/v1/goals/decrement');
  expect(opts.method).toBe('POST');
  const body = JSON.parse(opts.body as string);
  expect(body.goalId).toBe('user-signups');
  expect(body.propertyId).toBe('prop-1');
  expect(body.amount).toBe(1);
});

test('decrement sends custom amount and metadata', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.decrement('inventory', { sessionId: 's-test', amount: 3, metadata: { reason: 'refund' } });

  const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
  expect(body.amount).toBe(3);
  expect(body.metadata).toEqual({ reason: 'refund' });
});

test('uses default apiUrl when not provided', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.increment('test', { sessionId: 's-test' });
  const url = (mockFetch.mock.calls[0] as [string, RequestInit])[0];
  expect(url).toBe('https://api.sessionsight.com/v1/goals/increment');
});
