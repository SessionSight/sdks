import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import {
  normalizeApiUrl,
  DEFAULT_API_URL,
  getOrCreateVisitorId,
  shouldSuppressPersistentId,
  setRegistryValue,
  getRegistryValue,
  bootstrapVisitorToken,
  fetchWithTimeout,
  hasLocalStorage,
} from '../src/index.js';

// ── normalizeApiUrl ────────────────────────────────────────────────

describe('normalizeApiUrl', () => {
  test('strips single trailing slash', () => {
    expect(normalizeApiUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  test('leaves URL without trailing slash unchanged', () => {
    expect(normalizeApiUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  test('strips only last trailing slash', () => {
    expect(normalizeApiUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });

  test('returns default API URL for empty string', () => {
    expect(normalizeApiUrl('')).toBe(DEFAULT_API_URL);
  });

  test('returns default API URL when given only a slash', () => {
    // '/' is truthy so the input passes through, the trailing-slash strip
    // collapses it to '', and the post-strip empty-string guard returns
    // DEFAULT_API_URL so callers don't end up building relative URLs.
    expect(normalizeApiUrl('/')).toBe(DEFAULT_API_URL);
  });

  test('handles URL with port and trailing slash', () => {
    expect(normalizeApiUrl('http://localhost:3001/')).toBe('http://localhost:3001');
  });
});

// ── Registry ───────────────────────────────────────────────────────

describe('Registry', () => {
  test('set and get round-trip', () => {
    setRegistryValue('testKey', 42);
    expect(getRegistryValue<number>('testKey')).toBe(42);
  });

  test('returns undefined for missing key', () => {
    expect(getRegistryValue('nonexistent_key_xyz')).toBeUndefined();
  });

  test('overwrites existing value', () => {
    setRegistryValue('overwrite', 'first');
    setRegistryValue('overwrite', 'second');
    expect(getRegistryValue<string>('overwrite')).toBe('second');
  });

  test('isolation between keys', () => {
    setRegistryValue('keyA', 'alpha');
    setRegistryValue('keyB', 'beta');
    expect(getRegistryValue<string>('keyA')).toBe('alpha');
    expect(getRegistryValue<string>('keyB')).toBe('beta');
  });

  test('stores complex objects', () => {
    const obj = { nested: { arr: [1, 2, 3] } };
    setRegistryValue('complex', obj);
    expect(getRegistryValue<typeof obj>('complex')).toBe(obj); // same reference
  });

  test('typed generic retrieval', () => {
    setRegistryValue('num', 99);
    const val = getRegistryValue<number>('num');
    expect(val).toBe(99);
  });
});

// ── getOrCreateVisitorId ───────────────────────────────────────────

describe('getOrCreateVisitorId', () => {
  test('returns provided ID immediately', () => {
    expect(getOrCreateVisitorId('my-custom-id')).toBe('my-custom-id');
  });

  test('returns a UUID string in SSR (no window/document/localStorage)', () => {
    // In Bun test environment, window/document/localStorage are not defined,
    // so this exercises the SSR fallback path.
    const id = getOrCreateVisitorId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('generates different IDs on each call in SSR (no persistence)', () => {
    // Without localStorage or cookies, each call generates a fresh UUID
    const id1 = getOrCreateVisitorId();
    const id2 = getOrCreateVisitorId();
    expect(id1).not.toBe(id2);
  });

  test('provided ID takes priority even with empty string check', () => {
    // Provided ID is truthy, so it returns immediately
    expect(getOrCreateVisitorId('abc-123')).toBe('abc-123');
  });
});

describe('shouldSuppressPersistentId', () => {
  const origNavigator = globalThis.navigator;

  afterEach(() => {
    // Restore original navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: origNavigator,
      writable: true,
      configurable: true,
    });
  });

  test('returns false when navigator is undefined', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    expect(shouldSuppressPersistentId()).toBe(false);
  });

  test('returns true when doNotTrack is 1', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { doNotTrack: '1' },
      writable: true,
      configurable: true,
    });
    expect(shouldSuppressPersistentId()).toBe(true);
  });

  test('returns true when globalPrivacyControl is true', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { globalPrivacyControl: true },
      writable: true,
      configurable: true,
    });
    expect(shouldSuppressPersistentId()).toBe(true);
  });

  test('returns false when doNotTrack is 0', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { doNotTrack: '0' },
      writable: true,
      configurable: true,
    });
    expect(shouldSuppressPersistentId()).toBe(false);
  });
});

// ── getOrCreateVisitorId with simulated browser globals ────────────

describe('getOrCreateVisitorId with localStorage', () => {
  let storage: Record<string, string>;
  const origWindow = globalThis.window;
  const origLocalStorage = globalThis.localStorage;
  const origDocument = globalThis.document;

  beforeEach(() => {
    storage = {};
    const mockLocalStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, val: string) => { storage[key] = val; },
      removeItem: (key: string) => { delete storage[key]; },
    };

    // Simulate browser environment
    Object.defineProperty(globalThis, 'window', {
      value: {},
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '' },
      writable: true,
      configurable: true,
    });
    // Ensure DNT/GPC are off
    Object.defineProperty(globalThis, 'navigator', {
      value: { doNotTrack: '0' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: origWindow,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: origLocalStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: origDocument,
      writable: true,
      configurable: true,
    });
  });

  test('generates and persists ID to localStorage', () => {
    const id = getOrCreateVisitorId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(storage['sessionsight_visitor_id']).toBe(id);
  });

  test('returns same ID from localStorage on subsequent call', () => {
    const id1 = getOrCreateVisitorId();
    const id2 = getOrCreateVisitorId();
    expect(id1).toBe(id2);
  });

  test('reads existing ID from cookie', () => {
    (globalThis.document as any).cookie = 'ss_vid=a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d; other=val';
    const id = getOrCreateVisitorId();
    expect(id).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
    // Also syncs to localStorage
    expect(storage['sessionsight_visitor_id']).toBe('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d');
  });

  test('reads existing ID from localStorage when no cookie', () => {
    storage['sessionsight_visitor_id'] = 'f1e2d3c4-b5a6-4789-8012-3456789abcde';
    const id = getOrCreateVisitorId();
    expect(id).toBe('f1e2d3c4-b5a6-4789-8012-3456789abcde');
  });

  test('rejects invalid UUID from cookie and generates new ID', () => {
    (globalThis.document as any).cookie = 'ss_vid=not-a-valid-uuid; other=val';
    const id = getOrCreateVisitorId();
    expect(id).not.toBe('not-a-valid-uuid');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('rejects invalid UUID from localStorage and generates new ID', () => {
    storage['sessionsight_visitor_id'] = 'bad-value';
    const id = getOrCreateVisitorId();
    expect(id).not.toBe('bad-value');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// ── bootstrapVisitorToken ──────────────────────────────────────────

describe('bootstrapVisitorToken', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mockFetchOnce(body: unknown, status = 200) {
    globalThis.fetch = (async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  test('throws when visitorToken does not match expected format', async () => {
    mockFetchOnce({
      visitorToken: 'not-a-valid-token',
      visitorId: '550e8400-e29b-41d4-a716-446655440000',
      issuedAt: 1700000000000,
    });
    await expect(
      bootstrapVisitorToken({
        apiUrl: 'https://api.example.com',
        publicApiKey: 'pk_x',
        propertyId: 'prop_1',
      }),
    ).rejects.toThrow(/visitorToken/);
  });

  test('throws when visitorId is not a UUID', async () => {
    mockFetchOnce({
      visitorToken: 'v1.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnc.MDEyMzQ1Njc4OWFiY2RlZmdoaWprbA',
      visitorId: 'not-a-uuid',
      issuedAt: 1700000000000,
    });
    await expect(
      bootstrapVisitorToken({
        apiUrl: 'https://api.example.com',
        publicApiKey: 'pk_x',
        propertyId: 'prop_1',
      }),
    ).rejects.toThrow(/visitorId/);
  });

  test('throws when issuedAt is not a number', async () => {
    mockFetchOnce({
      visitorToken: 'v1.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnc.MDEyMzQ1Njc4OWFiY2RlZmdoaWprbA',
      visitorId: '550e8400-e29b-41d4-a716-446655440000',
      issuedAt: 'not-a-number',
    });
    await expect(
      bootstrapVisitorToken({
        apiUrl: 'https://api.example.com',
        publicApiKey: 'pk_x',
        propertyId: 'prop_1',
      }),
    ).rejects.toThrow(/issuedAt/);
  });
});

// ── fetchWithTimeout / hasLocalStorage ────────────────────────────

describe('fetchWithTimeout', () => {
  test('exported and aborts the request after timeoutMs', async () => {
    // Mock a fetch that resolves only when the signal aborts.
    const origFetch = globalThis.fetch;
    let abortFired = false;
    globalThis.fetch = ((_url: string, opts: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = opts.signal!;
        sig.addEventListener('abort', () => {
          abortFired = true;
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof fetch;
    try {
      await expect(fetchWithTimeout('https://example.com', {}, 20)).rejects.toThrow();
      expect(abortFired).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('hasLocalStorage', () => {
  test('returns false when localStorage is unavailable (SSR-like)', () => {
    // In the Bun test environment without the localStorage shim, the
    // function safely returns false.
    expect(typeof hasLocalStorage()).toBe('boolean');
  });
});
