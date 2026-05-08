import { test, expect, mock } from 'bun:test';

interface Call {
  method: string;
  args: unknown[];
}

const calls: Call[] = [];

const fakeSessionSight = {
  init: (...args: unknown[]) => { calls.push({ method: 'init', args }); },
  identify: (...args: unknown[]) => { calls.push({ method: 'identify', args }); },
  setEnabled: (...args: unknown[]) => { calls.push({ method: 'setEnabled', args }); },
  record: (...args: unknown[]) => { calls.push({ method: 'record', args }); },
  stop: (...args: unknown[]) => { calls.push({ method: 'stop', args }); },
  getVisitorId: (...args: unknown[]) => {
    calls.push({ method: 'getVisitorId', args });
    return 'visitor-xyz';
  },
  goals: {
    increment: (...args: unknown[]) => {
      calls.push({ method: 'goals.increment', args });
      return { success: true };
    },
    decrement: (...args: unknown[]) => {
      calls.push({ method: 'goals.decrement', args });
      return { success: true };
    },
  },
};

mock.module('../src/index.js', () => ({
  default: fakeSessionSight,
}));

interface QueueEntry {
  p: string[];
  a: unknown[];
  rs?: (value: unknown) => void;
  rj?: (reason: unknown) => void;
}

// Dynamic-imports of '../src/iife.js' evaluate the module's top-level code
// exactly once (ES module caching). We therefore construct a single queue
// covering every case — ordered + unordered replay, void + data-returning
// methods, nested namespace, and a bogus path — and assert all outcomes
// from one replay pass.

const resolved: Array<{ path: string[]; value: unknown }> = [];
const rejected: Array<{ path: string[]; reason: unknown }> = [];

const queue: QueueEntry[] = [
  { p: ['init'], a: [{ publicApiKey: 'k1', propertyId: 'p1' }] },
  { p: ['identify'], a: ['user-1', { plan: 'pro' }] },
  { p: ['goals', 'increment'], a: ['signup'] },
  { p: ['getVisitorId'], a: [] },
  { p: ['nonexistent'], a: [] },
  { p: ['goals', 'alsoBogus'], a: [] },
  { p: ['stop'], a: [] },
];

for (const e of queue) {
  e.rs = (v: unknown) => { resolved.push({ path: e.p, value: v }); };
  e.rj = (r: unknown) => { rejected.push({ path: e.p, reason: r }); };
}

(globalThis as any).window = { _ssq: queue };

await import('../src/iife.js');

test('installs real SDK on window.SessionSight', () => {
  expect((globalThis as any).window.SessionSight).toBe(fakeSessionSight);
});

test('removes window._ssq after drain', () => {
  expect((globalThis as any).window._ssq).toBeUndefined();
});

test('replays all valid queued calls on the real SDK in insertion order', () => {
  expect(calls).toEqual([
    { method: 'init', args: [{ publicApiKey: 'k1', propertyId: 'p1' }] },
    { method: 'identify', args: ['user-1', { plan: 'pro' }] },
    { method: 'goals.increment', args: ['signup'] },
    { method: 'getVisitorId', args: [] },
    { method: 'stop', args: [] },
  ]);
});

test('resolves void-method entries with undefined', () => {
  const init = resolved.find(r => r.path.join('.') === 'init');
  const identify = resolved.find(r => r.path.join('.') === 'identify');
  const stop = resolved.find(r => r.path.join('.') === 'stop');
  expect(init).toEqual({ path: ['init'], value: undefined });
  expect(identify).toEqual({ path: ['identify'], value: undefined });
  expect(stop).toEqual({ path: ['stop'], value: undefined });
});

test('resolves data-returning entries with the real return value', () => {
  const inc = resolved.find(r => r.path.join('.') === 'goals.increment');
  const vid = resolved.find(r => r.path.join('.') === 'getVisitorId');
  expect(inc).toEqual({ path: ['goals', 'increment'], value: { success: true } });
  expect(vid).toEqual({ path: ['getVisitorId'], value: 'visitor-xyz' });
});

test('rejects entries whose path does not resolve to a function', () => {
  expect(rejected.length).toBe(2);
  const bogusTop = rejected.find(r => r.path.join('.') === 'nonexistent');
  const bogusNested = rejected.find(r => r.path.join('.') === 'goals.alsoBogus');
  expect(bogusTop).toBeDefined();
  expect((bogusTop!.reason as Error).message).toContain('nonexistent');
  expect(bogusNested).toBeDefined();
  expect((bogusNested!.reason as Error).message).toContain('goals.alsoBogus');
});
