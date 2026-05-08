import { test, expect } from 'bun:test';
import { splitTestHash, assignVariation } from '../src/hash';

test('splitTestHash returns consistent results', () => {
  const h1 = splitTestHash('seed-abc', 'visitor-123');
  const h2 = splitTestHash('seed-abc', 'visitor-123');
  expect(h1).toBe(h2);
});

test('splitTestHash returns values in 0-9999', () => {
  for (let i = 0; i < 100; i++) {
    const h = splitTestHash(`seed-${i}`, `visitor-${i}`);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(10000);
  }
});

test('splitTestHash produces different values for different visitors', () => {
  const h1 = splitTestHash('seed', 'visitor-1');
  const h2 = splitTestHash('seed', 'visitor-2');
  expect(h1).not.toBe(h2);
});

test('splitTestHash produces different values for different seeds', () => {
  const h1 = splitTestHash('seed-a', 'visitor');
  const h2 = splitTestHash('seed-b', 'visitor');
  expect(h1).not.toBe(h2);
});

test('assignVariation puts visitor in test when within traffic allocation', () => {
  const result = assignVariation(500, 100, [
    { key: 'control', weight: 50 },
    { key: 'variant-a', weight: 50 },
  ]);
  expect(result.inTest).toBe(true);
});

test('assignVariation excludes visitor when outside traffic allocation', () => {
  const result = assignVariation(9500, 50, [
    { key: 'control', weight: 50 },
    { key: 'variant-a', weight: 50 },
  ]);
  expect(result.inTest).toBe(false);
  expect(result.variationIndex).toBe(0); // defaults to control
});

test('assignVariation distributes evenly with equal weights', () => {
  const counts = [0, 0];
  for (let i = 0; i < 10000; i++) {
    const result = assignVariation(i, 100, [
      { key: 'control', weight: 50 },
      { key: 'variant-a', weight: 50 },
    ]);
    counts[result.variationIndex]!++;
  }
  // Should be roughly 50/50
  expect(counts[0]).toBeGreaterThan(4000);
  expect(counts[0]).toBeLessThan(6000);
  expect(counts[1]).toBeGreaterThan(4000);
  expect(counts[1]).toBeLessThan(6000);
});

test('assignVariation respects unequal weights', () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 10000; i++) {
    const result = assignVariation(i, 100, [
      { key: 'control', weight: 70 },
      { key: 'variant-a', weight: 20 },
      { key: 'variant-b', weight: 10 },
    ]);
    counts[result.variationIndex]!++;
  }
  // control ~70%, variant-a ~20%, variant-b ~10%
  expect(counts[0]).toBeGreaterThan(6000);
  expect(counts[1]).toBeGreaterThan(1000);
  expect(counts[2]).toBeGreaterThan(500);
});

test('assignVariation handles zero traffic allocation', () => {
  const result = assignVariation(500, 0, [
    { key: 'control', weight: 50 },
    { key: 'variant-a', weight: 50 },
  ]);
  expect(result.inTest).toBe(false);
});
