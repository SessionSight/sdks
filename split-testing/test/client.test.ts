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

// ════════════════════════════════════════════════════════════════════
//  H2: Cached assignments are sticky across config changes
// ════════════════════════════════════════════════════════════════════

test('exposed visitor stays bucketed even after config hashSeed changes', async () => {
  // Pre-cache an assignment landing the visitor on variant-a.
  setCachedAssignments(PROPERTY, VISITOR, {
    'hero-test': {
      testKey: 'hero-test',
      variationIndex: 1,
      variationKey: 'variant-a',
      value: 'Hey there',
      type: 'text',
      inTest: true,
    },
  });

  // Live config has a NEW hashSeed and the variation `value` was edited.
  // Without sticky-assignment, evaluateAssignments would re-hash with the
  // new seed and could land the visitor on `control` instead.
  const changedConfig: SplitTestConfigResponse = {
    tests: [
      {
        key: 'hero-test',
        id: 'test-id-1',
        type: 'text',
        status: 'running',
        hashSeed: 'completely-different-seed-xyz',
        trafficAllocation: 100,
        variations: [
          { key: 'control', weight: 50, value: 'Hello' },
          { key: 'variant-a', weight: 50, value: 'Hey there (edited)' },
        ],
      },
    ],
  } as any;
  setCachedConfig(PROPERTY, changedConfig);

  const client = makeClient({ maxAge: 999_999_999, staleTTL: 999_999_999 });
  await client.init();

  const assignments = client.getAssignments();
  // Visitor must remain bucketed on variant-a (index 1), not silently
  // re-bucketed onto control by the new hashSeed.
  expect(assignments['hero-test']).toBe(1);

  // The variation `value` should have refreshed from the live config so
  // the integrator sees the latest content for the same bucket.
  const value = client.get('hero-test', 'fallback');
  expect(value).toBe('Hey there (edited)');
});

// ════════════════════════════════════════════════════════════════════
//  H3: Per-instance exposure dedup persists across flushes
// ════════════════════════════════════════════════════════════════════

test('only one POST per (sessionId, testKey) per instance, even after flush', async () => {
  // Install a cookie store so the SDK has a session to key exposures to.
  let cookieStore = 'ss_sid=sess-h3';
  Object.defineProperty(globalThis, 'document', {
    value: {
      createElement: () => ({ id: '', textContent: '', remove() {} }),
      head: { appendChild() {} },
      get cookie() { return cookieStore; },
      set cookie(v: string) { cookieStore = v; },
    },
    writable: true,
    configurable: true,
  });

  const beaconCalls: Array<{ url: string; body: string }> = [];
  globalThis.navigator = {
    sendBeacon: (url: string, blob: Blob) => {
      // Capture the blob body via a synchronously-stashed text snapshot.
      // bun's Blob.text() is async, so we tag the blob and await later.
      (blob as any)._capturedUrl = url;
      beaconCalls.push({ url, body: '' });
      // Read body asynchronously and store on the call entry.
      (blob.text() as Promise<string>).then((t) => {
        const last = beaconCalls[beaconCalls.length - 1]!;
        last.body = t;
      });
      return true;
    },
  } as any;

  setCachedConfig(PROPERTY, fakeConfigResponse);

  const client = makeClient({ maxAge: 999_999_999, staleTTL: 999_999_999 });
  await client.init();

  // First get(): queues an exposure, and instance-lifetime dedup adds
  // testKey to exposedTestKeys.
  client.get('hero-test', 'fallback');
  // Force-flush to clear pendingExposures queue.
  (client as any).flushExposures();

  expect(beaconCalls.length).toBe(1);

  // Subsequent get() calls in the same instance must not queue another
  // POST: the in-flight queue is empty after flush, but the per-instance
  // dedup set still records that we've fired for this testKey.
  client.get('hero-test', 'fallback');
  client.get('hero-test', 'fallback');
  (client as any).flushExposures();

  expect(beaconCalls.length).toBe(1);
});

// ════════════════════════════════════════════════════════════════════
//  M2: destroy() aborts in-flight background fetchConfig writes
// ════════════════════════════════════════════════════════════════════

test('destroy() prevents a late background fetch from writing onto a torn-down instance', async () => {
  // Stale cached config so init() takes the cache path and schedules a
  // background refetch.
  setCachedConfig(PROPERTY, fakeConfigResponse);

  // Stall the fetch indefinitely; we resolve it manually after destroy().
  let resolveFetch: ((res: Response) => void) | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock((_url: string | URL | Request) => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  })) as any;

  try {
    const client = makeClient({ maxAge: 999_999_999, staleTTL: 0 });
    await client.init();

    // Tear down before the background fetch completes.
    client.destroy();

    // Now resolve the in-flight fetch with a different config (different
    // hashSeed). If destroy()'s abort guard works, the post-await write
    // is skipped; otherwise client.config gets repopulated on a destroyed
    // instance.
    const lateConfig: SplitTestConfigResponse = {
      tests: [
        {
          key: 'late-test',
          id: 'late-id',
          type: 'text',
          status: 'running',
          hashSeed: 'late-seed',
          trafficAllocation: 100,
          variations: [
            { key: 'control', weight: 100, value: 'late' },
          ],
        },
      ],
    } as any;
    resolveFetch!(new Response(JSON.stringify(lateConfig), { status: 200 }));

    // Drain microtasks so the .then() handlers run.
    await new Promise((r) => setTimeout(r, 0));

    // Internal state must remain torn down; config not repopulated and
    // assignments empty.
    expect((client as any).config).toBeNull();
    expect(Object.keys((client as any).assignments).length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
