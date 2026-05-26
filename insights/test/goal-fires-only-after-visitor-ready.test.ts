import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

// Validates Part 4 of SERVER_AUTHORITATIVE_SESSIONS_PLAN: the SDK must not
// fire a full-tier goal beacon until the visitor-token bootstrap has
// resolved. Calls that land in the pre-bootstrap window are queued and
// drained when the token is written.
//
// The window matters because the server now hard-rejects goal increments
// without a verified visitor token (requireValidVisitorToken). A goal
// fired before bootstrap would otherwise 401.

const listeners = new Map<string, Set<Function>>();

function addEventListener(event: string, fn: Function) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
}
function removeEventListener(event: string, fn: Function) {
  listeners.get(event)?.delete(fn);
}

const origDocument = globalThis.document;
const origWindow = globalThis.window;
const origNavigator = globalThis.navigator;
const origHistory = (globalThis as any).history;
const origHistoryCtor = (globalThis as any).History;
const origLocation = (globalThis as any).location;
const origFetch = globalThis.fetch;

const beaconCalls: Array<{ url: string; body: any }> = [];

// Cookie store backing `document.cookie` so the SDK's writeVisitorToken
// is observable from the test.
let cookieStore = '';

// Single in-flight bootstrap promise the test can resolve manually.
let bootstrapResolve: ((value: Response) => void) | null = null;

beforeEach(() => {
  listeners.clear();
  beaconCalls.length = 0;
  cookieStore = '';
  bootstrapResolve = null;

  (globalThis as any).document = {
    get visibilityState() { return 'visible'; },
    addEventListener,
    removeEventListener,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { appendChild: () => {}, removeChild: () => {} },
    get cookie() { return cookieStore; },
    set cookie(v: string) {
      const match = /^([^=]+)=([^;]*)/.exec(v);
      if (!match) return;
      const name = match[1]!;
      const value = match[2] ?? '';
      const isExpire = /max-age=0|expires=Thu, 01 Jan 1970/.test(v);
      const parts = cookieStore.split('; ').filter(Boolean).filter((c) => !c.startsWith(`${name}=`));
      if (!isExpire && value.length > 0) parts.push(`${name}=${value}`);
      cookieStore = parts.join('; ');
    },
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
  (globalThis as any).location = {
    protocol: 'https:',
    href: 'https://example.com/',
    pathname: '/',
    search: '',
    hash: '',
  };

  (globalThis as any).window = {
    location: (globalThis as any).location,
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener,
    removeEventListener,
    history: (globalThis as any).history,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({}),
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
    sendBeacon: (url: string, body: any) => {
      beaconCalls.push({ url, body });
      return true;
    },
  };

  // Mocked fetch: bootstrap endpoint returns a promise the test resolves
  // when it wants the SDK to consider the visitor "ready".
  (globalThis as any).fetch = (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/v1/sdk/visitor/bootstrap')) {
      return new Promise<Response>((resolve) => {
        bootstrapResolve = resolve;
      });
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
});

afterEach(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).history = origHistory;
  (globalThis as any).History = origHistoryCtor;
  (globalThis as any).location = origLocation;
  (globalThis as any).fetch = origFetch;
});

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    onPrivacy() {}
    onQuotaExceeded() {}
    onRotate() {}
    onKilled() {}
    onVisitorIdSwap() {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    sendBeacon() {}
    flushAndDestroy() {}
    destroy() {}
  },
}));

mock.module('../src/anonymous-worker-bridge.js', () => ({
  AnonymousWorkerBridge: class {
    constructor(_opts: any) {}
    onKilled() {}
    postEvent() {}
    flush() {}
    flushAndDestroy() {}
    destroy() {}
  },
}));

mock.module('../src/anonymous-capture.js', () => ({
  AnonymousCapture: class {
    constructor(_opts: any) {}
    start() {}
    stop() {}
    applyPrivacyConfig() {}
    emitGoalCount() {}
  },
}));

mock.module('../src/recorder.js', () => ({
  Recorder: class {
    constructor(_b: any, _p: any, _v: any, _c: any) {}
    start() {}
    stop() {}
    beginRecording() {}
    identify() {}
    getVisitorId() { return null; }
    getBridge() { return {}; }
    getPropertyId() { return 'prop-1'; }
    applyPrivacyConfig() {}
    endedByVisibility = false;
    endedByIdle = false;
  },
}));

async function freshSessionSight() {
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

const VALID_TOKEN = 'v1.' + 'a'.repeat(40) + '.' + 'b'.repeat(20);
const RESOLVED_VISITOR_ID = '11111111-2222-3333-4444-555555555555';

function fulfillBootstrap(): void {
  if (!bootstrapResolve) {
    throw new Error('test expected bootstrap to be in-flight');
  }
  bootstrapResolve(
    new Response(
      JSON.stringify({
        visitorId: RESOLVED_VISITOR_ID,
        visitorToken: VALID_TOKEN,
        issuedAt: Date.now(),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('SDK visitor-ready gate', () => {
  test('goal fired before bootstrap resolves is queued, not sent', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    // No cookie yet → fireGoal hits the queue branch.
    const result = SessionSight.goals.increment('purchase', { amount: 5 });

    expect(result.success).toBe(true);
    // Critically, no beacon yet — the SDK is holding the call until the
    // visitor token bootstrap resolves.
    expect(beaconCalls).toHaveLength(0);
  });

  test('queued goal drains after bootstrap completes', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    SessionSight.goals.increment('purchase', { amount: 5 });
    expect(beaconCalls).toHaveLength(0);

    fulfillBootstrap();
    // Let the bootstrap .then / .finally chain run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]!.url).toBe('https://api.example.com/v1/sdk/goals/increment');

    const text = await (beaconCalls[0]!.body as Blob).text();
    const body = JSON.parse(text);
    // The drained call must carry the bootstrapped token + the visitorId
    // the server returned (which may differ from the locally-minted one
    // if the server remapped a claimed visitor).
    expect(body.visitorToken).toBe(VALID_TOKEN);
    expect(body.visitorId).toBe(RESOLVED_VISITOR_ID);
    expect(body.amount).toBe(5);
    expect(body.goalId).toBe('purchase');
  });

  test('goal fired AFTER bootstrap resolves sends inline (no queue)', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    fulfillBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Token is now cached in document.cookie. fireGoal should send inline.
    expect(cookieStore).toContain('ss_vtoken=');

    const result = SessionSight.goals.increment('signup');
    expect(result.success).toBe(true);
    expect(beaconCalls).toHaveLength(1);
  });

  test('order is preserved when multiple goals queue then drain', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });

    SessionSight.goals.increment('first');
    SessionSight.goals.increment('second');
    SessionSight.goals.decrement('third');

    expect(beaconCalls).toHaveLength(0);

    fulfillBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(beaconCalls).toHaveLength(3);
    const goalIds = await Promise.all(
      beaconCalls.map(async (c) => JSON.parse(await (c.body as Blob).text()).goalId),
    );
    expect(goalIds).toEqual(['first', 'second', 'third']);

    // Each beacon hit the right endpoint per action.
    expect(beaconCalls[0]!.url.endsWith('/increment')).toBe(true);
    expect(beaconCalls[1]!.url.endsWith('/increment')).toBe(true);
    expect(beaconCalls[2]!.url.endsWith('/decrement')).toBe(true);
  });
});
