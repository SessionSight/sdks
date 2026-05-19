import { test, expect, describe, beforeEach, afterEach } from 'bun:test';

// ── Fakes ──────────────────────────────────────────────────────────

const origWebSocket = (globalThis as any).WebSocket;
const origFetch = globalThis.fetch;
const origDocument = (globalThis as any).document;
const origLocalStorage = (globalThis as any).localStorage;
const origNavigator = (globalThis as any).navigator;
const origLocation = (globalThis as any).location;
const origWindow = (globalThis as any).window;

// Token matching the v1 format the backend produces: v1.<b64>.<b64>, ~58 chars.
const VALID_TOKEN = 'v1.' + 'A'.repeat(11) + '.' + 'B'.repeat(43);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(_data: string) {}
  close() {}
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

// In-memory localStorage + document.cookie substitutes.
let storage = new Map<string, string>();
let cookieBag = new Map<string, string>();

function installBrowserEnv() {
  storage = new Map();
  cookieBag = new Map();
  (globalThis as any).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
    clear: () => { storage.clear(); },
  };
  (globalThis as any).window = globalThis;
  (globalThis as any).document = {
    get cookie() {
      return Array.from(cookieBag.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(raw: string) {
      // Parse "name=value; [attrs...]" and respect max-age=0 as a delete.
      const firstPair = raw.split(';')[0]?.trim() ?? '';
      const eq = firstPair.indexOf('=');
      if (eq < 0) return;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      const attrs = raw.split(';').slice(1).map(s => s.trim().toLowerCase());
      if (attrs.some(a => a.startsWith('max-age=0'))) {
        cookieBag.delete(name);
        return;
      }
      cookieBag.set(name, value);
    },
    addEventListener: () => {},
  };
  (globalThis as any).navigator = {
    doNotTrack: '0',
    sendBeacon: () => true,
  };
  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/' };
  (globalThis as any).WebSocket = FakeWebSocket;
}

beforeEach(() => {
  installBrowserEnv();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  (globalThis as any).WebSocket = origWebSocket;
  globalThis.fetch = origFetch;
  (globalThis as any).document = origDocument;
  (globalThis as any).localStorage = origLocalStorage;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).location = origLocation;
  (globalThis as any).window = origWindow;
});

// ── sdk-shared token storage ───────────────────────────────────────

describe('visitor token storage (sdk-shared)', () => {
  test('writeVisitorToken + getStoredVisitorToken round-trip', async () => {
    const { writeVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');
    writeVisitorToken(VALID_TOKEN);
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
  });

  test('rejects malformed tokens at write', async () => {
    const { writeVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');
    writeVisitorToken('not-a-valid-token');
    expect(getStoredVisitorToken()).toBeNull();
  });

  test('clearVisitorToken removes stored value', async () => {
    const { writeVisitorToken, clearVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');
    writeVisitorToken(VALID_TOKEN);
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
    clearVisitorToken();
    expect(getStoredVisitorToken()).toBeNull();
  });

  test('writeVisitorToken is suppressed under DNT', async () => {
    (globalThis as any).navigator = { doNotTrack: '1' };
    const { writeVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');
    writeVisitorToken(VALID_TOKEN);
    expect(getStoredVisitorToken()).toBeNull();
  });
});

// ── Transport: rotateVisitorToken from HTTP response ──────────────

describe('Transport HTTP rotateVisitorToken handling', () => {
  test('persists rotateVisitorToken from HTTP ingest response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepted: true, rotateVisitorToken: VALID_TOKEN }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })) as any;

    const { Transport } = await import('../src/transport.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: 'v-1',
      events: [{ type: 3, timestamp: 1 }],
    });

    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
  });

  test('VISITOR_TOKEN_REQUIRED clears, bootstraps, and retries the chunk exactly once', async () => {
    let ingestCalls = 0;
    let bootstrapCalls = 0;
    let acceptOnRetry = true;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapCalls += 1;
        return new Response(JSON.stringify({
          visitorId: '11111111-1111-1111-1111-111111111111',
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      ingestCalls += 1;
      if (acceptOnRetry && ingestCalls > 1) {
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const { Transport } = await import('../src/transport.js');
    const { writeVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    writeVisitorToken(VALID_TOKEN);
    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: 'v-1',
      events: [{ type: 3, timestamp: 1 }],
    });

    // Exactly 2 ingest calls (original + one retry) and 1 bootstrap.
    expect(ingestCalls).toBe(2);
    expect(bootstrapCalls).toBe(1);
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
  });

  test('VISITOR_TOKEN_REQUIRED retries at most once even if server keeps rejecting', async () => {
    let ingestCalls = 0;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        return new Response(JSON.stringify({
          visitorId: '11111111-1111-1111-1111-111111111111',
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      ingestCalls += 1;
      return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const { Transport } = await import('../src/transport.js');
    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: 'v-1',
      events: [{ type: 3, timestamp: 1 }],
    });

    // Original + one retry = 2. No infinite loop.
    expect(ingestCalls).toBe(2);
  });

  test('VISITOR_TOKEN_INVALID clears token and does NOT retry the rejected payload', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        return new Response(JSON.stringify({
          visitorId: '22222222-2222-2222-2222-222222222222',
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_INVALID' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const { Transport } = await import('../src/transport.js');

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: 'v-1',
      events: [{ type: 3, timestamp: 1 }],
    });
    await new Promise((r) => setTimeout(r, 10));

    // Exactly one ingest call (no retry) plus one bootstrap.
    const ingestCalls = calls.filter(c => c.includes('/v1/ingest'));
    const bootstrapCalls = calls.filter(c => c.includes('/v1/sdk/visitor/bootstrap'));
    expect(ingestCalls.length).toBe(1);
    expect(bootstrapCalls.length).toBe(1);
  });
});

// ── Transport: token attached to outbound requests ─────────────────

describe('Transport attaches visitor token', () => {
  test('HTTP send includes visitorToken field when stored', async () => {
    let captured: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response('{}', { status: 202 });
    }) as any;

    const { Transport } = await import('../src/transport.js');
    const { writeVisitorToken } = await import('@sessionsight/sdk-shared');

    writeVisitorToken(VALID_TOKEN);
    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: 'v-1',
      events: [{ type: 3, timestamp: 1 }],
    });

    expect(captured?.visitorToken).toBe(VALID_TOKEN);
  });

  test('WS URL includes visitorToken query param when stored', async () => {
    const { Transport } = await import('../src/transport.js');
    const { writeVisitorToken } = await import('@sessionsight/sdk-shared');

    writeVisitorToken(VALID_TOKEN);
    new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain(`visitorToken=${encodeURIComponent(VALID_TOKEN)}`);
  });

  test('WS URL omits visitorToken query param when none stored', async () => {
    const { Transport } = await import('../src/transport.js');
    new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).not.toContain('visitorToken');
  });
});

// ── Transport: rotate_visitor_token WS message ─────────────────────

describe('Transport WS rotate_visitor_token handling', () => {
  test('persists token from WS rotate_visitor_token message', async () => {
    const { Transport } = await import('../src/transport.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    const ws = FakeWebSocket.instances[0]!;
    ws.emit({ type: 'ready' });
    ws.emit({ type: 'rotate_visitor_token', visitorToken: VALID_TOKEN });

    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
  });
});

// ── writeVisitorId (sdk-shared) ────────────────────────────────────

describe('writeVisitorId (sdk-shared)', () => {
  const VALID_UUID_A = '11111111-2222-3333-4444-555555555555';
  const VALID_UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  test('round-trips to cookie + localStorage', async () => {
    const { writeVisitorId, getOrCreateVisitorId } = await import('@sessionsight/sdk-shared');
    writeVisitorId(VALID_UUID_A);
    expect(storage.get('sessionsight_visitor_id')).toBe(VALID_UUID_A);
    expect(cookieBag.get('ss_vid')).toBe(VALID_UUID_A);
    // getOrCreateVisitorId should surface the written id (cookie wins).
    expect(getOrCreateVisitorId()).toBe(VALID_UUID_A);
  });

  test('overwrites a previously stored id', async () => {
    const { writeVisitorId } = await import('@sessionsight/sdk-shared');
    writeVisitorId(VALID_UUID_A);
    writeVisitorId(VALID_UUID_B);
    expect(storage.get('sessionsight_visitor_id')).toBe(VALID_UUID_B);
    expect(cookieBag.get('ss_vid')).toBe(VALID_UUID_B);
  });

  test('rejects malformed input (no write)', async () => {
    const { writeVisitorId } = await import('@sessionsight/sdk-shared');
    writeVisitorId('not-a-uuid');
    expect(storage.has('sessionsight_visitor_id')).toBe(false);
    expect(cookieBag.has('ss_vid')).toBe(false);
  });

  test('suppressed under DNT', async () => {
    (globalThis as any).navigator = { doNotTrack: '1' };
    const { writeVisitorId } = await import('@sessionsight/sdk-shared');
    writeVisitorId(VALID_UUID_A);
    expect(storage.has('sessionsight_visitor_id')).toBe(false);
    expect(cookieBag.has('ss_vid')).toBe(false);
  });
});

// ── Transport: visitorId swap on REQUIRED retry ────────────────────
//
// kickBootstrap now passes clientVisitorId so the server can keep reusing
// the cached id when it's still unclaimed. When the server refuses (stale
// claim from a prior session), it mints a fresh UUID. The retry must then
// send THAT id, not the original one. Otherwise the freshly-minted token
// (bound to the new id) would fail verification against the old id.

describe('Transport visitorId swap on REQUIRED retry', () => {
  const OLD_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const NEW_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

  test('kickBootstrap passes clientVisitorId and swap rewrites retry payload', async () => {
    const ingestPayloads: any[] = [];
    let bootstrapBody: any = null;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          visitorId: NEW_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const payload = JSON.parse(init.body);
      ingestPayloads.push(payload);
      // First call: reject with REQUIRED so transport re-bootstraps.
      if (ingestPayloads.length === 1) {
        return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as any;

    const { Transport } = await import('../src/transport.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    let currentId = OLD_ID;
    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    t.setVisitorIdBindings(() => currentId, (id) => { currentId = id; });

    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: OLD_ID,
      events: [{ type: 3, timestamp: 1 }],
    });

    // Original + retry.
    expect(ingestPayloads.length).toBe(2);
    expect(ingestPayloads[0].visitorId).toBe(OLD_ID);
    // Retry uses the server-issued id, not the original.
    expect(ingestPayloads[1].visitorId).toBe(NEW_ID);
    // Bootstrap was called with the cached id so the server could try
    // reusing it.
    expect(bootstrapBody?.clientVisitorId).toBe(OLD_ID);
    // Owner's local id was updated via the swap callback.
    expect(currentId).toBe(NEW_ID);
    // Persisted too; future requests from any other code path use the
    // new id.
    expect(storage.get('sessionsight_visitor_id')).toBe(NEW_ID);
    expect(cookieBag.get('ss_vid')).toBe(NEW_ID);
    // Fresh token stored.
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
  });

  test('no swap when server accepts the cached clientVisitorId', async () => {
    const ingestPayloads: any[] = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        // Server reuses the id we sent.
        return new Response(JSON.stringify({
          visitorId: OLD_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      const payload = JSON.parse(init.body);
      ingestPayloads.push(payload);
      if (ingestPayloads.length === 1) {
        return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as any;

    const { Transport } = await import('../src/transport.js');

    let currentId = OLD_ID;
    let swapCount = 0;
    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    t.setVisitorIdBindings(() => currentId, (id) => { swapCount += 1; currentId = id; });

    await (t as any).sendHttpChunk({
      sessionId: 's-1',
      propertyId: 'prop-1',
      visitorId: OLD_ID,
      events: [{ type: 3, timestamp: 1 }],
    });

    expect(swapCount).toBe(0);
    expect(currentId).toBe(OLD_ID);
    expect(ingestPayloads[1].visitorId).toBe(OLD_ID);
  });
});
