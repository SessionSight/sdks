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

test('increment returns error on non-ok response', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ error: 'Goal not found' }), { status: 404 }))
  );

  const client = new GoalsClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.increment('nonexistent', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Goal not found');
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
