import { test, expect, beforeEach, mock } from 'bun:test';
import {
  getCachedConfig,
  setCachedConfig,
  getCachedAssignments,
  setCachedAssignments,
  clearCache,
} from '../src/cache';
import { SplitTestingClient } from '../src/client';
import type { SplitTestConfigResponse, Assignment } from '../src/types';

// Storage map injected by test/setup.ts preload
const storage: Map<string, string> = (globalThis as any).__testStorage;

// ── Helpers ────────────────────────────────────────────────────────

const PROPERTY = 'prop-1';
const VISITOR = 'visitor-1';

const fakeConfigResponse: SplitTestConfigResponse = {
  tests: [
    {
      key: 'hero-test',
      id: 'test-id-1',
      type: 'text',
      status: 'running',
      hashSeed: 'seed-abc',
      trafficAllocation: 100,
      variations: [
        { key: 'control', weight: 50, value: 'Hello' },
        { key: 'variant-a', weight: 50, value: 'Hey there' },
      ],
    },
  ],
  ttl: 300,
};

function makeClient(overrides: Record<string, any> = {}): SplitTestingClient {
  return new SplitTestingClient({
    publicApiKey: 'pk_test',
    propertyId: PROPERTY,
    apiUrl: 'https://api.test.com',
    visitorId: VISITOR,
    ...overrides,
  });
}

beforeEach(() => {
  storage.clear();
});

// ════════════════════════════════════════════════════════════════════
//  Cache tests
// ════════════════════════════════════════════════════════════════════

test('setCachedConfig / getCachedConfig round trip', () => {
  setCachedConfig(PROPERTY, fakeConfigResponse);
  const cached = getCachedConfig(PROPERTY);
  expect(cached).not.toBeNull();
  expect(cached!.data.tests[0].key).toBe('hero-test');
  expect(typeof cached!.fetchedAt).toBe('number');
});

test('getCachedConfig returns null when nothing is stored', () => {
  expect(getCachedConfig('nonexistent')).toBeNull();
});

test('setCachedAssignments / getCachedAssignments round trip', () => {
  const assignments: Record<string, Assignment> = {
    'hero-test': {
      testKey: 'hero-test',
      variationIndex: 1,
      variationKey: 'variant-a',
      value: 'Hey there',
      type: 'text',
      inTest: true,
    },
  };
  setCachedAssignments(PROPERTY, VISITOR, assignments);
  const cached = getCachedAssignments(PROPERTY, VISITOR);
  expect(cached).not.toBeNull();
  expect(cached!['hero-test'].variationKey).toBe('variant-a');
});

test('clearCache removes config and assignment entries for the property', () => {
  setCachedConfig(PROPERTY, fakeConfigResponse);
  setCachedAssignments(PROPERTY, VISITOR, {
    'hero-test': {
      testKey: 'hero-test',
      variationIndex: 0,
      variationKey: 'control',
      value: 'Hello',
      type: 'text',
      inTest: true,
    },
  });
  expect(storage.size).toBeGreaterThan(0);

  clearCache(PROPERTY);

  expect(getCachedConfig(PROPERTY)).toBeNull();
  expect(getCachedAssignments(PROPERTY, VISITOR)).toBeNull();
});

test('clearCache does not remove entries for a different property', () => {
  setCachedConfig('prop-other', fakeConfigResponse);
  setCachedConfig(PROPERTY, fakeConfigResponse);

  clearCache(PROPERTY);

  expect(getCachedConfig(PROPERTY)).toBeNull();
  expect(getCachedConfig('prop-other')).not.toBeNull();
});

// ════════════════════════════════════════════════════════════════════
//  Client tests
// ════════════════════════════════════════════════════════════════════

test('get() returns default value before init', () => {
  const client = makeClient();
  expect(client.get('hero-test', 'fallback')).toBe('fallback');
});

test('get() returns cached assignment after init with pre-cached config', async () => {
  // Pre-populate cache so no fetch is needed
  setCachedConfig(PROPERTY, fakeConfigResponse);

  const client = makeClient({ maxAge: 999_999_999, staleTTL: 999_999_999 });
  await client.init();

  const value = client.get('hero-test', 'fallback');
  // Should be one of the variation values, not the fallback
  expect(['Hello', 'Hey there']).toContain(value);
});

test('get() fetches config from API when cache is empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/v1/split-testing/config')) {
      return new Response(JSON.stringify(fakeConfigResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as any;

  try {
    const client = makeClient();
    await client.init();

    const value = client.get('hero-test', 'fallback');
    expect(['Hello', 'Hey there']).toContain(value);
    // Config should now be cached
    expect(getCachedConfig(PROPERTY)).not.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getAssignments returns variation indices keyed by test key', async () => {
  setCachedConfig(PROPERTY, fakeConfigResponse);

  const client = makeClient({ maxAge: 999_999_999, staleTTL: 999_999_999 });
  await client.init();

  const assignments = client.getAssignments();
  expect(assignments).toHaveProperty('hero-test');
  expect(typeof assignments['hero-test']).toBe('number');
});

test('destroy clears internal state', async () => {
  setCachedConfig(PROPERTY, fakeConfigResponse);

  const client = makeClient({ maxAge: 999_999_999, staleTTL: 999_999_999 });
  await client.init();

  client.destroy();

  // After destroy, get() should return default
  expect(client.get('hero-test', 'fallback')).toBe('fallback');
});
