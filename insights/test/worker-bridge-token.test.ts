import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * WorkerBridge visitor-token coordination.
 *
 * The worker tells the bridge about token state changes via postMessage
 * (rotate_visitor_token, visitor_token_rejected). The bridge owns
 * storage and bootstrap, and pushes the resulting state back to the
 * worker (set_visitor_token, set_visitor_id). These tests cover that
 * protocol end-to-end with a fake Worker. The actual worker.ts is
 * covered separately in worker-token.test.ts.
 */

// ── Token format matches the v1 backend output ───────────────────────
const VALID_TOKEN = 'v1.' + 'A'.repeat(11) + '.' + 'B'.repeat(43);
const VALID_TOKEN_2 = 'v1.' + 'C'.repeat(11) + '.' + 'D'.repeat(43);
const OLD_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEW_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

// ── Globals saved so afterEach restores them ─────────────────────────
const origWebSocket = (globalThis as any).WebSocket;
const origFetch = globalThis.fetch;
const origDocument = (globalThis as any).document;
const origLocalStorage = (globalThis as any).localStorage;
const origNavigator = (globalThis as any).navigator;
const origLocation = (globalThis as any).location;
const origWindow = (globalThis as any).window;

// In-memory storage substitutes, shared with the helpers below.
let storage = new Map<string, string>();
let cookieBag = new Map<string, string>();

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
}

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
  (globalThis as any).navigator = { doNotTrack: '0', sendBeacon: () => true };
  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/' };
  (globalThis as any).WebSocket = FakeWebSocket;
}

/**
 * Build a fake Worker that records every postMessage the bridge sends and
 * exposes its handleMessage handler so tests can simulate worker output.
 */
function createFakeWorker() {
  let onmessage: ((e: MessageEvent) => void) | null = null;
  const sent: any[] = [];
  const fakeWorker = {
    postMessage: (msg: any) => sent.push(msg),
    terminate: () => {},
    set onmessage(fn: (e: MessageEvent) => void) { onmessage = fn; },
    get onmessage() { return onmessage!; },
    onerror: null as any,
  };
  return {
    worker: fakeWorker,
    sent,
    emit(msg: any) { onmessage!({ data: msg } as MessageEvent); },
  };
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

// ── Init passes stored token to worker ─────────────────────────────

describe('WorkerBridge.init forwards stored token', () => {
  test('init message includes stored visitorToken', async () => {
    const { writeVisitorToken } = await import('@sessionsight/sdk-shared');
    writeVisitorToken(VALID_TOKEN);

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const initMsg = fake.sent.find(m => m.type === 'init');
    expect(initMsg).toBeTruthy();
    expect(initMsg.visitorToken).toBe(VALID_TOKEN);
    expect(initMsg.visitorId).toBe(OLD_ID);
    bridge.destroy();
  });

  test('init message omits visitorToken when none stored', async () => {
    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const initMsg = fake.sent.find(m => m.type === 'init');
    expect(initMsg.visitorToken).toBeUndefined();
    bridge.destroy();
  });
});

// ── rotate_visitor_token from worker persists via writeVisitorToken ──

describe('WorkerBridge relays rotate_visitor_token', () => {
  test('writes token to cookie + localStorage when worker posts rotate_visitor_token', async () => {
    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'rotate_visitor_token', visitorToken: VALID_TOKEN });

    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);
    bridge.destroy();
  });

  test('ignores malformed tokens from the worker (defensive)', async () => {
    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'rotate_visitor_token', visitorToken: 'not-a-valid-token' });

    expect(getStoredVisitorToken()).toBeNull();
    bridge.destroy();
  });
});

// ── visitor_token_rejected triggers bootstrap + swap back to worker ──
//
// This is the core recovery path: the worker couldn't send (401 or ws
// 4004), the bridge re-bootstraps with the current visitorId, and when
// the server refuses that id the bridge must swap everything (in-memory,
// storage, and the worker) to the new server-issued id before pushing
// the matching token.

describe('WorkerBridge handles visitor_token_rejected', () => {
  test('bootstraps with current visitorId and pushes new token to worker', async () => {
    let bootstrapBody: any = null;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapBody = JSON.parse(init.body);
        // Server accepts the cached id (not stale).
        return new Response(JSON.stringify({
          visitorId: OLD_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const { writeVisitorToken, getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    writeVisitorToken('v1.' + 'Z'.repeat(11) + '.' + 'Y'.repeat(43)); // stale
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    // Let the async recovery settle.
    await new Promise((r) => setTimeout(r, 10));

    // Cleared stale token before bootstrapping.
    expect(bootstrapBody?.clientVisitorId).toBe(OLD_ID);
    // Received the fresh token from the server.
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);

    // Pushed to worker. No id swap because server accepted the old id.
    const sentToken = fake.sent.find(m => m.type === 'set_visitor_token');
    const sentId = fake.sent.find(m => m.type === 'set_visitor_id');
    expect(sentToken?.visitorToken).toBe(VALID_TOKEN);
    expect(sentId).toBeUndefined();
    bridge.destroy();
  });

  test('swaps visitorId in storage + worker when server refuses the cached id', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        // Server issues a fresh id because the old one is claimed by
        // a different browser (or is the server-side orphan case).
        return new Response(JSON.stringify({
          visitorId: NEW_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const { getStoredVisitorToken } = await import('@sessionsight/sdk-shared');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    await new Promise((r) => setTimeout(r, 10));

    // New id persisted.
    expect(storage.get('sessionsight_visitor_id')).toBe(NEW_ID);
    expect(cookieBag.get('ss_vid')).toBe(NEW_ID);
    expect(getStoredVisitorToken()).toBe(VALID_TOKEN);

    // Bridge pushed BOTH set_visitor_id and set_visitor_token to the
    // worker, in that order, so the worker swaps its id before the next
    // flush carries the new token.
    const idMsgs = fake.sent.filter(m => m.type === 'set_visitor_id');
    const tokMsgs = fake.sent.filter(m => m.type === 'set_visitor_token');
    expect(idMsgs).toHaveLength(1);
    expect(tokMsgs).toHaveLength(1);
    expect(idMsgs[0].visitorId).toBe(NEW_ID);
    expect(tokMsgs[0].visitorToken).toBe(VALID_TOKEN);
    const idIdx = fake.sent.findIndex(m => m.type === 'set_visitor_id');
    const tokIdx = fake.sent.findIndex(m => m.type === 'set_visitor_token');
    expect(idIdx).toBeLessThan(tokIdx);

    // Next sendBeacon-style payload will use NEW_ID: the bridge's internal
    // visitorId has been swapped.
    expect((bridge as any).visitorId).toBe(NEW_ID);
    bridge.destroy();
  });

  test('dedupes concurrent rejection notifications', async () => {
    let bootstrapCalls = 0;
    // Bootstrap hangs long enough that the second rejection fires while
    // the first is still in flight.
    let resolveBootstrap: ((v: Response) => void) | null = null;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapCalls += 1;
        return new Promise<Response>((resolve) => { resolveBootstrap = resolve; });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_EXPIRED' });
    // Settle, but not long enough for bootstrap to resolve.
    await new Promise((r) => setTimeout(r, 5));

    expect(bootstrapCalls).toBe(1);

    // Finish the first bootstrap and let a fresh rejection trigger a new
    // bootstrap, proving the dedupe releases after completion.
    resolveBootstrap!(new Response(JSON.stringify({
      visitorId: OLD_ID, visitorToken: VALID_TOKEN, issuedAt: Date.now(),
    }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 10));

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    // Keep the second bootstrap pending.
    await new Promise((r) => setTimeout(r, 5));
    expect(bootstrapCalls).toBe(2);
    bridge.destroy();
  });

  test('bootstrap failure does not kill the bridge', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        return new Response('{}', { status: 500 });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    await new Promise((r) => setTimeout(r, 10));

    // Bridge is not killed; no set_visitor_token was sent (bootstrap
    // failed), but the next rejection will retry.
    expect(bridge.isKilled()).toBe(false);
    expect(fake.sent.some(m => m.type === 'set_visitor_token')).toBe(false);
    bridge.destroy();
  });
});

// ── Fallback Transport: bindings get wired ─────────────────────────
//
// When Workers are unavailable, WorkerBridge falls back to main-thread
// Transport. kickBootstrap in Transport needs access to the bridge's
// visitorId state (via setVisitorIdBindings) to pass clientVisitorId on
// bootstrap and propagate swaps; same shape as the worker path.

describe('WorkerBridge.initFallback wires Transport visitorId bindings', () => {
  test('fallback Transport receives get + onSwap callbacks', async () => {
    let bootstrapBody: any = null;
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          visitorId: NEW_ID,
          visitorToken: VALID_TOKEN_2,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      // First ingest → reject with REQUIRED to force kickBootstrap.
      return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => null }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    // Drive an HTTP send through the fallback transport.
    const transport = (bridge as any).fallbackTransport;
    await transport.sendHttpChunk({
      sessionId: 'sess-1',
      propertyId: 'prop-1',
      visitorId: OLD_ID,
      events: [{ type: 3, timestamp: 1 }],
    });

    // Bootstrap was called with the cached id so the server had a chance
    // to reuse it.
    expect(bootstrapBody?.clientVisitorId).toBe(OLD_ID);
    // The swap callback updated the bridge's visitorId, so a subsequent
    // sendBeacon payload would carry the new id.
    expect((bridge as any).visitorId).toBe(NEW_ID);
    // And persisted it.
    expect(storage.get('sessionsight_visitor_id')).toBe(NEW_ID);
    bridge.destroy();
  });
});

// ── onVisitorIdSwap fires on bootstrap recovery ─────────────────────
//
// recoverVisitorToken used to update only its private visitorId field;
// callers like Recorder.visitorId and the module-level storedVisitorId in
// index.ts kept stale ids forever, which broke getVisitorId() reads and
// caused server-driven rotateSession() to construct a new bridge with
// the wrong id (triggering another rejection loop).

describe('WorkerBridge.onVisitorIdSwap', () => {
  test('fires registered callbacks when bootstrap returns a different visitorId', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        return new Response(JSON.stringify({
          visitorId: NEW_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const swapped: string[] = [];
    bridge.onVisitorIdSwap((id) => swapped.push(id));
    // Multiple subscribers (Recorder + index.ts) must all fire.
    bridge.onVisitorIdSwap((id) => swapped.push(`b:${id}`));

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    await new Promise((r) => setTimeout(r, 10));

    expect(swapped).toEqual([NEW_ID, `b:${NEW_ID}`]);
    bridge.destroy();
  });

  test('does NOT fire callbacks when the server keeps the original id', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        return new Response(JSON.stringify({
          visitorId: OLD_ID, // server reused it
          visitorToken: VALID_TOKEN_2,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      return new Response('{}', { status: 202 });
    }) as any;

    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const swapped: string[] = [];
    bridge.onVisitorIdSwap((id) => swapped.push(id));

    fake.emit({ type: 'visitor_token_rejected', code: 'VISITOR_TOKEN_REQUIRED' });
    await new Promise((r) => setTimeout(r, 10));

    expect(swapped).toHaveLength(0);
    bridge.destroy();
  });

  test('fires from the fallback Transport path too', async () => {
    let bootstrapCalled = false;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/v1/sdk/visitor/bootstrap')) {
        bootstrapCalled = true;
        return new Response(JSON.stringify({
          visitorId: NEW_ID,
          visitorToken: VALID_TOKEN,
          issuedAt: Date.now(),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => null }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const swapped: string[] = [];
    bridge.onVisitorIdSwap((id) => swapped.push(id));

    const transport = (bridge as any).fallbackTransport;
    await transport.sendHttpChunk({
      sessionId: 'sess-1',
      propertyId: 'prop-1',
      visitorId: OLD_ID,
      events: [{ type: 3, timestamp: 1 }],
    });

    expect(bootstrapCalled).toBe(true);
    expect(swapped).toEqual([NEW_ID]);
    bridge.destroy();
  });
});

// ── M6: onKilled supports multiple subscribers ──────────────────────

describe('WorkerBridge.onKilled (M6)', () => {
  test('multiple registered callbacks all fire on killed', async () => {
    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const fired: string[] = [];
    bridge.onKilled(() => fired.push('a'));
    bridge.onKilled(() => fired.push('b'));

    fake.emit({ type: 'killed', reason: 'invalid_api_key' });

    expect(fired).toEqual(['a', 'b']);
    expect(bridge.isKilled()).toBe(true);
    bridge.destroy();
  });

  test('a throwing subscriber does not block later subscribers', async () => {
    const fake = createFakeWorker();
    mock.module('../src/worker-inline.js', () => ({ createInlineWorker: () => fake.worker }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');
    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', OLD_ID);

    const fired: string[] = [];
    bridge.onKilled(() => { throw new Error('first sub blew up'); });
    bridge.onKilled(() => fired.push('b'));

    fake.emit({ type: 'killed', reason: 'invalid_api_key' });

    expect(fired).toEqual(['b']);
    bridge.destroy();
  });
});
