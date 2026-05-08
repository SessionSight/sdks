import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Server-driven session rotation.
 *
 * When the backend seals a session (analytics computed, archival pending),
 * it signals the SDK to rotate to a fresh sessionId via:
 *   - WebSocket: `{ type: 'rotate_session', reason }` message
 *   - HTTP: `{ rotate: true }` body on POST /v1/ingest response
 *
 * Both paths route through WorkerBridge.onRotate → SDK.rotateSession.
 */

const origWebSocket = (globalThis as any).WebSocket;
const origFetch = globalThis.fetch;

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

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = origWebSocket;
  globalThis.fetch = origFetch;
});

// ── Transport: WS rotate_session ─────────────────────────────────────

describe('Transport rotate_session handling', () => {
  test('fires onRotate with reason when WS sends rotate_session message', async () => {
    const { Transport } = await import('../src/transport.js');

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    const reasons: Array<string | undefined> = [];
    t.onRotate((reason) => { reasons.push(reason); });

    const ws = FakeWebSocket.instances[0]!;
    // Prime as ready first (the onmessage handler reads non-ready messages too,
    // but the SDK wiring routes rotate regardless of ready state).
    ws.emitMessage({ type: 'ready' });
    ws.emitMessage({ type: 'rotate_session', reason: 'session_sealed' });

    expect(reasons).toEqual(['session_sealed']);
  });

  test('fires onRotate when HTTP chunk response body has rotate:true', async () => {
    const { Transport } = await import('../src/transport.js');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepted: true, rotate: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })) as any;

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    const reasons: Array<string | undefined> = [];
    t.onRotate((reason) => { reasons.push(reason); });

    await (t as any).sendHttpChunk({
      sessionId: 's',
      propertyId: 'prop-1',
      visitorId: 'v',
      events: [{ type: 1 }],
      seqStart: 1,
      seqEnd: 1,
    });

    expect(reasons).toEqual(['http_sealed']);
  });

  test('does not fire onRotate when HTTP body has no rotate flag', async () => {
    const { Transport } = await import('../src/transport.js');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })) as any;

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    let fired = 0;
    t.onRotate(() => { fired++; });

    await (t as any).sendHttpChunk({
      sessionId: 's',
      propertyId: 'prop-1',
      visitorId: 'v',
      events: [{ type: 1 }],
      seqStart: 1,
      seqEnd: 1,
    });

    expect(fired).toBe(0);
  });
});

// ── WorkerBridge: worker rotate_session ──────────────────────────────

describe('WorkerBridge rotate_session handling', () => {
  test('invokes onRotate callback when worker posts rotate_session', async () => {
    let workerOnMessage: ((e: MessageEvent) => void) | null = null;
    const fakeWorker = {
      postMessage: () => {},
      terminate: () => {},
      set onmessage(fn: (e: MessageEvent) => void) { workerOnMessage = fn; },
      get onmessage() { return workerOnMessage!; },
      onerror: null as any,
    };

    mock.module('../src/worker-inline.js', () => ({
      createInlineWorker: () => fakeWorker,
    }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', 'vis-1');
    const reasons: Array<string | undefined> = [];
    bridge.onRotate((reason) => { reasons.push(reason); });

    workerOnMessage!({ data: { type: 'rotate_session', reason: 'session_sealed' } } as MessageEvent);

    expect(reasons).toEqual(['session_sealed']);
    bridge.destroy();
  });

  test('propagates onRotate to fallback transport when Workers unavailable', async () => {
    mock.module('../src/worker-inline.js', () => ({
      createInlineWorker: () => null, // forces fallback path
    }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', 'vis-1');
    const reasons: Array<string | undefined> = [];
    bridge.onRotate((reason) => { reasons.push(reason); });

    // The fallback Transport was created with a FakeWebSocket. Simulate the
    // server sending rotate_session over that socket.
    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage({ type: 'ready' });
    ws.emitMessage({ type: 'rotate_session', reason: 'session_sealed' });

    expect(reasons).toEqual(['session_sealed']);
    bridge.destroy();
  });
});

// ── Cookie helper ────────────────────────────────────────────────────

describe('session cookie helpers', () => {
  // Stub enough of document.cookie that writeSessionCookie / readSessionCookie
  // can round-trip. Each assignment to document.cookie in a real browser
  // appends / updates; for this test we only care that "last write wins", so
  // a simple last-value store is sufficient.
  const origDocument = (globalThis as any).document;
  const origLocation = (globalThis as any).location;

  beforeEach(() => {
    let cookieStore = '';
    Object.defineProperty(globalThis, 'document', {
      value: {
        get cookie() { return cookieStore; },
        set cookie(v: string) {
          // v is "name=value; path=/; ..." — strip attributes, keep name=value.
          const pair = v.split(';')[0]!.trim();
          const [name] = pair.split('=');
          // Remove any existing entry for this name, then append.
          const existing = cookieStore
            .split('; ')
            .filter(Boolean)
            .filter(c => !c.startsWith(`${name}=`));
          existing.push(pair);
          cookieStore = existing.join('; ');
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'http:' },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'document', {
      value: origDocument,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'location', {
      value: origLocation,
      writable: true,
      configurable: true,
    });
  });

  test('writeSessionCookie writes ss_sid and readSessionCookie roundtrips', async () => {
    const { writeSessionCookie, readSessionCookie } =
      await import('@sessionsight/sdk-shared');

    writeSessionCookie('sess-abc-123');

    expect(readSessionCookie()).toBe('sess-abc-123');
  });

  test('writeSessionCookie no-ops with empty sessionId', async () => {
    const { writeSessionCookie, readSessionCookie } =
      await import('@sessionsight/sdk-shared');

    writeSessionCookie('preset-value');
    writeSessionCookie('');

    // Prior value remains because writeSessionCookie bails on empty input.
    expect(readSessionCookie()).toBe('preset-value');
  });

  test('writeSessionCookie overwrites previous value (last-writer-wins)', async () => {
    const { writeSessionCookie, readSessionCookie } =
      await import('@sessionsight/sdk-shared');

    writeSessionCookie('first-id');
    writeSessionCookie('second-id');

    expect(readSessionCookie()).toBe('second-id');
  });
});
