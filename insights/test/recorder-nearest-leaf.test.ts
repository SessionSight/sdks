import { test, expect, describe } from 'bun:test';
import { Recorder } from '../src/recorder.js';

/**
 * Tests for the click-target refinement that fires when the user clicks
 * inside a container and misses every interactive child. Without it, the
 * click handler reads `target.textContent` recursively and produces labels
 * like "Report this job Open Research Tailor resume" instead of the
 * single button the user was aiming at.
 *
 * The helper is a private static so we access it via `(Recorder as any)`.
 * That bypasses the type modifier — runtime is unaffected.
 */

const findNearestClickedLeaf: (root: any, cx: number, cy: number) => any =
  (Recorder as any).findNearestClickedLeaf.bind(Recorder);

// Minimal DOM-shaped fake. Only the fields the algorithm reads:
//   - `getElementsByTagName('*')` for descendants (live HTMLCollection-ish)
//   - `getBoundingClientRect()`
//   - `matches(selector)` for the interactive check
//   - `childNodes` with text-node children for the own-text check
interface Rect { left: number; top: number; width: number; height: number }
interface FakeOpts {
  tag: string;
  rect: Rect;
  text?: string;
  interactive?: boolean;
  children?: FakeEl[];
}
class FakeEl {
  tagName: string;
  childNodes: Array<{ nodeType: number; textContent: string }>;
  children: FakeEl[];
  rect: Rect;
  interactive: boolean;
  constructor(opts: FakeOpts) {
    this.tagName = opts.tag.toUpperCase();
    this.rect = opts.rect;
    this.interactive = !!opts.interactive;
    this.children = opts.children ?? [];
    this.childNodes = [];
    if (opts.text) {
      this.childNodes.push({ nodeType: 3, textContent: opts.text });
    }
    // Element children show up in childNodes too; nodeType 1 (filtered out by
    // the own-text check, which only counts nodeType 3).
    for (const c of this.children) {
      this.childNodes.push({ nodeType: 1, textContent: '' } as any);
    }
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  matches(_selector: string): boolean {
    return this.interactive;
  }
  // Algorithm uses `getElementsByTagName('*')` to enumerate every descendant
  // in document order. Recursively flatten the tree.
  getElementsByTagName(sel: string): FakeEl[] {
    if (sel !== '*') throw new Error('only "*" supported in fake');
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

describe('findNearestClickedLeaf', () => {
  test('picks the nearest button when click lands in the gap between siblings', () => {
    // Footer button row: 4 buttons side-by-side with 8px gap. Click lands 1px
    // outside "Tailor resume". Before the fix, target.textContent concatenated
    // every label; now we refine to the closest button.
    const reportBtn = new FakeEl({ tag: 'button', rect: { left: 0, top: 0, width: 100, height: 30 }, text: 'Report this job', interactive: true });
    const openBtn = new FakeEl({ tag: 'button', rect: { left: 108, top: 0, width: 50, height: 30 }, text: 'Open', interactive: true });
    const researchBtn = new FakeEl({ tag: 'button', rect: { left: 166, top: 0, width: 80, height: 30 }, text: 'Research', interactive: true });
    const tailorBtn = new FakeEl({ tag: 'button', rect: { left: 254, top: 0, width: 110, height: 30 }, text: 'Tailor resume', interactive: true });
    const row = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 364, height: 30 },
      children: [reportBtn, openBtn, researchBtn, tailorBtn],
    });

    // Click at x=253 (1px before Tailor resume's left edge of 254). Closest
    // button by edge distance is tailorBtn (1px), researchBtn is 7px.
    const picked = findNearestClickedLeaf(row, 253, 15);
    expect(picked).toBe(tailorBtn);
  });

  test('prefers the smallest containing element over any "near" candidate', () => {
    // Outer label wraps an inner span; click is inside the inner span. We
    // want the inner span (smaller area) even though the outer label also
    // contains the click.
    const innerSpan = new FakeEl({ tag: 'span', rect: { left: 20, top: 10, width: 40, height: 20 }, text: 'inner' });
    const outerLabel = new FakeEl({
      tag: 'label',
      rect: { left: 0, top: 0, width: 200, height: 50 },
      text: 'outer prefix',
      interactive: true,
      children: [innerSpan],
    });
    const container = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 300, height: 80 },
      children: [outerLabel],
    });

    const picked = findNearestClickedLeaf(container, 30, 18);
    expect(picked).toBe(innerSpan);
  });

  test('returns null when the click is farther than the 32px miss radius', () => {
    // Single button on the far left. Click is 100px to its right with nothing
    // in between. We don't want to attribute clicks across that much empty
    // space — keep the container as the target.
    const lonelyBtn = new FakeEl({ tag: 'button', rect: { left: 0, top: 0, width: 40, height: 30 }, text: 'Solo', interactive: true });
    const container = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 500, height: 30 },
      children: [lonelyBtn],
    });
    expect(findNearestClickedLeaf(container, 140, 15)).toBeNull();
  });

  test('returns null when the container has no candidate descendants', () => {
    const container = new FakeEl({ tag: 'div', rect: { left: 0, top: 0, width: 100, height: 100 } });
    expect(findNearestClickedLeaf(container, 50, 50)).toBeNull();
  });

  test('skips children with zero-size rects so display:none nodes don\'t win', () => {
    // Hidden button has zero size, normal button is 10px away. Algorithm
    // must skip the hidden one and resolve to the visible one.
    const hidden = new FakeEl({ tag: 'button', rect: { left: 0, top: 0, width: 0, height: 0 }, text: 'Hidden', interactive: true });
    const visible = new FakeEl({ tag: 'button', rect: { left: 60, top: 0, width: 50, height: 30 }, text: 'Visible', interactive: true });
    const container = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 200, height: 30 },
      children: [hidden, visible],
    });
    expect(findNearestClickedLeaf(container, 55, 15)).toBe(visible);
  });

  test('counts an element as a candidate when it has its own text node, even if not interactive', () => {
    // Mimics a non-interactive heading inside a clicked container. We still
    // want it as a label candidate because it has direct text content.
    const heading = new FakeEl({ tag: 'h2', rect: { left: 10, top: 10, width: 100, height: 20 }, text: 'Section title' });
    const container = new FakeEl({
      tag: 'section',
      rect: { left: 0, top: 0, width: 300, height: 100 },
      children: [heading],
    });
    expect(findNearestClickedLeaf(container, 50, 18)).toBe(heading);
  });

  test('ignores a wrapping container that has no direct text and isn\'t interactive', () => {
    // A `<div>` that only HAS children with text (no direct text node, not
    // interactive) is exactly the kind of node we're trying to refine AWAY
    // from. The algorithm should reach into its children, not stop on it.
    const innerText = new FakeEl({ tag: 'span', rect: { left: 50, top: 10, width: 40, height: 20 }, text: 'leaf' });
    const wrapper = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 200, height: 40 },
      children: [innerText],
    });
    const container = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 400, height: 100 },
      children: [wrapper],
    });
    // Click is inside both wrapper and innerText; pick innerText (smaller).
    expect(findNearestClickedLeaf(container, 60, 18)).toBe(innerText);
  });

  test('bails out when the subtree exceeds the 400-node cap', () => {
    // Build a container with > 400 descendants. The cap should short-circuit
    // before we pay a getBoundingClientRect tax on every one.
    const kids: FakeEl[] = [];
    for (let i = 0; i < 401; i++) {
      kids.push(new FakeEl({
        tag: 'span',
        rect: { left: i, top: 0, width: 1, height: 1 },
        text: `t${i}`,
      }));
    }
    const container = new FakeEl({
      tag: 'div',
      rect: { left: 0, top: 0, width: 1000, height: 30 },
      children: kids,
    });
    expect(findNearestClickedLeaf(container, 200, 15)).toBeNull();
  });
});
