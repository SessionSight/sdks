import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';

// ── Browser global stubs (same pattern as goals-namespace.test.ts) ──

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
const origLocation = (globalThis as any).location;

const identifyCalls: Array<{ stableId: string; properties: Record<string, any> | undefined }> = [];

beforeEach(() => {
  listeners.clear();
  identifyCalls.length = 0;

  (globalThis as any).document = {
    get visibilityState() { return 'visible'; },
    addEventListener,
    removeEventListener,
    querySelectorAll: () => [],
    querySelector: () => null,
    body: { appendChild: () => {}, removeChild: () => {} },
    cookie: '',
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), style: {}, setAttribute: () => {}, getAttribute: () => null, appendChild: () => {} }),
  };

  const historyProto = { pushState: () => {}, replaceState: () => {} };
  (globalThis as any).History = { prototype: historyProto };
  (globalThis as any).history = { ...historyProto };
  (globalThis as any).location = { protocol: 'https:', href: 'https://example.com/', pathname: '/', search: '', hash: '' };

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
    sendBeacon: () => true,
  };
});

afterEach(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
  (globalThis as any).navigator = origNavigator;
  (globalThis as any).history = origHistory;
  (globalThis as any).History = origHistoryCtor;
  (globalThis as any).location = origLocation;
});

mock.module('../src/worker-bridge.js', () => ({
  WorkerBridge: class {
    onPrivacy(_cb: Function) {}
    onQuotaExceeded(_cb: Function) {}
    onRotate(_cb: Function) {}
    onKilled(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    sendBeacon() {}
    destroy() {}
  },
}));

mock.module('../src/recorder.js', () => ({
  Recorder: class {
    constructor(_b: any, _p: any, _v: any, _c: any) {}
    start() {}
    stop() {}
    beginRecording() {}
    identify(stableId: string, properties?: Record<string, any>) {
      identifyCalls.push({ stableId, properties });
    }
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
  const SessionSight = mod.default;
  SessionSight.init({ publicApiKey: 'pk_test', propertyId: 'prop-1', apiUrl: 'https://api.example.com' });
  return SessionSight;
}

describe('SessionSight.identify PII handling', () => {
  describe('stableId: allowed values', () => {
    test('email passes through', async () => {
      const ss = await freshSessionSight();
      ss.identify('alice@acme.com');
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.stableId).toBe('alice@acme.com');
    });

    test('UUID passes through', async () => {
      const ss = await freshSessionSight();
      ss.identify('550e8400-e29b-41d4-a716-446655440000');
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.stableId).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    test('opaque app-internal id passes through', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-abc-123');
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.stableId).toBe('user-abc-123');
    });
  });

  describe('stableId: rejected (throws)', () => {
    test('SSN throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify('123-45-6789')).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('Luhn-valid credit card throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify('4111 1111 1111 1111')).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('Anthropic-style API key throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify('sk-ant-abcdefghijklmnopqrstuvwxyz01')).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('US phone throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify('+1 555 123 4567')).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('JWT throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify('eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36P')).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });
  });

  describe('properties: sanitization', () => {
    test('drops entry when value contains SSN', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { plan: 'pro', ssn: '123-45-6789' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({ plan: 'pro' });
    });

    test('drops entry when value contains phone', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { plan: 'pro', notes: 'call me at 555-123-4567' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({ plan: 'pro' });
    });

    test('drops entry when key matches prohibited PII', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { '123-45-6789': 'some value', plan: 'pro' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({ plan: 'pro' });
    });

    test('preserves email in property key and value (email is allowed)', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { 'alice@acme.com': 'friend', contact: 'bob@acme.com', plan: 'pro' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({
        'alice@acme.com': 'friend',
        contact: 'bob@acme.com',
        plan: 'pro',
      });
    });

    test('passes numeric and boolean values through unchanged', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { score: 42, active: true, rank: 3.14 });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({ score: 42, active: true, rank: 3.14 });
    });

    test('clean properties pass through untouched', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', { plan: 'pro', accountType: 'enterprise', role: 'admin' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({
        plan: 'pro',
        accountType: 'enterprise',
        role: 'admin',
      });
    });

    test('drops multiple PII entries in one call', async () => {
      const ss = await freshSessionSight();
      ss.identify('user-1', {
        ssn: '123-45-6789',
        card: '4111 1111 1111 1111',
        apiKey: 'sk-ant-abcdefghijklmnopqrstuvwxyz01',
        plan: 'pro',
      });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]!.properties).toEqual({ plan: 'pro' });
    });
  });
});
