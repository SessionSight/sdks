import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test';

/**
 * Direct tests for `packages/insights/src/worker.ts`.
 *
 * Until now the worker had ZERO test coverage; it's bundled into a
 * string and only exercised end-to-end in a real browser. That made it
 * the hiding place for silent bugs like "any 401 kills the transport"
 * and "never reads rotateVisitorToken from HTTP responses".
 *
 * The worker module sets `self.onmessage` at top level and reads global
 * `fetch`/`WebSocket`. We polyfill those before importing, then drive
 * the protocol through `self.onmessage` and observe `self.postMessage`.
 *
 * Cross-test state: the module has top-level `let` bindings (buffer,
 * wsInFlight, scalar state). Each test starts with a fresh `init`
 * (which overwrites scalars), and beforeEach resets our FakeWebSocket
 * / fetch / postedMessages so one test never sees the previous one's
 * output. Buffer-residue between tests is handled explicitly per-test
 * where it matters.
 */

const VALID_TOKEN_A = 'v1.' + 'A'.repeat(11) + '.' + 'B'.repeat(43);
const VALID_TOKEN_B = 'v1.' + 'C'.repeat(11) + '.' + 'D'.repeat(43);
const VISITOR_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_ID = 'sess-worker-token';

// ── FakeWebSocket ───────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }

  markReady() {
    this.readyState = FakeWebSocket.OPEN;
    this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  fireClose(code: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

// ── Globals wiring ─────────────────────────────────────────────────

const origWebSocket = (globalThis as any).WebSocket;
const origFetch = globalThis.fetch;
const origSelf = (globalThis as any).self;
const origPostMessage = (globalThis as any).postMessage;

let postedMessages: any[] = [];
let fetchImpl: (url: string, init: any) => Promise<Response> = async () => new Response('{}', { status: 202 });

function resetFetch() {
  fetchImpl = async () => new Response('{}', { status: 202 });
}

function sendToWorker(msg: any) {
  (globalThis as any).self.onmessage({ data: msg });
}

function postedOfType(type: string): any[] {
  return postedMessages.filter(m => m?.type === type);
}

// Install globals ONCE, before the worker module runs its top-level code.
beforeAll(() => {
  (globalThis as any).self = globalThis;
  (globalThis as any).postMessage = (msg: any) => postedMessages.push(msg);
  (globalThis as any).WebSocket = FakeWebSocket;
  globalThis.fetch = ((...args: any[]) => fetchImpl(args[0], args[1])) as any;
});

afterAll(() => {
  (globalThis as any).self = origSelf;
  (globalThis as any).postMessage = origPostMessage;
  (globalThis as any).WebSocket = origWebSocket;
  globalThis.fetch = origFetch;
});

beforeEach(() => {
  postedMessages = [];
  FakeWebSocket.instances = [];
  resetFetch();
});

/**
 * Drive a fresh init into the worker. The worker's scalar state
 * (apiUrl, visitorId, token, etc.) gets overwritten; timers start
 * fresh. `flush-final` before each new init would also clear the flush
 * timer, but since init also re-creates it we'd leak. Leaking interval
 * timers doesn't affect assertions in these tests; Bun tears them down
 * on process exit.
 */
async function initWorker(opts: { visitorToken?: string } = {}) {
  await import('../src/worker.js');
  sendToWorker({
    type: 'init',
    apiUrl: 'http://localhost:3000',
    publicApiKey: 'pub_key',
    propertyId: 'prop-1',
    sessionId: SESSION_ID,
    visitorId: VISITOR_ID,
    ...(opts.visitorToken ? { visitorToken: opts.visitorToken } : {}),
  });
}

// ── WS URL token attachment ────────────────────────────────────────

describe('worker WS URL carries visitorToken when initialized with one', () => {
  test('attaches visitorToken= query param when init includes token', async () => {
    await initWorker({ visitorToken: VALID_TOKEN_A });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(ws.url).toContain(`visitorToken=${encodeURIComponent(VALID_TOKEN_A)}`);
  });

  test('omits visitorToken= query param when init has no token', async () => {
    await initWorker();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(ws.url).not.toContain('visitorToken');
  });
});

// ── WS rotate_visitor_token message relays to main thread ──────────

describe('worker WS rotate_visitor_token handling', () => {
  test('updates local token and forwards to main thread', async () => {
    await initWorker();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.markReady();
    ws.emit({ type: 'rotate_visitor_token', visitorToken: VALID_TOKEN_A });

    const relayed = postedOfType('rotate_visitor_token');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].visitorToken).toBe(VALID_TOKEN_A);

    // Subsequent WS flushes now carry the token in the payload. Send one
    // event, flush, and check the sent frame.
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 1 }, seq: 1 });
    sendToWorker({ type: 'flush' });
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]!);
    expect(frame.visitorToken).toBe(VALID_TOKEN_A);
  });
});

// ── WS close code 4004 → token rejected notification ───────────────

describe('worker WS close 4004 surfaces visitor_token_rejected', () => {
  test('clears token, posts visitor_token_rejected, schedules reconnect', async () => {
    await initWorker({ visitorToken: VALID_TOKEN_A });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.fireClose(4004, 'visitor_token_required');

    const rejections = postedOfType('visitor_token_rejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0].code).toBe('visitor_token_required');

    // Did NOT post 'killed'; recoverable.
    expect(postedOfType('killed')).toHaveLength(0);
  });

  test('4001 still kills (API key invalid path unchanged)', async () => {
    await initWorker();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.fireClose(4001);

    const killed = postedOfType('killed');
    expect(killed).toHaveLength(1);
    expect(killed[0].reason).toBe('invalid_api_key');
  });
});

// ── HTTP flush: token in body, rotateVisitorToken forwarded ────────

describe('worker HTTP flush carries token and handles rotateVisitorToken', () => {
  test('includes visitorToken in HTTP body and reads rotateVisitorToken from response', async () => {
    let captured: any = null;
    fetchImpl = async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ accepted: true, rotateVisitorToken: VALID_TOKEN_A }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    };

    await initWorker();
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 1 }, seq: 1 });
    sendToWorker({ type: 'flush' });
    // Allow sendHttpAsync's awaited path to resolve.
    await new Promise((r) => setTimeout(r, 10));

    // First flush: no token. Response carried a fresh token → forwarded.
    expect(captured.visitorToken).toBeUndefined();
    const relayed = postedOfType('rotate_visitor_token');
    expect(relayed.some(m => m.visitorToken === VALID_TOKEN_A)).toBe(true);

    // Next flush should now carry the freshly-stored token.
    let secondBody: any = null;
    fetchImpl = async (_url, init) => {
      secondBody = JSON.parse(init.body);
      return new Response('{}', { status: 202 });
    };
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 2 }, seq: 2 });
    sendToWorker({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondBody.visitorToken).toBe(VALID_TOKEN_A);
  });
});

// ── HTTP rejection: VISITOR_TOKEN_REQUIRED requeues instead of killing ──

describe('worker HTTP token rejection requeues events, never kills', () => {
  test('VISITOR_TOKEN_REQUIRED posts rejection, does not ack, requeues for retry', async () => {
    let ingestCalls = 0;
    let secondBody: any = null;
    fetchImpl = async (_url, init) => {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_REQUIRED' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      secondBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    await initWorker();
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 1 }, seq: 100 });
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 2 }, seq: 101 });
    sendToWorker({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 10));

    // Worker posted a rejection and did NOT ack the events.
    expect(postedOfType('visitor_token_rejected').some(m => m.code === 'VISITOR_TOKEN_REQUIRED')).toBe(true);
    expect(postedOfType('ack').some(m => m.seq === 101)).toBe(false);
    // Transport is alive; no `killed` message.
    expect(postedOfType('killed')).toHaveLength(0);

    // Simulate the main thread pushing a fresh token. The worker's
    // handler reconnects WS and (after a short deadline so the WS
    // `ready` path can win) flushes the requeued buffer via HTTP, which
    // is where the second HTTP call comes from.
    postedMessages = []; // ignore earlier messages
    sendToWorker({ type: 'set_visitor_token', visitorToken: VALID_TOKEN_A });
    await new Promise((r) => setTimeout(r, 200));

    expect(ingestCalls).toBe(2);
    expect(secondBody.visitorToken).toBe(VALID_TOKEN_A);
    // The requeued events are the original ones (by event timestamp).
    expect(secondBody.events).toHaveLength(2);
    expect(secondBody.events.map((e: any) => e.timestamp)).toEqual([1, 2]);
    // And now they ack (seqEnd=101).
    expect(postedOfType('ack').some(m => m.seq === 101)).toBe(true);
  });

  test('VISITOR_TOKEN_INVALID also requeues (same recoverable path)', async () => {
    let ingestCalls = 0;
    fetchImpl = async (_url, _init) => {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        return new Response(JSON.stringify({ error: 'x', code: 'VISITOR_TOKEN_INVALID' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };

    await initWorker({ visitorToken: VALID_TOKEN_A });
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 3 }, seq: 200 });
    sendToWorker({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 10));

    expect(postedOfType('visitor_token_rejected').some(m => m.code === 'VISITOR_TOKEN_INVALID')).toBe(true);
    expect(postedOfType('killed')).toHaveLength(0);

    // After a fresh token, events should reach the server. The worker's
    // post-recovery flush is now deferred 100ms so a successful WS handshake
    // can win over the HTTP fallback; in this test the WS connect is mocked
    // out, so the HTTP fallback path takes over after the deadline.
    postedMessages = [];
    sendToWorker({ type: 'set_visitor_token', visitorToken: VALID_TOKEN_B });
    await new Promise((r) => setTimeout(r, 200));
    expect(ingestCalls).toBe(2);
  });

  test('non-token 401 still kills (invalid API key)', async () => {
    fetchImpl = async () => new Response('{}', { status: 401 }); // no token code
    await initWorker();
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 4 }, seq: 300 });
    sendToWorker({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 10));

    expect(postedOfType('killed').some(m => m.reason === 'invalid_api_key')).toBe(true);
  });
});

// ── set_visitor_id swap ────────────────────────────────────────────

describe('worker set_visitor_id swap', () => {
  test('subsequent payloads use the new visitorId', async () => {
    const NEW_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
    let captured: any = null;
    fetchImpl = async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response('{}', { status: 202 });
    };

    await initWorker();
    sendToWorker({ type: 'set_visitor_id', visitorId: NEW_ID });
    sendToWorker({ type: 'event', event: { type: 3, timestamp: 1 }, seq: 500 });
    sendToWorker({ type: 'flush' });
    await new Promise((r) => setTimeout(r, 10));

    expect(captured.visitorId).toBe(NEW_ID);
  });
});

// ── set_visitor_token reconnects WS and flushes buffered events ────

describe('worker set_visitor_token reconnects WS with the new token', () => {
  test('WS reconnects with visitorToken= in URL after a set_visitor_token', async () => {
    await initWorker();
    const wsBefore = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(wsBefore.url).not.toContain('visitorToken');

    sendToWorker({ type: 'set_visitor_token', visitorToken: VALID_TOKEN_A });
    const wsAfter = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(wsAfter).not.toBe(wsBefore);
    expect(wsAfter.url).toContain(`visitorToken=${encodeURIComponent(VALID_TOKEN_A)}`);
  });
});
