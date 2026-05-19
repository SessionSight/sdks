import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Unit tests for the SDK-level `rotateSession()` function in index.ts.
 *
 * When the backend seals a sessionId it pushes `rotate_session` over the
 * WebSocket. The SDK's `bridge.onRotate` callback fires `rotateSession()`,
 * which must:
 *   1. Tear down the old bridge (so its WS/worker stop emitting).
 *   2. Mint a fresh sessionId (preserving visitorId for consent continuity).
 *   3. Write the new sessionId to the `ss_sid` cookie so backend SDKs pair.
 *   4. Create a new WorkerBridge on the new sessionId.
 *   5. NOT start a recorder. Arm activity-based resurrection instead. The
 *      server only seals after the user has been idle, so there is nobody
 *      on the page to record yet.
 *   6. Respect consent (`enabledGetter` returning false) and stay paused.
 *
 * These tests drive `rotateSession()` by capturing the `onRotate` callback
 * the SDK registers on WorkerBridge and invoking it directly.
 */

// ── Browser global stubs ─────────────────────────────────────────────

const listeners = new Map<string, Set<Function>>();
function addEventListener(event: string, fn: Function, _opts?: any) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}
function removeEventListener(event: string, fn: Function, _opts?: any) {
  listeners.get(event)?.delete(fn);
}
function dispatch(event: string) {
  for (const fn of listeners.get(event) ?? []) fn();
}

const origDocument = globalThis.document;
const origWindow = globalThis.window;
const origNavigator = globalThis.navigator;
const origLocation = (globalThis as any).location;
const origCrypto = globalThis.crypto;

let cookieStore = '';

beforeEach(() => {
  listeners.clear();
  cookieStore = '';

  (globalThis as any).document = {
    get visibilityState() { return 'visible'; },
    get cookie() { return cookieStore; },
    set cookie(v: string) {
      const pair = v.split(';')[0]!.trim();
      const [name] = pair.split('=');
      const existing = cookieStore.split('; ').filter(Boolean).filter(c => !c.startsWith(`${name}=`));
      existing.push(pair);
      cookieStore = existing.join('; ');
    },
    addEventListener,
    removeEventListener,
  };

  (globalThis as any).location = { protocol: 'https:' };

  (globalThis as any).window = {
    location: (globalThis as any).location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener,
    removeEventListener,
    localStorage: (() => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      };
    })(),
  };
  (globalThis as any).localStorage = (globalThis as any).window.localStorage;

  (globalThis as any).navigator = {
    language: 'en-US',
    sendBeacon: () => true,
  };

  // Predictable sessionIds: first init, then each rotate.
  let counter = 0;
  (globalThis as any).crypto = {
    randomUUID: () => `uuid-${++counter}`,
    getRandomValues: (origCrypto && typeof origCrypto.getRandomValues === 'function')
      ? (buf: any) => origCrypto.getRandomValues(buf)
      : (buf: any) => { for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 1) >>> 0; return buf; },
  };
});

afterEach(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).location = origLocation;
  (globalThis as any).crypto = origCrypto;
});

// ── Mock WorkerBridge with construction tracking + callback capture ──

interface BridgeStub {
  id: number;
  sessionId: string;
  destroyed: boolean;
  onRotate: ((reason?: string) => void) | null;
  onPrivacy: ((c: any) => void) | null;
  onQuotaExceeded: (() => void) | null;
  onVisitorIdSwapCbs: Array<(id: string) => void>;
  onKilledCbs: Array<() => void>;
}

const bridges: BridgeStub[] = [];

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    constructor(
      _apiUrl: string,
      _apiKey: string,
      _propertyId: string,
      sessionId: string,
      _visitorId: string,
    ) {
      const stub: BridgeStub = {
        id: bridges.length,
        sessionId,
        destroyed: false,
        onRotate: null,
        onPrivacy: null,
        onQuotaExceeded: null,
        onVisitorIdSwapCbs: [],
        onKilledCbs: [],
      };
      bridges.push(stub);
      // Store reference so the wrapper can hit these when the SDK calls them.
      (this as any)._stub = stub;
    }
    onPrivacy(cb: any) { (this as any)._stub.onPrivacy = cb; }
    onQuotaExceeded(cb: any) { (this as any)._stub.onQuotaExceeded = cb; }
    onRotate(cb: any) { (this as any)._stub.onRotate = cb; }
    onKilled(cb: any) { (this as any)._stub.onKilledCbs.push(cb); }
    onVisitorIdSwap(cb: any) { (this as any)._stub.onVisitorIdSwapCbs.push(cb); }
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    flushAndDestroy() { (this as any)._stub.destroyed = true; }
    sendBeacon() {}
    destroy() { (this as any)._stub.destroyed = true; }
    isKilled() { return false; }
  },
}));

// ── Mock Recorder with start/stop tracking ───────────────────────────

interface RecorderStub {
  id: number;
  started: boolean;
  stopped: boolean;
  bridgeRef: any;
}

const recorders: RecorderStub[] = [];

mock.module('../src/recorder.js', () => ({
  Recorder: class {
    private vid: string;
    constructor(bridge: any, _prop: any, vis: any, _cfg: any) {
      this.vid = vis;
      const stub: RecorderStub = {
        id: recorders.length,
        started: false,
        stopped: false,
        bridgeRef: bridge,
      };
      recorders.push(stub);
      (this as any)._stub = stub;
      // Mirror the real Recorder: subscribe to bridge.onVisitorIdSwap so
      // getVisitorId reflects bootstrap-recovery swaps.
      if (typeof bridge?.onVisitorIdSwap === 'function') {
        bridge.onVisitorIdSwap((newId: string) => { this.vid = newId; });
      }
    }
    start() { (this as any)._stub.started = true; }
    // Match the real Recorder: stop() with default args destroys the bridge.
    // The idle/visibility paths call stop({ keepBridge: true }) but that
    // flow isn't exercised here.
    stop(options: { keepBridge?: boolean } = {}) {
      (this as any)._stub.stopped = true;
      if (!options.keepBridge) {
        (this as any)._stub.bridgeRef?.destroy?.();
      }
    }
    beginRecording() {}
    identify() {}
    getVisitorId() { return this.vid; }
    getBridge() { return (this as any)._stub.bridgeRef; }
    getPropertyId() { return 'prop-1'; }
    applyPrivacyConfig() {}
    endedByVisibility = false;
    endedByIdle = false;
  },
}));

// Fresh module each test so the index.ts module state resets.
async function freshSessionSight() {
  bridges.length = 0;
  recorders.length = 0;
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function triggerRotate(bridgeIndex: number = 0, reason?: string): void {
  const cb = bridges[bridgeIndex]!.onRotate;
  if (!cb) throw new Error(`bridge ${bridgeIndex} has no onRotate callback`);
  cb(reason);
}

function readSessionCookie(): string | null {
  const match = cookieStore.match(/(?:^|; )ss_sid=([^;]*)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('rotateSession()', () => {
  // Note: each init() burns TWO randomUUID calls. Under the session-as-identity
  // model the visitor is resolved/minted BEFORE the sessionId in applyConsentGranted.
  // Counter sequence per test: uuid-1 = visitorId, uuid-2 = sessionId,
  // uuid-3 = first rotation's new sessionId, uuid-4 = second rotation's, etc.

  test('init writes the current sessionId to the ss_sid cookie', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    expect(readSessionCookie()).toBe('uuid-2');
    expect(bridges).toHaveLength(1);
    expect(bridges[0]!.sessionId).toBe('uuid-2');
  });

  test('tears down the old bridge and creates a new one on rotate', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    expect(bridges[0]!.destroyed).toBe(false);

    triggerRotate();

    expect(bridges).toHaveLength(2);
    expect(bridges[0]!.destroyed).toBe(true);
    expect(bridges[1]!.destroyed).toBe(false);
  });

  test('mints a new sessionId distinct from the original', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const first = bridges[0]!.sessionId;
    triggerRotate();
    const second = bridges[1]!.sessionId;

    expect(second).not.toBe(first);
  });

  test('writes the new sessionId to the ss_sid cookie after rotation', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
    expect(readSessionCookie()).toBe('uuid-2');

    triggerRotate();

    // After init: uuid-1 = visitorId, uuid-2 = sessionId.
    // Rotate only mints a fresh sessionId, so uuid-3 is the new one.
    expect(readSessionCookie()).toBe('uuid-3');
  });

  test('preserves visitorId across rotation (consent identity stays intact)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const visitorBefore = SessionSight.getVisitorId();
    triggerRotate();
    const visitorAfter = SessionSight.getVisitorId();

    // After H1: getVisitorId falls through to storedVisitorId when no recorder
    // is attached (e.g., between rotateSession() and the resurrection that
    // attaches the new recorder). So both reads return the same persisted
    // visitorId, and the new bridge was constructed with it.
    expect(visitorBefore).not.toBeNull();
    expect(visitorAfter).toBe(visitorBefore);
    expect(bridges).toHaveLength(2);
  });

  test('bridge.onVisitorIdSwap propagates to getVisitorId() and the next rotation', async () => {
    // When the bridge's bootstrap recovery path swaps the visitorId,
    // the change must reach:
    //   1. The Recorder (so getVisitorId() reflects it)
    //   2. The module-level storedVisitorId (so the next rotateSession()
    //      builds the new bridge with the swapped id, not the stale one)
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    const before = SessionSight.getVisitorId();
    expect(before).toBe('uuid-1');

    // Simulate the bridge's recoverVisitorToken firing the swap callback.
    // The Recorder and index.ts each subscribe; we fire all of them.
    const swapCbs = bridges[0]!.onVisitorIdSwapCbs;
    expect(swapCbs.length).toBeGreaterThanOrEqual(2);
    for (const cb of swapCbs) cb('swapped-vid-9999');

    // getVisitorId now reflects the new id (Recorder.visitorId was updated).
    expect(SessionSight.getVisitorId()).toBe('swapped-vid-9999');

    // Rotate. The new bridge must be constructed with the swapped id, not
    // uuid-1 (which was the original storedVisitorId). The 5th constructor
    // arg is visitorId; we read it indirectly via the post-rotation read.
    triggerRotate();
    expect(bridges).toHaveLength(2);
    // After rotation, no recorder is attached yet (rotate arms resurrection
    // instead). getVisitorId falls through to storedVisitorId, which the
    // bridge.onVisitorIdSwap also updated.
    expect(SessionSight.getVisitorId()).toBe('swapped-vid-9999');
  });

  test('does NOT start a recorder on rotate; arms resurrection instead', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    // init should have started the first recorder
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.started).toBe(true);

    triggerRotate();

    // rotate stops the first recorder and creates NO new one (until
    // the user interacts).
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.stopped).toBe(true);
  });

  test('activity after rotate attaches a new recorder on the new bridge', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
    triggerRotate();

    expect(recorders).toHaveLength(1);

    // Simulate user activity (click is listened to by the idle resurrection
    // handler). The handler consumes the rotate-armed pendingConfig.
    dispatch('click');

    expect(recorders).toHaveLength(2);
    expect(recorders[1]!.started).toBe(true);
    // The new recorder must be wired to the NEW bridge, not the old one.
    const newBridgeStub = (recorders[1]!.bridgeRef as any)._stub;
    expect(newBridgeStub.sessionId).toBe('uuid-3');
    expect(newBridgeStub.id).toBe(1); // second bridge created
  });

  test('respects consent: after setConsent(false), rotate produces no new recorder', async () => {
    const SessionSight = await freshSessionSight();
    let consentGranted = true;
    SessionSight.init({
      publicApiKey: 'pk_test',
      propertyId: 'prop-1',
      apiUrl: 'https://api.example.com',
      consent: () => consentGranted,
    });

    // Withdraw consent. Under the session-as-identity model this detaches
    // the SDK from the current session entirely. There's no session to rotate.
    consentGranted = false;
    SessionSight.setConsent(false);

    // A server-driven rotate signal on the (now torn down) bridge is a no-op
    // because rotateSession guards on lastInitConfig which setConsent(false) cleared.
    triggerRotate();

    dispatch('click');
    dispatch('visibilitychange');

    // Only the initial recorder ever started.
    const startedCount = recorders.filter(r => r.started).length;
    expect(startedCount).toBe(1);
  });

  test('registers onRotate on the new bridge so a second seal rotates again', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    triggerRotate();           // first rotation: sessionId uuid-1 -> uuid-3
    expect(bridges[1]!.onRotate).not.toBeNull();
    expect(bridges[1]!.sessionId).toBe('uuid-3');

    triggerRotate(1);          // second rotation on the new bridge -> uuid-4
    expect(bridges).toHaveLength(3);
    expect(bridges[2]!.sessionId).toBe('uuid-4');
    expect(bridges[1]!.destroyed).toBe(true);
  });

  test('new bridge receives privacy config callback (still wired up)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
    triggerRotate();

    expect(bridges[1]!.onPrivacy).not.toBeNull();
    expect(bridges[1]!.onQuotaExceeded).not.toBeNull();
  });
});

describe('focus-wins cookie semantics', () => {
  test('tab focus re-asserts the current sessionId into ss_sid', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    // Simulate another tab overwriting ss_sid with its own value.
    cookieStore = 'ss_sid=other-tab-sid';
    expect(readSessionCookie()).toBe('other-tab-sid');

    // When this tab gets focus, it should reclaim ownership of ss_sid.
    dispatch('focus');
    expect(readSessionCookie()).toBe('uuid-2');
  });

  test('visibilitychange to visible also reclaims ss_sid', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    cookieStore = 'ss_sid=other-tab-sid';
    dispatch('visibilitychange');
    expect(readSessionCookie()).toBe('uuid-2');
  });
});
