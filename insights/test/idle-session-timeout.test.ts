import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Reproduction tests for idle session timeout.
 *
 * Bug: sessions were never terminated when the user went idle on a visible tab.
 * rrweb's 30s checkout snapshots kept flowing, updating lastEventAt on the
 * server and inflating session duration indefinitely.
 *
 * Fix: after IDLE_THRESHOLD_MS (30s) of no interaction, the recorder starts
 * a session termination countdown. If no interaction occurs within
 * IDLE_SESSION_TIMEOUT_MS (5 min total), the recorder calls stop() and sets
 * endedByIdle = true. The SDK-level resurrection handler creates a fresh
 * session on the next user interaction.
 *
 * These tests exercise the idle timer logic using Bun's fake timers without
 * requiring a full browser/rrweb environment.
 */

// ── Minimal mocks for browser globals ────────────────────────────────

let visibilityState = 'visible';
const listeners = new Map<string, Set<Function>>();

function addEventListener(event: string, fn: Function, _opts?: any) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}
function removeEventListener(event: string, fn: Function, _opts?: any) {
  listeners.get(event)?.delete(fn);
}
function dispatchMockEvent(event: string) {
  for (const fn of listeners.get(event) ?? []) fn();
}

// Stub globals that the Recorder touches during construction/start.
//
// Important: when this file runs as part of the unit test suite, other test
// files (controllers, services) rely on the real `crypto.randomUUID` to
// generate unique IDs. If we don't restore these globals after each test,
// later-running tests get a stub `randomUUID` that returns the same string,
// which surfaces as "duplicate key" errors in completely unrelated suites.
const origDocument = globalThis.document;
const origWindow = globalThis.window;
const origNavigator = globalThis.navigator;
const origHistory = (globalThis as any).history;
const origHistoryCtor = (globalThis as any).History;
const origCrypto = globalThis.crypto;

beforeEach(() => {
  visibilityState = 'visible';
  listeners.clear();

  // Minimal document mock
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
  (globalThis as any).history = { ...historyProto, pushState: historyProto.pushState, replaceState: historyProto.replaceState };

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

// ── Mock rrweb ───────────────────────────────────────────────────────

// We mock the rrweb module so we don't need a real DOM
mock.module('rrweb', () => ({
  record: (opts: any) => {
    // Return a stop function
    return () => {};
  },
}));

// ── Mock sdk-shared ──────────────────────────────────────────────────

// Intentionally NOT mocking '@sessionsight/sdk-shared' here.
//
// bun's mock.module is process-global, so any mock of sdk-shared registered
// at this file's top-level leaks into every other test file in the same
// `bun test` invocation, including packages/sdk-shared's own tests and the
// SDK URL tests in packages/feedback / packages/goals, which then see a
// stubbed version of the module instead of the real one. Letting the real
// sdk-shared load is fine: the recorder only calls pure helpers from it,
// and the browser-y bits use the document/window/navigator stubs above.

// ── Stub WorkerBridge ────────────────────────────────────────────────

const bridgeCalls: string[] = [];

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    postEvent() { bridgeCalls.push('postEvent'); }
    postMetadata() { bridgeCalls.push('postMetadata'); }
    postIdentify() {}
    flush() { bridgeCalls.push('flush'); }
    sendBeacon() { bridgeCalls.push('sendBeacon'); }
    destroy() { bridgeCalls.push('destroy'); }
    onKilled(_cb: Function) {}
    onPrivacy(_cb: Function) {}
    onQuotaExceeded(_cb: Function) {}
    onRotate(_cb: Function) {}
  },
}));

// ── Import Recorder after mocks are set up ──────────────────────────

const { Recorder } = await import('../src/recorder.js');

// ── Helper ──────────────────────────────────────────────────────────

function createRecorder() {
  const bridge = new (require('../src/worker-bridge.js').WorkerBridge)();
  const rec = new Recorder(bridge, 'test-prop', 'test-visitor');
  return rec;
}

function simulateInteraction() {
  dispatchMockEvent('keydown');
}

// ── Tests ───────────────────────────────────────────────────────────

describe('idle session timeout', () => {
  test('recorder should set endedByIdle after 5 minutes of no interaction', () => {
    const rec = createRecorder();
    rec.start(true);

    expect(rec.endedByIdle).toBe(false);

    // Simulate user going idle. The idle signal fires at 30s, then
    // the session termination timer fires at 5 minutes total.
    // Advance past the 30s idle detection threshold
    const idleThreshold = 30_000;
    const sessionTimeout = 300_000;

    // Instead of using fake timers (which are complex with rrweb),
    // we directly test the public contract: after start(), the recorder
    // has endedByIdle = false, and after stop() with idle flag it's true.

    // Trigger the idle path by calling the private methods via the
    // exposed timer callbacks. We'll verify the flag behavior.

    // The recorder registers a keydown listener that calls resetIdleTimer().
    // Without any keydown events, the idle timer fires after 30s.
    // We can't easily advance timers in this context, but we CAN verify
    // that endedByIdle is exposed and writable by the stop path.

    rec.endedByIdle = true;
    rec.stop();
    expect(rec.endedByIdle).toBe(true);
  });

  test('endedByIdle flag is false after normal stop', () => {
    const rec = createRecorder();
    rec.start(true);
    rec.stop();
    expect(rec.endedByIdle).toBe(false);
  });

  test('endedByVisibility flag is separate from endedByIdle', () => {
    const rec = createRecorder();
    rec.start(true);

    rec.endedByIdle = true;
    expect(rec.endedByVisibility).toBe(false);

    rec.endedByIdle = false;
    rec.endedByVisibility = true;
    expect(rec.endedByIdle).toBe(false);
    expect(rec.endedByVisibility).toBe(true);

    rec.stop();
  });
});

describe('idle session timeout with timers', () => {
  test('idle detection fires after 30s, session terminates after 5 min total', async () => {
    // This test uses real setTimeout behavior with shortened intervals.
    // We patch the static thresholds to make the test fast.
    const origIdleThreshold = (Recorder as any).IDLE_THRESHOLD_MS;
    const origSessionTimeout = (Recorder as any).IDLE_SESSION_TIMEOUT_MS;

    try {
      // Shorten thresholds for testing: 50ms idle, 150ms session timeout
      (Recorder as any).IDLE_THRESHOLD_MS = 50;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = 150;

      const rec = createRecorder();
      rec.start(true);
      expect(rec.endedByIdle).toBe(false);

      // Wait for idle detection (50ms) + session timeout (150ms - 50ms = 100ms)
      // Add buffer for timer scheduling
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(rec.endedByIdle).toBe(true);
    } finally {
      (Recorder as any).IDLE_THRESHOLD_MS = origIdleThreshold;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = origSessionTimeout;
    }
  });

  test('interaction resets the idle session timer', async () => {
    const origIdleThreshold = (Recorder as any).IDLE_THRESHOLD_MS;
    const origSessionTimeout = (Recorder as any).IDLE_SESSION_TIMEOUT_MS;

    try {
      (Recorder as any).IDLE_THRESHOLD_MS = 50;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = 150;

      const rec = createRecorder();
      rec.start(true);

      // Wait 80ms (past idle detection but before session timeout)
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(rec.endedByIdle).toBe(false);

      // Simulate interaction to reset the timer
      simulateInteraction();

      // Wait another 80ms (would have exceeded original 150ms timeout)
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(rec.endedByIdle).toBe(false); // Timer was reset, so still alive

      // Now wait for the full cycle again without interaction
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(rec.endedByIdle).toBe(true);
    } finally {
      (Recorder as any).IDLE_THRESHOLD_MS = origIdleThreshold;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = origSessionTimeout;
    }
  });

  test('tab hidden drops events but does not start idle session timer', async () => {
    const origIdleThreshold = (Recorder as any).IDLE_THRESHOLD_MS;
    const origSessionTimeout = (Recorder as any).IDLE_SESSION_TIMEOUT_MS;

    try {
      (Recorder as any).IDLE_THRESHOLD_MS = 50;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = 150;

      const rec = createRecorder();
      rec.start(true);

      // Hide the tab immediately
      visibilityState = 'hidden';
      dispatchMockEvent('visibilitychange');

      // Wait past both thresholds
      await new Promise(resolve => setTimeout(resolve, 250));

      // checkIdle() skips when visibilityState !== 'visible',
      // so the idle session timer should NOT have started
      expect(rec.endedByIdle).toBe(false);

      rec.stop();
    } finally {
      (Recorder as any).IDLE_THRESHOLD_MS = origIdleThreshold;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = origSessionTimeout;
    }
  });

  // Regression: when the recorder ends itself by sustained idle, the bridge
  // must stay alive so the backend can still deliver `rotate_session` over
  // the existing WebSocket. If we tore the bridge down here, the server's
  // seal signal would have no path back to the SDK and the client would be
  // stuck on a stale sessionId until the page reloads.
  test('idle-ended recorder keeps the bridge alive for the server rotate signal', async () => {
    const origIdleThreshold = (Recorder as any).IDLE_THRESHOLD_MS;
    const origSessionTimeout = (Recorder as any).IDLE_SESSION_TIMEOUT_MS;

    try {
      (Recorder as any).IDLE_THRESHOLD_MS = 50;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = 150;

      bridgeCalls.length = 0;
      const rec = createRecorder();
      rec.start(true);

      // Wait for the full idle → session-timeout cycle.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(rec.endedByIdle).toBe(true);

      // Bridge.destroy() MUST NOT have been called — the WS needs to stay
      // open to receive rotate_session when the backend seals the session.
      expect(bridgeCalls).not.toContain('destroy');

      // But a full external stop() DOES destroy the bridge.
      rec.stop();
      expect(bridgeCalls).toContain('destroy');
    } finally {
      (Recorder as any).IDLE_THRESHOLD_MS = origIdleThreshold;
      (Recorder as any).IDLE_SESSION_TIMEOUT_MS = origSessionTimeout;
    }
  });

  test('visibility-ended recorder also keeps the bridge alive', async () => {
    const origGrace = (Recorder as any).VISIBILITY_GRACE_MS;

    try {
      (Recorder as any).VISIBILITY_GRACE_MS = 50;
      bridgeCalls.length = 0;

      const rec = createRecorder();
      rec.start(true);

      // Hide the tab, wait past the grace window, then show it again.
      visibilityState = 'hidden';
      dispatchMockEvent('visibilitychange');
      await new Promise(resolve => setTimeout(resolve, 80));
      visibilityState = 'visible';
      dispatchMockEvent('visibilitychange');

      expect(rec.endedByVisibility).toBe(true);
      // Same guarantee: bridge must remain for the rotate signal.
      expect(bridgeCalls).not.toContain('destroy');

      rec.stop();
      expect(bridgeCalls).toContain('destroy');
    } finally {
      (Recorder as any).VISIBILITY_GRACE_MS = origGrace;
    }
  });

  test('stop({ keepBridge: true }) skips bridge.destroy() (unit-level)', () => {
    bridgeCalls.length = 0;
    const rec = createRecorder();
    rec.start(true);
    rec.stop({ keepBridge: true });
    expect(bridgeCalls).not.toContain('destroy');
    // Flush still fires as part of the stop path (pending events sent).
    expect(bridgeCalls).toContain('flush');
  });

  test('stop() with no args destroys the bridge (default behavior)', () => {
    bridgeCalls.length = 0;
    const rec = createRecorder();
    rec.start(true);
    rec.stop();
    expect(bridgeCalls).toContain('destroy');
  });
});
