import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import { patchHistoryMethods } from '../src/index.js';

// The history patch installs itself exactly once per process. JSDOM gives us
// a real `history` to install against. All tests in this file share the same
// JSDOM (and therefore the same installed patch) and verify behavior at the
// subscriber-set layer, not the install-state layer.

let dom: JSDOM;
let origHistory: any;
let origWindow: any;
let origDocument: any;

beforeAll(() => {
  origHistory = (globalThis as any).history;
  origWindow = (globalThis as any).window;
  origDocument = (globalThis as any).document;

  dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://localhost/' });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).history = dom.window.history;
});

afterAll(() => {
  (globalThis as any).history = origHistory;
  (globalThis as any).window = origWindow;
  (globalThis as any).document = origDocument;
});

describe('patchHistoryMethods', () => {
  test('subscriber fires on pushState and receives no arguments', () => {
    let calls = 0;
    const unsubscribe = patchHistoryMethods(() => { calls += 1; });

    history.pushState({}, '', '/foo');
    expect(calls).toBe(1);

    history.pushState({}, '', '/bar');
    expect(calls).toBe(2);

    unsubscribe();
  });

  test('subscriber fires on replaceState', () => {
    let calls = 0;
    const unsubscribe = patchHistoryMethods(() => { calls += 1; });

    history.replaceState({}, '', '/replaced');
    expect(calls).toBe(1);

    unsubscribe();
  });

  test('unsubscribe stops further notifications', () => {
    let calls = 0;
    const unsubscribe = patchHistoryMethods(() => { calls += 1; });

    history.pushState({}, '', '/a');
    expect(calls).toBe(1);

    unsubscribe();
    history.pushState({}, '', '/b');
    expect(calls).toBe(1);
  });

  test('multiple subscribers all fire on a single pushState call', () => {
    let a = 0;
    let b = 0;
    const unsubA = patchHistoryMethods(() => { a += 1; });
    const unsubB = patchHistoryMethods(() => { b += 1; });

    history.pushState({}, '', '/two');
    expect(a).toBe(1);
    expect(b).toBe(1);

    unsubA();
    unsubB();
  });

  test('unsubscribing one leaves others firing', () => {
    let a = 0;
    let b = 0;
    const unsubA = patchHistoryMethods(() => { a += 1; });
    const unsubB = patchHistoryMethods(() => { b += 1; });

    unsubA();
    history.pushState({}, '', '/one-left');
    expect(a).toBe(0);
    expect(b).toBe(1);

    unsubB();
  });

  test('throwing subscriber does not block other subscribers or the underlying call', () => {
    let safe = 0;
    const unsubBoom = patchHistoryMethods(() => { throw new Error('boom'); });
    const unsubSafe = patchHistoryMethods(() => { safe += 1; });

    expect(() => history.pushState({}, '', '/throws')).not.toThrow();
    expect(safe).toBe(1);
    expect(window.location.pathname).toBe('/throws');

    unsubBoom();
    unsubSafe();
  });

  test('pushState arguments are forwarded to the underlying history', () => {
    const unsubscribe = patchHistoryMethods(() => {});

    history.pushState({ k: 'v' }, '', '/with-state?q=1');
    expect(window.location.pathname).toBe('/with-state');
    expect(window.location.search).toBe('?q=1');
    expect(history.state).toEqual({ k: 'v' });

    unsubscribe();
  });

  test('re-subscribing the same function reference adds it once (Set semantics)', () => {
    let calls = 0;
    const cb = () => { calls += 1; };
    const unsub1 = patchHistoryMethods(cb);
    const unsub2 = patchHistoryMethods(cb);

    history.pushState({}, '', '/once');
    expect(calls).toBe(1);

    // Either unsubscribe handle removes the singleton entry.
    unsub1();
    history.pushState({}, '', '/once-more');
    expect(calls).toBe(1);

    unsub2();
  });
});
