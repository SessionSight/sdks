import { test, expect, mock } from 'bun:test';

interface Call {
  method: string;
  args: unknown[];
}

const calls: Call[] = [];

const fakeSessionSight = {
  init: (...args: unknown[]) => { calls.push({ method: 'init', args }); },
};

mock.module('../src/index.js', () => ({
  default: fakeSessionSight,
}));

// No pre-existing proxy on window.SessionSight; iife should just install
// the real SDK and do nothing else. Covers the old sync snippet / direct
// ESM-like window assignment path.
(globalThis as any).window = {};

await import('../src/iife.js');

test('assigns real SDK to window.SessionSight when no queue exists', () => {
  expect((globalThis as any).window.SessionSight).toBe(fakeSessionSight);
});

test('invokes no methods when no queue exists', () => {
  expect(calls).toEqual([]);
});
