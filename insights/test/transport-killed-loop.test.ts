import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Regression: a 401 from /v1/ingest/anonymous used to spin the SDK forever.
 *
 * Loop (pre-fix):
 *   1. consent='full' -> applyTierTransition('full') -> WorkerBridge
 *   2. full-tier 401 -> handleBridgeKilled falls back to anonymous,
 *      setting lastConsentLevel='anonymous' and spinning AnonymousWorkerBridge
 *   3. anonymous 401 -> teardownAnonymous, but lastConsentLevel stayed
 *      'anonymous' and the consent poll kept running
 *   4. Next pollConsent tick: getter returns 'full', lastConsentLevel is
 *      'anonymous', mismatch fires applyTierTransition('full') again
 *   5. Loop forever; ~1 request/s/anonymous/property
 *
 * Fix: when either tier reports a terminal kill, set `transportKilled` and
 * stop the consent poll. The same API key won't suddenly become valid
 * within the same page lifecycle.
 */

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
const origLocation = (globalThis as any).location;

let cookieStore = '';

const bridgeInstances: Array<{
  destroyed: boolean;
  fireKilled: (reason?: string) => void;
}> = [];
const anonBridgeInstances: Array<{
  destroyed: boolean;
  fireKilled: (reason?: string) => void;
}> = [];

beforeEach(() => {
  listeners.clear();
  cookieStore = '';
  bridgeInstances.length = 0;
  anonBridgeInstances.length = 0;

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return 'visible'; },
      addEventListener,
      removeEventListener,
      get cookie() { return cookieStore; },
      set cookie(v: string) {
        const parts = v.split(';').map(s => s.trim());
        const first = parts[0] || '';
        const eq = first.indexOf('=');
        if (eq < 0) return;
        const name = first.slice(0, eq);
        const value = first.slice(eq + 1);
        const maxAge = parts.find(p => p.startsWith('max-age='));
        if (maxAge && maxAge.split('=')[1] === '0') {
          cookieStore = cookieStore.split('; ').filter(c => !c.startsWith(name + '=')).join('; ');
          return;
        }
        const existing = cookieStore.split('; ').filter(c => c && !c.startsWith(name + '='));
        existing.push(`${name}=${value}`);
        cookieStore = existing.join('; ');
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    },
  });

  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/', pathname: '/', search: '', hash: '' };

  const storage = new Map<string, string>();
  (globalThis as any).window = {
    location: (globalThis as any).location,
    addEventListener,
    removeEventListener,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
    dataLayer: [] as any[],
  };
  (globalThis as any).localStorage = (globalThis as any).window.localStorage;

  (globalThis as any).navigator = { language: 'en-US', sendBeacon: () => true };
});

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: origDocument });
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).location = origLocation;
});

// Bridges that actually invoke their onKilled callback when fireKilled() is
// called, so we can simulate a real 401 trip.
mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    destroyed = false;
    private killedCb: ((reason?: string) => void) | null = null;
    constructor(_apiUrl: string, _apiKey: string, _propertyId: string, _sessionId: string, _visitorId: string) {
      const self = this;
      const entry = {
        destroyed: false as boolean,
        fireKilled: (reason?: string) => { if (self.killedCb) self.killedCb(reason); },
      };
      Object.defineProperty(entry, 'destroyed', { get: () => self.destroyed });
      bridgeInstances.push(entry as any);
    }
    onPrivacy(_cb: Function) {}
    onQuotaExceeded(_cb: Function) {}
    onRotate(_cb: Function) {}
    onKilled(cb: (reason?: string) => void) { this.killedCb = cb; }
    onVisitorIdSwap(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    flushAndDestroy() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
  },
}));

mock.module('../src/recorder.js', () => ({
  Recorder: class {
    started = false;
    stopped = false;
    visitorId: string;
    endedByVisibility = false;
    endedByIdle = false;
    constructor(_b: any, _p: any, visitorId: any) { this.visitorId = visitorId; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    pause() {}
    resume() {}
    beginRecording() {}
    identify() {}
    getVisitorId() { return this.visitorId; }
    getBridge() { return {}; }
    getPropertyId() { return 'prop-1'; }
    applyPrivacyConfig() {}
  },
}));

mock.module('../src/anonymous-worker-bridge.js', () => ({
  AnonymousWorkerBridge: class {
    destroyed = false;
    private killedCb: ((reason?: string) => void) | null = null;
    constructor(_opts: any) {
      const self = this;
      const entry = {
        destroyed: false as boolean,
        fireKilled: (reason?: string) => { if (self.killedCb) self.killedCb(reason); },
      };
      Object.defineProperty(entry, 'destroyed', { get: () => self.destroyed });
      anonBridgeInstances.push(entry as any);
    }
    onKilled(cb: (reason?: string) => void) { this.killedCb = cb; }
    postEvent() {}
    flush() {}
    flushAndDestroy() { this.destroyed = true; }
    destroy() { this.destroyed = true; }
  },
}));

mock.module('../src/anonymous-capture.js', () => ({
  AnonymousCapture: class {
    started = false;
    stopped = false;
    constructor(_opts: any) {}
    start() { this.started = true; }
    stop() { this.stopped = true; }
    applyPrivacyConfig() {}
    emitGoalCount() {}
  },
}));

async function freshSessionSight() {
  const mod = await import(`../src/index.js?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

const BASE_CONFIG = { publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' };

describe('transport kill is terminal (no respawn loop)', () => {
  test('full-tier kill -> anonymous fallback -> anonymous kill stops the consent poll', async () => {
    const SessionSight = await freshSessionSight();

    // Consent getter pins to 'full' for the whole test. This is the case
    // that triggered the bug: the user has accepted cookies, so the poll
    // keeps wanting 'full' even after both tiers die.
    SessionSight.init({ ...BASE_CONFIG, consent: () => 'full' });

    expect(bridgeInstances).toHaveLength(1);
    expect(anonBridgeInstances).toHaveLength(0);

    // Full-tier 401 -> handleBridgeKilled spins up the anonymous tier.
    bridgeInstances[0]!.fireKilled();
    expect(anonBridgeInstances).toHaveLength(1);

    // Anonymous-tier 401 -> teardownAnonymous + transportKilled=true.
    anonBridgeInstances[0]!.fireKilled();

    // Wait > 1s consent-poll tick. Pre-fix this would have created a new
    // full-tier bridge (and then another anonymous bridge after its kill)
    // every second.
    await new Promise((r) => setTimeout(r, 1200));

    expect(bridgeInstances).toHaveLength(1);
    expect(anonBridgeInstances).toHaveLength(1);
  });

  test('setConsent() clears the killed flag and lets the SDK retry', async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: () => 'full' });

    bridgeInstances[0]!.fireKilled();
    anonBridgeInstances[0]!.fireKilled();

    // Explicit user retry intent: bring the SDK back up.
    SessionSight.setConsent('full');

    expect(bridgeInstances).toHaveLength(2);
  });

  test("full-tier kill with reason='invalid_api_key' skips the anonymous fallback", async () => {
    const SessionSight = await freshSessionSight();
    SessionSight.init({ ...BASE_CONFIG, consent: () => 'full' });

    // The same API key would fail on the anonymous endpoint too, so we
    // shouldn't burn a second request to confirm it.
    bridgeInstances[0]!.fireKilled('invalid_api_key');

    expect(anonBridgeInstances).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 1200));
    expect(bridgeInstances).toHaveLength(1);
    expect(anonBridgeInstances).toHaveLength(0);
  });

  test('kill emits a console.warn naming the reason', async () => {
    const SessionSight = await freshSessionSight();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.map(String).join(' ')); };

    try {
      SessionSight.init({ ...BASE_CONFIG, consent: () => 'full' });
      bridgeInstances[0]!.fireKilled('invalid_api_key');
    } finally {
      console.warn = origWarn;
    }

    expect(warnings.some(w => w.includes('SessionSight') && w.includes('API key was rejected'))).toBe(true);
  });
});
