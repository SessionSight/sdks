import { test, expect, describe, beforeEach, afterAll, mock } from 'bun:test';
import { FeatureFlagClient } from '../src/client';

// Mock global fetch
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

describe('FeatureFlagClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('init fetches flags and marks as initialized', async () => {
    mockFetchResponse({
      flags: {
        'dark-mode': { value: true, type: 'boolean' },
        'variant': { value: 'b', type: 'string' },
      },
    });

    const client = new FeatureFlagClient({
      secretApiKey: 'test-key',
      environment: 'production',
      propertyId: 'test-prop',
      apiUrl: 'http://localhost:3001',
    });

    expect(client.isInitialized()).toBe(false);
    await client.init({ userId: 'u1' });
    expect(client.isInitialized()).toBe(true);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as any[];
    expect(url).toBe('http://localhost:3001/v1/flags/evaluate');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-api-key']).toBe('test-key');
    const body = JSON.parse(opts.body);
    expect(body.environment).toBe('production');
    expect(body.context.userId).toBe('u1');
  });

  test('getBooleanFlag returns value when type matches', async () => {
    mockFetchResponse({
      flags: { 'dark-mode': { value: true, type: 'boolean' } },
    });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getBooleanFlag('dark-mode', false)).toBe(true);
  });

  test('getBooleanFlag returns default when flag missing', async () => {
    mockFetchResponse({ flags: {} });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getBooleanFlag('missing', false)).toBe(false);
  });

  test('getBooleanFlag returns default when type is string', async () => {
    mockFetchResponse({
      flags: { 'variant': { value: 'a', type: 'string' } },
    });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getBooleanFlag('variant', false)).toBe(false);
  });

  test('getStringFlag returns value when type matches', async () => {
    mockFetchResponse({
      flags: { 'variant': { value: 'checkout-b', type: 'string' } },
    });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getStringFlag('variant', 'control')).toBe('checkout-b');
  });

  test('getStringFlag returns default when flag missing', async () => {
    mockFetchResponse({ flags: {} });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getStringFlag('missing', 'default')).toBe('default');
  });

  test('getStringFlag returns default when type is boolean', async () => {
    mockFetchResponse({
      flags: { 'toggle': { value: true, type: 'boolean' } },
    });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getStringFlag('toggle', 'fallback')).toBe('fallback');
  });

  test('refresh re-fetches flags with updated context', async () => {
    mockFetchResponse({ flags: { 'f': { value: false, type: 'boolean' } } });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init({ userId: 'u1' });

    mockFetchResponse({ flags: { 'f': { value: true, type: 'boolean' } } });
    await client.refresh({ userId: 'u2' });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(client.getBooleanFlag('f', false)).toBe(true);

    // Verify second call has updated context
    const [, opts] = mockFetch.mock.calls[1] as any[];
    const body = JSON.parse(opts.body);
    expect(body.context.userId).toBe('u2');
  });

  test('destroy clears state', async () => {
    mockFetchResponse({ flags: { 'f': { value: true, type: 'boolean' } } });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init();

    expect(client.getBooleanFlag('f', false)).toBe(true);
    expect(client.isInitialized()).toBe(true);

    client.destroy();

    expect(client.isInitialized()).toBe(false);
    expect(client.getBooleanFlag('f', false)).toBe(false);
  });

  test('handles fetch failure gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init(); // should not throw

    // Returns defaults since no flags were loaded
    expect(client.getBooleanFlag('anything', true)).toBe(true);
  });

  test('handles non-ok response gracefully', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 500 }));

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001' });
    await client.init(); // should not throw

    expect(client.getStringFlag('anything', 'default')).toBe('default');
  });

  test('strips trailing slash from apiUrl', async () => {
    mockFetchResponse({ flags: {} });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop', apiUrl: 'http://localhost:3001/' });
    await client.init();

    const [url] = mockFetch.mock.calls[0] as any[];
    expect(url).toBe('http://localhost:3001/v1/flags/evaluate');
  });

  test('getFlags returns flag definitions', async () => {
    const flagsData = {
      flags: [
        { id: 'f1', key: 'dark-mode', name: 'Dark Mode', type: 'boolean', defaultValue: false, createdAt: 1000 },
        { id: 'f2', key: 'cta-color', name: 'CTA Color', type: 'string', defaultValue: 'blue', createdAt: 2000 },
      ],
    };
    mockFetchResponse(flagsData);

    const client = new FeatureFlagClient({ secretApiKey: 'test-key', environment: 'prod', propertyId: 'prop-1', apiUrl: 'http://localhost:3001' });
    const result = await client.getFlags();

    expect(result.flags).toHaveLength(2);
    expect(result.flags[0].key).toBe('dark-mode');
    expect(result.flags[1].key).toBe('cta-color');

    const [url, opts] = mockFetch.mock.calls[0] as any[];
    expect(url).toBe('http://localhost:3001/v1/flags/list?propertyId=prop-1');
    expect(opts.method).toBe('GET');
    expect(opts.headers['x-api-key']).toBe('test-key');
  });

  test('getFlags returns empty array on failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'p1', apiUrl: 'http://localhost:3001' });
    const result = await client.getFlags();

    expect(result.flags).toEqual([]);
  });

  test('defaults apiUrl to production', async () => {
    mockFetchResponse({ flags: {} });

    const client = new FeatureFlagClient({ secretApiKey: 'k', environment: 'prod', propertyId: 'test-prop' });
    await client.init();

    const [url] = mockFetch.mock.calls[0] as any[];
    expect(url).toBe('https://api.sessionsight.com/v1/flags/evaluate');
  });
});
