import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Graceful quota-exceeded handling.
 *
 * When the server signals that the monthly session quota has been exceeded,
 * the SDK should stop recording without killing the API key. The signal
 * arrives via two paths:
 *   - WebSocket: `{ type: 'quota_exceeded' }` message
 *   - HTTP: 429 status code on POST /v1/ingest
 *
 * Both paths route through WorkerBridge's `onQuotaExceeded` callback, which
 * is also propagated to the fallback Transport when Web Workers are
 * unavailable.
 */

// ── Global stubs ─────────────────────────────────────────────────────

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

  // Test helpers
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

// ── Transport: WS quota_exceeded message ─────────────────────────────

describe('Transport quota_exceeded handling', () => {
  test('fires onQuotaExceeded when WS sends quota_exceeded message', async () => {
    const { Transport } = await import('../src/transport.js');

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    let fired = 0;
    t.onQuotaExceeded(() => { fired++; });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage({ type: 'quota_exceeded' });

    expect(fired).toBe(1);
  });

  test('ignores legacy error payload after protocol change', async () => {
    const { Transport } = await import('../src/transport.js');

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    let fired = 0;
    t.onQuotaExceeded(() => { fired++; });

    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage({ type: 'error', code: 'QUOTA_EXCEEDED' });

    expect(fired).toBe(0);
  });

  test('fires onQuotaExceeded when HTTP chunk returns 429', async () => {
    const { Transport } = await import('../src/transport.js');

    globalThis.fetch = (async () => new Response(null, { status: 429 })) as any;

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    let fired = 0;
    t.onQuotaExceeded(() => { fired++; });

    // Force HTTP path: mark WS not ready by sending oversized chunk path.
    // Easiest: directly invoke the HTTP chunk method via sendPayload with WS unready.
    await (t as any).sendHttpChunk({
      sessionId: 's',
      propertyId: 'prop-1',
      visitorId: 'v',
      events: [{ type: 1 }],
      seqStart: 1,
      seqEnd: 1,
    });

    expect(fired).toBe(1);
  });

  test('429 does not mark transport as killed', async () => {
    const { Transport } = await import('../src/transport.js');

    globalThis.fetch = (async () => new Response(null, { status: 429 })) as any;

    const t = new Transport('http://localhost:3000', 'pub_key', 'prop-1');
    t.onQuotaExceeded(() => {});

    await (t as any).sendHttpChunk({
      sessionId: 's',
      propertyId: 'prop-1',
      visitorId: 'v',
      events: [{ type: 1 }],
      seqStart: 1,
      seqEnd: 1,
    });

    expect(t.isKilled()).toBe(false);
  });
});

// ── WorkerBridge: worker message + fallback propagation ──────────────

describe('WorkerBridge quota_exceeded handling', () => {
  test('invokes callback when worker posts quota_exceeded message', async () => {
    // Stub the inline worker factory so the bridge uses a controllable mock
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
    let fired = 0;
    bridge.onQuotaExceeded(() => { fired++; });

    // Simulate worker posting quota_exceeded
    workerOnMessage!({ data: { type: 'quota_exceeded' } } as MessageEvent);

    expect(fired).toBe(1);
    bridge.destroy();
  });

  test('propagates callback to fallback transport when Workers unavailable', async () => {
    mock.module('../src/worker-inline.js', () => ({
      createInlineWorker: () => null,
    }));

    const { WorkerBridge } = await import('../src/worker-bridge.js');

    const bridge = new WorkerBridge('http://localhost:3000', 'pub_key', 'prop-1', 'sess-1', 'vis-1');
    let fired = 0;
    bridge.onQuotaExceeded(() => { fired++; });

    // The fallback transport holds a real WebSocket via the FakeWebSocket stub.
    // The bridge's fallback transport should have registered the callback.
    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws!.emitMessage({ type: 'quota_exceeded' });

    expect(fired).toBe(1);
    bridge.destroy();
  });
});
