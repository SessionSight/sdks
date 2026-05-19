import { test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { FeedbackClient } from '../src/client.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test('submit sends correct request', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
    apiUrl: 'https://api.example.com',
  });

  const result = await client.submit('bug-report', {
    sessionId: 's-test',
    option: 'critical',
    message: 'Page crashes on Safari',
    metadata: { page: '/checkout' },
  });

  expect(result).toEqual({ success: true });
  expect(mockFetch).toHaveBeenCalledTimes(1);

  const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://api.example.com/v1/feedback/submit');
  expect(opts.method).toBe('POST');
  expect(opts.headers).toEqual({
    'Content-Type': 'application/json',
    'x-api-key': 'sk_test_123',
  });
  const body = JSON.parse(opts.body as string);
  expect(body.feedbackTypeId).toBe('bug-report');
  expect(body.propertyId).toBe('prop-1');
  expect(body.sessionId).toBe('s-test');
  expect(body.userId).toBeUndefined();
  expect(body.visitorId).toBeUndefined();
  expect(body.option).toBe('critical');
  expect(body.message).toBe('Page crashes on Safari');
  expect(body.metadata).toEqual({ page: '/checkout' });
});

test('submit rejects when sessionId is omitted', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.submit('general');
  expect(result.success).toBe(false);
  expect(result.error).toContain('sessionId is required');
  expect(mockFetch.mock.calls.length).toBe(0);
});

test('submit returns error on non-ok response', async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ error: 'Feedback type not found' }), { status: 404 }))
  );

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.submit('nonexistent', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Feedback type not found');
});

test('submit returns error on network failure', async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  const result = await client.submit('bug-report', { sessionId: 's-test' });
  expect(result.success).toBe(false);
  expect(result.error).toBe('Network error');
});

test('strips trailing slash from apiUrl', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
    apiUrl: 'https://api.example.com/',
  });

  await client.submit('test', { sessionId: 's-test' });
  const url = (mockFetch.mock.calls[0] as [string, RequestInit])[0];
  expect(url).toBe('https://api.example.com/v1/feedback/submit');
});

test('uses default apiUrl when not provided', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.submit('test', { sessionId: 's-test' });
  const url = (mockFetch.mock.calls[0] as [string, RequestInit])[0];
  expect(url).toBe('https://api.sessionsight.com/v1/feedback/submit');
});

test('BoundFeedbackClient does not overwrite an explicit empty-string sessionId from caller', async () => {
  // Empty string is a *meaningful explicit override* (the caller is
  // declaring "I have no session"). Falsy-coalescing it with the bound
  // session would silently re-attach a session the caller wanted gone.
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });
  const bound = client.forRequest({
    headers: { cookie: 'ss_sid=sess-from-cookie' },
  });

  const result = await bound.submit('bug-report', { sessionId: '' });
  // Submit-level guard rejects empty sessionId; ensure that path runs
  // (i.e. the bound session was NOT silently substituted in).
  expect(result.success).toBe(false);
  expect(result.error).toContain('sessionId is required');
  expect(mockFetch.mock.calls.length).toBe(0);
});

test('submit only includes provided optional fields', async () => {
  const mockFetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  globalThis.fetch = mockFetch;

  const client = new FeedbackClient({
    secretApiKey: 'sk_test_123',
    propertyId: 'prop-1',
  });

  await client.submit('star-rating', { sessionId: 's-test', option: '5' });

  const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
  expect(body.feedbackTypeId).toBe('star-rating');
  expect(body.option).toBe('5');
  expect(body.userId).toBeUndefined();
  expect(body.message).toBeUndefined();
  expect(body.metadata).toBeUndefined();
});
