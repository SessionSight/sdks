import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Tests for SDK-side rage click detection.
 *
 * The recorder maintains a circular buffer of the last 5 clicks. On each click,
 * if 3+ entries fall within 1s and 30px radius, it emits a `rage_click` custom
 * event tag. After firing the buffer is cleared so a single cluster can't
 * spam multiple emissions.
 */

// ── Browser globals ────────────────────────────────────────────────

let visibilityState = 'visible';
const listeners = new Map<string, Set<Function>>();

function addEventListener(event: string, fn: Function, _opts?: any) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}
function removeEventListener(event: string, fn: Function, _opts?: any) {
  listeners.get(event)?.delete(fn);
}

const origDocument = globalThis.document;
const origWindow = globalThis.window;
const origNavigator = globalThis.navigator;
const origHistory = (globalThis as any).history;
const origHistoryCtor = (globalThis as any).History;
const origCrypto = globalThis.crypto;

beforeEach(() => {
  visibilityState = 'visible';
  listeners.clear();

  (globalThis as any).document = {
    get visibilityState() { return visibilityState; },
    addEventListener,
    removeEventListener,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      style: {},
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
    }),
  };

  const historyProto = { pushState: () => {}, replaceState: () => {} };
  (globalThis as any).History = { prototype: historyProto };
  (globalThis as any).history = { ...historyProto };

  (globalThis as any).window = {
    location: { href: 'http://localhost/', pathname: '/', search: '', hash: '' },
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener,
    removeEventListener,
    history: (globalThis as any).history,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({}),
  };

  (globalThis as any).navigator = {
    language: 'en-US',
    sendBeacon: () => true,
  };

  (globalThis as any).crypto = {
    randomUUID: () => 'test-uuid',
  };
});

afterEach(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).history = origHistory;
  (globalThis as any).History = origHistoryCtor;
  (globalThis as any).crypto = origCrypto;
});

// ── rrweb stub ─────────────────────────────────────────────────────

mock.module('rrweb', () => ({
  record: () => () => {},
}));

// ── Bridge stub that captures emitted events ──────────────────────

const capturedEvents: any[] = [];

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    postEvent(e: any) { capturedEvents.push(e); }
    postMetadata() {}
    postIdentify() {}
    flush() {}
    sendBeacon() {}
    destroy() {}
    onKilled() {}
    onPrivacy() {}
    onQuotaExceeded() {}
    onRotate() {}
  },
}));

const { Recorder } = await import('../src/recorder.js');

function createRecorder() {
  const bridge = new (require('../src/worker-bridge.js').WorkerBridge)();
  const rec = new Recorder(bridge, 'test-prop', 'test-visitor');
  rec.start(true); // also calls beginRecording so events flow through bridge
  return rec;
}

function rageClickEvents() {
  return capturedEvents.filter(e => e.type === 5 && e.data?.tag === 'rage_click');
}

beforeEach(() => {
  capturedEvents.length = 0;
});

// ── Tests ──────────────────────────────────────────────────────────

describe('rage click detection', () => {
  test('does not emit for fewer than 3 clicks', () => {
    const rec = createRecorder();
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(100, 100);
    expect(rageClickEvents()).toHaveLength(0);
  });

  test('emits rage_click on the 3rd click within window/radius', () => {
    const rec = createRecorder();
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(105, 105);
    (rec as any).checkRageClick(110, 110);
    const events = rageClickEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data.payload.x).toBe(110);
    expect(events[0].data.payload.y).toBe(110);
    expect(events[0].data.payload.clickCount).toBeGreaterThanOrEqual(3);
    expect(events[0].data.payload.page).toBe('/');
  });

  test('does not emit when clicks are spread beyond 30px radius', () => {
    const rec = createRecorder();
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(200, 200);
    (rec as any).checkRageClick(300, 300);
    expect(rageClickEvents()).toHaveLength(0);
  });

  test('clears buffer after firing to prevent re-fire on next click', () => {
    const rec = createRecorder();
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(100, 100);
    expect(rageClickEvents()).toHaveLength(1);

    // A single 4th click should not emit again because the buffer was cleared
    (rec as any).checkRageClick(100, 100);
    expect(rageClickEvents()).toHaveLength(1);

    // Need 3 more nearby clicks to fire again
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(100, 100);
    expect(rageClickEvents()).toHaveLength(2);
  });

  test('does not emit when clicks are outside the 1s time window', async () => {
    const rec = createRecorder();
    (rec as any).checkRageClick(100, 100);
    (rec as any).checkRageClick(100, 100);
    // Wait > 1 second so the first two clicks fall out of the window
    await new Promise(r => setTimeout(r, 1100));
    (rec as any).checkRageClick(100, 100);
    expect(rageClickEvents()).toHaveLength(0);
  });

  test('circular buffer caps at 5 entries', () => {
    const rec = createRecorder();
    // Push 7 clicks far apart so they don't fire on their own
    for (let i = 0; i < 7; i++) {
      (rec as any).checkRageClick(i * 100, i * 100);
    }
    expect((rec as any).recentClicks.length).toBeLessThanOrEqual(5);
  });

  test('emits with the page pathname from window.location', () => {
    (globalThis as any).window.location.pathname = '/checkout';
    const rec = createRecorder();
    (rec as any).checkRageClick(50, 50);
    (rec as any).checkRageClick(50, 50);
    (rec as any).checkRageClick(50, 50);
    const events = rageClickEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data.payload.page).toBe('/checkout');
  });
});
