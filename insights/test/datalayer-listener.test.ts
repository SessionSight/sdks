import { test, expect, describe, beforeEach } from 'bun:test';

/**
 * Spec tests for the dataLayer listener described in
 * dev-docs/plans/GTM_INTEGRATION_PLAN.md.
 *
 * The SDK implementation of `installDataLayerListener` does not exist yet.
 * This file contains a reference implementation inline (see `installDataLayerListener`
 * below) that demonstrates the patching contract. When the real listener lands in
 * `packages/insights/src/datalayer-listener.ts`, swap the inline function for
 * an import from that module. The tests verify the behavior the implementation
 * must produce, regardless of where the code lives.
 *
 * The listener has two responsibilities: (1) patch `window.dataLayer.push` in a
 * way that composes with GTM and third parties, and (2) invoke a caller-supplied
 * onEvent handler for each pushed event. Lifecycle gating (init / stop / setEnabled)
 * lives in the caller's handler, NOT in the listener itself. The lifecycle-gating
 * tests at the bottom of this file demonstrate the expected caller pattern and
 * match the goals consent model (packages/insights/src/index.ts:40-70).
 */

// ── Reference implementation (move to src/datalayer-listener.ts when ready) ──

interface ListenerOptions {
  win: any;
  onEvent: (event: Record<string, unknown>) => void;
}

/**
 * Install the dataLayer listener.
 *
 * Contract:
 *   - Adopts `win.dataLayer` if present and Array; otherwise creates [].
 *   - Patches `push` via Object.defineProperty so later wrappers compose.
 *   - Forwards each pushed argument to `onEvent` AFTER the underlying push runs.
 *   - Guards `win.dataLayer` with a getter/setter so reassignment re-patches.
 *   - On adopt and on reassignment, replays existing entries through `onEvent`.
 *   - Catches exceptions from `onEvent`; never breaks `dataLayer.push()`.
 */
function installDataLayerListener(opts: ListenerOptions): void {
  const { win, onEvent } = opts;
  let currentArray: any[] = Array.isArray(win.dataLayer) ? win.dataLayer : [];

  const PATCH_MARKER = '__sessionsightDataLayerPatch__';

  function safeForward(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    try {
      onEvent(event as Record<string, unknown>);
    } catch {
      // Forwarding must never break host dataLayer.push
    }
  }

  function patchArrayPush(arr: any[]): void {
    const currentPush = arr.push;
    if ((currentPush as any)[PATCH_MARKER]) return;

    const wrapped = function (this: any[], ...args: any[]): number {
      const ret = currentPush.apply(this, args);
      for (const ev of args) safeForward(ev);
      return ret;
    };
    (wrapped as any)[PATCH_MARKER] = true;

    Object.defineProperty(arr, 'push', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  function adopt(arr: any[]): void {
    currentArray = arr;
    patchArrayPush(arr);
    for (const ev of arr) safeForward(ev);
  }

  if (!Array.isArray(win.dataLayer)) {
    win.dataLayer = currentArray;
  }
  for (const ev of currentArray) safeForward(ev);
  patchArrayPush(currentArray);

  Object.defineProperty(win, 'dataLayer', {
    configurable: true,
    enumerable: true,
    get() {
      return currentArray;
    },
    set(v: unknown) {
      const next: any[] = Array.isArray(v) ? v : [];
      adopt(next);
    },
  });
}

// ── Tests ──

let win: any;

beforeEach(() => {
  win = {};
});

function install(onEvent: (e: any) => void): void {
  installDataLayerListener({ win, onEvent });
}

function gtmStyleWrapPush(arr: any[], onEvent: (e: any) => void): void {
  const origPush = arr.push;
  arr.push = function (this: any[], ...args: any[]): number {
    const ret = origPush.apply(this, args);
    for (const ev of args) onEvent(ev);
    return ret;
  };
}

describe('dataLayer listener: adoption', () => {
  test('creates empty dataLayer when not present', () => {
    install(() => {});
    expect(Array.isArray(win.dataLayer)).toBe(true);
    expect(win.dataLayer.length).toBe(0);
  });

  test('adopts existing array without replacing the reference', () => {
    win.dataLayer = [];
    const ref = win.dataLayer;
    install(() => {});
    expect(win.dataLayer).toBe(ref);
  });

  test('coerces non-array initial value to fresh array', () => {
    win.dataLayer = 'not an array' as any;
    install(() => {});
    expect(Array.isArray(win.dataLayer)).toBe(true);
    expect(win.dataLayer.length).toBe(0);
  });

  test('replays pre-existing entries through onEvent on adoption', () => {
    win.dataLayer = [
      { event: 'preexisting_a' },
      { event: 'preexisting_b' },
    ];
    const seen: any[] = [];
    install((e) => seen.push(e));
    expect(seen).toEqual([
      { event: 'preexisting_a' },
      { event: 'preexisting_b' },
    ]);
  });
});

describe('dataLayer listener: forward behavior', () => {
  test('forwards pushed events to onEvent in order', () => {
    const seen: any[] = [];
    install((e) => seen.push(e));

    win.dataLayer.push({ event: 'a' });
    win.dataLayer.push({ event: 'b' }, { event: 'c' });

    expect(seen).toEqual([{ event: 'a' }, { event: 'b' }, { event: 'c' }]);
  });

  test('underlying array records every push exactly once', () => {
    install(() => {});
    win.dataLayer.push({ event: 'x' });
    win.dataLayer.push({ event: 'y' });
    expect(win.dataLayer).toEqual([{ event: 'x' }, { event: 'y' }]);
  });

  test('onEvent throwing does not break dataLayer.push', () => {
    install(() => {
      throw new Error('forwarder boom');
    });
    expect(() => win.dataLayer.push({ event: 'x' })).not.toThrow();
    expect(win.dataLayer).toEqual([{ event: 'x' }]);
  });

  test('push returns the new length of the array (Array.prototype.push contract)', () => {
    install(() => {});
    expect(win.dataLayer.push({ event: 'a' })).toBe(1);
    expect(win.dataLayer.push({ event: 'b' }, { event: 'c' })).toBe(3);
  });

  test('ignores non-object pushes safely', () => {
    const seen: any[] = [];
    install((e) => seen.push(e));
    win.dataLayer.push('string-arg' as any);
    win.dataLayer.push(42 as any);
    win.dataLayer.push(null as any);
    expect(seen).toEqual([]);
    expect(win.dataLayer).toEqual(['string-arg', 42, null]);
  });
});

describe('dataLayer listener: composition with GTM-style wrappers', () => {
  test('Case 1: we patch first, GTM wraps on top — both see every event', () => {
    const ssSeen: any[] = [];
    const gtmSeen: any[] = [];

    install((e) => ssSeen.push(e));
    gtmStyleWrapPush(win.dataLayer, (e) => gtmSeen.push(e));

    win.dataLayer.push({ event: 'purchase' });

    expect(ssSeen).toEqual([{ event: 'purchase' }]);
    expect(gtmSeen).toEqual([{ event: 'purchase' }]);
    expect(win.dataLayer.length).toBe(1);
  });

  test('Case 2: GTM patches first, we wrap on top — both see every event', () => {
    const ssSeen: any[] = [];
    const gtmSeen: any[] = [];

    win.dataLayer = [];
    gtmStyleWrapPush(win.dataLayer, (e) => gtmSeen.push(e));

    install((e) => ssSeen.push(e));

    win.dataLayer.push({ event: 'purchase' });

    expect(ssSeen).toEqual([{ event: 'purchase' }]);
    expect(gtmSeen).toEqual([{ event: 'purchase' }]);
    expect(win.dataLayer.length).toBe(1);
  });

  test('Case 4: multiple wrappers stack — every party sees the event once, underlying array has one copy', () => {
    const ssSeen: any[] = [];
    const thirdPartySeen: any[] = [];
    const gtmSeen: any[] = [];

    install((e) => ssSeen.push(e));
    gtmStyleWrapPush(win.dataLayer, (e) => thirdPartySeen.push(e));
    gtmStyleWrapPush(win.dataLayer, (e) => gtmSeen.push(e));

    win.dataLayer.push({ event: 'shared' });

    expect(ssSeen).toEqual([{ event: 'shared' }]);
    expect(thirdPartySeen).toEqual([{ event: 'shared' }]);
    expect(gtmSeen).toEqual([{ event: 'shared' }]);
    expect(win.dataLayer.length).toBe(1);
  });
});

describe('dataLayer listener: reassignment guard', () => {
  test('Case 3: window.dataLayer reassigned to [] — subsequent pushes still forward', () => {
    const seen: any[] = [];
    install((e) => seen.push(e));

    win.dataLayer.push({ event: 'before_reset' });

    win.dataLayer = [];
    win.dataLayer.push({ event: 'after_reset' });

    expect(seen).toEqual([{ event: 'before_reset' }, { event: 'after_reset' }]);
  });

  test('reassignment to pre-populated array replays its entries', () => {
    const seen: any[] = [];
    install((e) => seen.push(e));

    win.dataLayer.push({ event: 'original' });

    win.dataLayer = [{ event: 'preloaded_a' }, { event: 'preloaded_b' }];

    expect(seen).toEqual([
      { event: 'original' },
      { event: 'preloaded_a' },
      { event: 'preloaded_b' },
    ]);
  });

  test('reassigned array composes with a fresh GTM-style wrap on the new array', () => {
    const ssSeen: any[] = [];
    const gtmSeen: any[] = [];

    install((e) => ssSeen.push(e));

    win.dataLayer = [];
    gtmStyleWrapPush(win.dataLayer, (e) => gtmSeen.push(e));

    win.dataLayer.push({ event: 'after_reset_with_gtm' });

    expect(ssSeen).toEqual([{ event: 'after_reset_with_gtm' }]);
    expect(gtmSeen).toEqual([{ event: 'after_reset_with_gtm' }]);
  });

  test('reassigning to a non-array coerces to an empty array and continues to forward', () => {
    const seen: any[] = [];
    install((e) => seen.push(e));

    win.dataLayer = null as any;
    expect(Array.isArray(win.dataLayer)).toBe(true);
    win.dataLayer.push({ event: 'after_null' });

    expect(seen).toEqual([{ event: 'after_null' }]);
  });
});

describe('dataLayer listener: double-install safety', () => {
  test('installing twice on the same array does not double the underlying push', () => {
    install(() => {});
    install(() => {});

    win.dataLayer.push({ event: 'only_once' });
    expect(win.dataLayer.length).toBe(1);
  });
});

// ── Lifecycle tests ──
//
// The listener itself is unconditional: it always forwards to onEvent. The
// caller (SessionSight) decides whether and how to forward to the backend
// based on SDK lifecycle state. These tests simulate the caller's forward
// handler, matching the goals consent model documented at
// packages/insights/src/index.ts:40-70.

type ForwardTarget = { event: string; visitorId?: string; sessionId?: string };

interface LifecycleState {
  goalsConfig: { apiKey: string; propertyId: string } | null;
  storedVisitorId: string;
  storedSessionId: string;
  enabled: boolean;
}

function makeForwardHandler(state: LifecycleState, sink: ForwardTarget[]) {
  // Mirrors the real SDK's decision-making:
  //   - goalsConfig gates whether anything is forwarded.
  //   - CMv2 would also gate here (not simulated in this suite).
  //   - The SDK's enabled getter (`state.enabled`) is deliberately NOT consulted.
  //   - storedVisitorId/storedSessionId ride attribution; stop() clears them.
  return (ev: { event?: unknown }) => {
    if (!state.goalsConfig) return;
    if (typeof ev.event !== 'string') return;
    sink.push({
      event: ev.event,
      visitorId: state.storedVisitorId || undefined,
      sessionId: state.storedSessionId || undefined,
    });
  };
}

// Simulate the SDK methods that mutate lifecycle state.
function initLifecycle(state: LifecycleState): void {
  state.goalsConfig = { apiKey: 'pk_test', propertyId: 'prop-1' };
  state.storedVisitorId = 'visitor-abc';
  state.storedSessionId = 'session-123';
  state.enabled = true;
}
function setEnabledFalse(state: LifecycleState): void {
  state.enabled = false;
}
function stopLifecycle(state: LifecycleState): void {
  // Matches packages/insights/src/index.ts stop(): clear ids, leave goalsConfig.
  state.storedVisitorId = '';
  state.storedSessionId = '';
}

describe('dataLayer listener: lifecycle gating (goals consent model)', () => {
  test('never inited — no goalsConfig, forwards are dropped', () => {
    const state: LifecycleState = {
      goalsConfig: null,
      storedVisitorId: '',
      storedSessionId: '',
      enabled: true,
    };
    const sink: ForwardTarget[] = [];
    install(makeForwardHandler(state, sink));

    win.dataLayer.push({ event: 'purchase' });

    expect(sink).toEqual([]);
  });

  test('inited normally — forwards with visitor and session attribution', () => {
    const state: LifecycleState = {
      goalsConfig: null,
      storedVisitorId: '',
      storedSessionId: '',
      enabled: true,
    };
    const sink: ForwardTarget[] = [];
    install(makeForwardHandler(state, sink));

    initLifecycle(state);
    win.dataLayer.push({ event: 'purchase' });

    expect(sink).toEqual([
      { event: 'purchase', visitorId: 'visitor-abc', sessionId: 'session-123' },
    ]);
  });

  test('setEnabled(false) after init — still forwards with attribution (goals model)', () => {
    const state: LifecycleState = {
      goalsConfig: null,
      storedVisitorId: '',
      storedSessionId: '',
      enabled: true,
    };
    const sink: ForwardTarget[] = [];
    install(makeForwardHandler(state, sink));

    initLifecycle(state);
    setEnabledFalse(state);
    win.dataLayer.push({ event: 'purchase' });

    expect(sink).toEqual([
      { event: 'purchase', visitorId: 'visitor-abc', sessionId: 'session-123' },
    ]);
  });

  test('stop() after init — forwards without attribution (ids stripped, goalsConfig retained)', () => {
    const state: LifecycleState = {
      goalsConfig: null,
      storedVisitorId: '',
      storedSessionId: '',
      enabled: true,
    };
    const sink: ForwardTarget[] = [];
    install(makeForwardHandler(state, sink));

    initLifecycle(state);
    stopLifecycle(state);
    win.dataLayer.push({ event: 'purchase' });

    expect(sink).toEqual([{ event: 'purchase' }]);
    expect(state.goalsConfig).not.toBeNull();
  });

  test('init() again after stop() — forwards resume with attribution', () => {
    const state: LifecycleState = {
      goalsConfig: null,
      storedVisitorId: '',
      storedSessionId: '',
      enabled: true,
    };
    const sink: ForwardTarget[] = [];
    install(makeForwardHandler(state, sink));

    initLifecycle(state);
    stopLifecycle(state);
    win.dataLayer.push({ event: 'purchase_while_stopped' });

    initLifecycle(state);
    win.dataLayer.push({ event: 'purchase_after_reinit' });

    expect(sink).toEqual([
      { event: 'purchase_while_stopped' },
      { event: 'purchase_after_reinit', visitorId: 'visitor-abc', sessionId: 'session-123' },
    ]);
  });
});
