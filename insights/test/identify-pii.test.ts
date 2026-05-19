import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import {
  MAX_ID_LEN,
  MAX_EMAIL_LEN,
  MAX_CUSTOM_KEY_LEN,
  MAX_CUSTOM_VALUE_LEN,
  MAX_CUSTOM_PROPERTY_COUNT,
} from '@sessionsight/sdk-shared';

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

interface RecordedIdentify {
  id?: string;
  email?: string;
  customProperties?: Record<string, any>;
}
const identifyCalls: RecordedIdentify[] = [];

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
    onVisitorIdSwap(_cb: Function) {}
    postEvent() {}
    postMetadata() {}
    postIdentify() {}
    flush() {}
    flushAndDestroy() {}
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
    identify(payload: RecordedIdentify) {
      identifyCalls.push(payload);
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

describe('SessionSight.identify (flat shape)', () => {
  describe('routing: id / email / customProperties', () => {
    test('id alone routes to the id slot', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]).toEqual({ id: 'user_abc' });
    });

    test('email alone routes to the email slot', async () => {
      const ss = await freshSessionSight();
      ss.identify({ email: 'alice@acme.com' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]).toEqual({ email: 'alice@acme.com' });
    });

    test('id + email + custom routes to all three slots', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', email: 'alice@acme.com', plan: 'pro', signupAt: 1730000000 });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]).toEqual({
        id: 'user_abc',
        email: 'alice@acme.com',
        customProperties: { plan: 'pro', signupAt: 1730000000 },
      });
    });

    test('properties-only call (no id, no email) is valid', async () => {
      const ss = await freshSessionSight();
      ss.identify({ plan: 'pro', team: 'platform' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]).toEqual({
        customProperties: { plan: 'pro', team: 'platform' },
      });
    });

    test('empty object is a no-op (no recorder call)', async () => {
      const ss = await freshSessionSight();
      ss.identify({});
      expect(identifyCalls).toHaveLength(0);
    });

    test('undefined values are stripped (treated as absent)', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: undefined, email: undefined, plan: 'pro' });
      expect(identifyCalls).toHaveLength(1);
      expect(identifyCalls[0]).toEqual({ customProperties: { plan: 'pro' } });
    });
  });

  describe('email normalization', () => {
    test('mixed-case email is lowercased', async () => {
      const ss = await freshSessionSight();
      ss.identify({ email: 'Alice@Acme.COM' });
      expect(identifyCalls[0]!.email).toBe('alice@acme.com');
    });

    test('whitespace around email is trimmed', async () => {
      const ss = await freshSessionSight();
      ss.identify({ email: '  alice@acme.com  ' });
      expect(identifyCalls[0]!.email).toBe('alice@acme.com');
    });
  });

  describe('id slot: rejected (throws)', () => {
    test('email-shaped value in id throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ id: 'alice@acme.com' })).toThrow(/email-shaped/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('SSN in id throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ id: '123-45-6789' })).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('Luhn-valid credit card in id throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ id: '4111 1111 1111 1111' })).toThrow(/prohibited PII/);
      expect(identifyCalls).toHaveLength(0);
    });

    test('id longer than MAX_ID_LEN throws', async () => {
      const ss = await freshSessionSight();
      const tooLong = 'a'.repeat(MAX_ID_LEN + 1);
      expect(() => ss.identify({ id: tooLong })).toThrow(new RegExp(`${MAX_ID_LEN} characters`));
    });

    test('empty id throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ id: '' })).toThrow(/non-empty/);
    });
  });

  describe('email slot: rejected (throws)', () => {
    test('invalid email shape throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ email: 'not-an-email' })).toThrow(/valid email shape/);
    });

    test('email without TLD throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ email: 'foo@bar' })).toThrow(/valid email shape/);
    });

    test('email longer than MAX_EMAIL_LEN throws', async () => {
      const ss = await freshSessionSight();
      const local = 'a'.repeat(MAX_EMAIL_LEN);
      expect(() => ss.identify({ email: `${local}@acme.com` })).toThrow(new RegExp(`${MAX_EMAIL_LEN} characters`));
    });

    test('email with whitespace throws (post-trim still invalid)', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ email: 'alice @acme.com' })).toThrow(/valid email shape/);
    });
  });

  describe('custom properties: sanitization (silent drop)', () => {
    test('drops entry when value contains SSN', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', plan: 'pro', ssn: '123-45-6789' });
      expect(identifyCalls[0]!.customProperties).toEqual({ plan: 'pro' });
    });

    test('drops entry when value contains phone', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', plan: 'pro', notes: 'call me at 555-123-4567' });
      expect(identifyCalls[0]!.customProperties).toEqual({ plan: 'pro' });
    });

    test('drops entry when key matches prohibited PII', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', '123-45-6789': 'some value', plan: 'pro' });
      expect(identifyCalls[0]!.customProperties).toEqual({ plan: 'pro' });
    });

    test('preserves email in property values (per-value PII skipEmail)', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', contact: 'bob@acme.com', plan: 'pro' });
      expect(identifyCalls[0]!.customProperties).toEqual({
        contact: 'bob@acme.com',
        plan: 'pro',
      });
    });

    test('numeric and boolean values pass through unchanged', async () => {
      const ss = await freshSessionSight();
      ss.identify({ id: 'user_abc', score: 42, active: true, rank: 3.14 });
      expect(identifyCalls[0]!.customProperties).toEqual({ score: 42, active: true, rank: 3.14 });
    });
  });

  describe('custom properties: rejected (throws)', () => {
    test('custom property key longer than MAX_CUSTOM_KEY_LEN throws', async () => {
      const ss = await freshSessionSight();
      const longKey = 'k'.repeat(MAX_CUSTOM_KEY_LEN + 1);
      expect(() => ss.identify({ id: 'user_abc', [longKey]: 'v' })).toThrow(new RegExp(`${MAX_CUSTOM_KEY_LEN} characters`));
    });

    test('custom property string value longer than MAX_CUSTOM_VALUE_LEN throws', async () => {
      const ss = await freshSessionSight();
      const longValue = 'v'.repeat(MAX_CUSTOM_VALUE_LEN + 1);
      expect(() => ss.identify({ id: 'user_abc', big: longValue })).toThrow(new RegExp(`${MAX_CUSTOM_VALUE_LEN} characters`));
    });

    test('more than MAX_CUSTOM_PROPERTY_COUNT properties throws', async () => {
      const ss = await freshSessionSight();
      const payload: Record<string, string> = { id: 'user_abc' };
      for (let i = 0; i < MAX_CUSTOM_PROPERTY_COUNT + 1; i++) payload[`k${i}`] = `v${i}`;
      expect(() => ss.identify(payload)).toThrow(new RegExp(`at most ${MAX_CUSTOM_PROPERTY_COUNT}`));
    });

    test('exactly MAX_CUSTOM_PROPERTY_COUNT properties is allowed (id/email do not count)', async () => {
      const ss = await freshSessionSight();
      const payload: Record<string, string> = { id: 'user_abc', email: 'alice@acme.com' };
      for (let i = 0; i < MAX_CUSTOM_PROPERTY_COUNT; i++) payload[`k${i}`] = `v${i}`;
      ss.identify(payload);
      expect(identifyCalls).toHaveLength(1);
      expect(Object.keys(identifyCalls[0]!.customProperties!).length).toBe(MAX_CUSTOM_PROPERTY_COUNT);
    });

    test('wrong-type custom property value throws', async () => {
      const ss = await freshSessionSight();
      expect(() => ss.identify({ id: 'user_abc', data: { nested: 'not allowed' } as any })).toThrow(/string, number, or boolean/);
    });
  });
});
