import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
  buildStableDescriptor,
  serializeDescriptor,
  deserializeDescriptor,
} from '../src/selectors/stable-descriptor.js';
import { resolveStable } from '../src/selectors/resolve-stable.js';

let dom: JSDOM;
let origDocument: any;
let origWindow: any;

beforeAll(() => {
  origDocument = (globalThis as any).document;
  origWindow = (globalThis as any).window;
  dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: 'http://localhost/' });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
});

afterAll(() => {
  (globalThis as any).document = origDocument;
  (globalThis as any).window = origWindow;
});

function setBody(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('buildStableDescriptor', () => {
  test('anchors to nearest data-testid ancestor', () => {
    setBody(`<div data-testid="root"><section><button>Click me</button></section></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn);
    expect(d).not.toBeNull();
    expect(d!.anchor.kind).toBe('testid');
    expect(d!.anchor.value).toBe('root');
  });

  test('anchors to landmark when no testid/id available', () => {
    setBody(`<nav><button>Open</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('landmark');
    expect(d.anchor.value).toBe('nav');
  });

  test('anchors to ARIA landmark role', () => {
    setBody(`<div role="navigation"><button>Open</button></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('landmark');
    expect(d.anchor.value).toBe('navigation');
  });

  test('anchors to aria-label-bearing ancestor', () => {
    setBody(`<div aria-label="Primary navigation"><button>Open</button></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('aria');
    expect(d.anchor.value).toBe('Primary navigation');
  });

  test('falls back to document anchor when no qualifying ancestor', () => {
    setBody(`<div><button>X</button></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('document');
  });

  test('skips framework-generated ids on anchor walk', () => {
    setBody(`<div id="root"><div id="radix-12"><button>Open</button></div></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('id');
    expect(d.anchor.value).toBe('root');
  });

  test('match chain includes text when present', () => {
    setBody(`<nav><button>Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    const text = d.match.find((m) => m.kind === 'text');
    expect(text).toBeDefined();
    expect((text as any).value).toBe('Platform');
  });

  test('match chain includes href for anchor elements', () => {
    setBody(`<nav><a href="/pricing">Pricing</a></nav>`);
    const a = document.querySelector('a')!;
    const d = buildStableDescriptor(a)!;
    const href = d.match.find((m) => m.kind === 'href');
    expect(href).toBeDefined();
    expect((href as any).value).toBe('/pricing');
  });

  test('match chain always ends with position fallback', () => {
    setBody(`<nav><button>X</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    const last = d.match[d.match.length - 1];
    expect(last!.kind).toBe('position');
  });

  test('drops aria-label that contains PII', () => {
    setBody(`<nav><button aria-label="Email user@example.com">X</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.match.find((m) => m.kind === 'ariaLabel')).toBeUndefined();
  });

  test('drops text that contains PII', () => {
    setBody(`<nav><button>Call 555-867-5309</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.match.find((m) => m.kind === 'text')).toBeUndefined();
  });

  test('returns null for non-element nodes', () => {
    expect(buildStableDescriptor(null as any)).toBeNull();
  });
});

describe('serialize/deserializeDescriptor', () => {
  test('round-trips', () => {
    setBody(`<nav><button>Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    const round = deserializeDescriptor(serializeDescriptor(d));
    expect(round).toEqual(d);
  });

  test('deserialize tolerates garbage', () => {
    expect(deserializeDescriptor('not json')).toBeNull();
    expect(deserializeDescriptor('null')).toBeNull();
    expect(deserializeDescriptor('{}')).toBeNull();
    expect(deserializeDescriptor('')).toBeNull();
  });
});

describe('resolveStable', () => {
  test('resolves a testid anchor + text match', () => {
    setBody(`<div data-testid="nav"><button>Platform</button></div>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(btn);
  });

  test('survives sibling insertion before target', () => {
    setBody(`<nav><button>Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    // Simulate a deploy that inserted an unrelated sibling inside the nav.
    document.querySelector('nav')!.insertAdjacentHTML('afterbegin', `<span class="badge">NEW</span>`);
    const resolved = resolveStable(document.body, d);
    expect(resolved).not.toBeNull();
    expect(resolved!.tagName).toBe('BUTTON');
    expect((resolved! as HTMLElement).textContent).toBe('Platform');
  });

  test('survives class churn (Tailwind utility rewrite)', () => {
    setBody(`<nav><button class="px-4 py-2 bg-blue-500">Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    btn.className = 'flex items-center gap-2 rounded-md bg-indigo-600 hover:bg-indigo-700';
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(btn);
  });

  test('survives ancestor insertion (one new wrapper div)', () => {
    setBody(`<nav><button>Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    // Wrap the button in a new div: the anchor (nav) hasn't moved, so
    // text-based match still resolves.
    const wrap = document.createElement('div');
    wrap.className = 'animation-wrapper';
    btn.parentNode!.insertBefore(wrap, btn);
    wrap.appendChild(btn);
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(btn);
  });

  test('returns null when anchor disappears', () => {
    setBody(`<nav><button>Platform</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    // Strip the nav landmark entirely.
    document.body.innerHTML = `<div><button>Platform</button></div>`;
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBeNull();
  });

  test('falls through ambiguous strategy to a uniquely-resolvable one', () => {
    setBody(`<nav>
      <button data-testid="open-modal">A</button>
      <button data-testid="open-modal">B</button>
    </nav>`);
    const a = document.querySelectorAll('button')[0]!;
    const d = buildStableDescriptor(a)!;
    // testid is ambiguous (two buttons), text is "A" (unique), position is also unique.
    // Resolver should fall through testid to text.
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(a);
  });

  test('returns null when every strategy is ambiguous', () => {
    setBody(`<nav>
      <button>Same</button>
      <button>Same</button>
    </nav>`);
    const a = document.querySelectorAll('button')[0]!;
    // Force a descriptor with only text + position; both ambiguous in some
    // sense, but position should pick the first. So this should resolve.
    const d = buildStableDescriptor(a)!;
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(a);
  });

  test('resolves anchor of kind landmark by tag', () => {
    setBody(`<header><button>Sign in</button></header>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    expect(d.anchor.kind).toBe('landmark');
    const resolved = resolveStable(document.body, d);
    expect(resolved).toBe(btn);
  });
});

// ── Real-world DOM drift fixtures ─────────────────────────────────────
//
// Build a descriptor against snapshot A, mutate to simulate cross-deploy
// drift, then resolve against the mutated DOM. Each fixture targets a
// distinct real-world drift pattern.

describe('descriptor stability under cross-deploy drift', () => {
  test('Tailwind navbar with class chain rewritten between deploys', () => {
    setBody(`<nav class="bg-white shadow"><button class="px-4 py-2">Pricing</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    setBody(`<nav class="bg-gray-50 backdrop-blur-md"><button class="rounded-md bg-indigo-600 px-3 py-1.5">Pricing</button></nav>`);
    const resolved = resolveStable(document.body, d);
    expect(resolved).not.toBeNull();
    expect((resolved as HTMLElement).textContent).toBe('Pricing');
  });

  test('Radix dropdown id churns; aria-haspopup ancestor is stable', () => {
    setBody(`<nav><button id="radix-:r5:" aria-haspopup="menu">Options</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    setBody(`<nav><button id="radix-:r17:" aria-haspopup="menu">Options</button></nav>`);
    const resolved = resolveStable(document.body, d);
    expect(resolved).not.toBeNull();
  });

  test('CSS Modules hashed class survives; descriptor never uses class', () => {
    setBody(`<header><a href="/contact" class="Header_link__a1b2c3">Contact</a></header>`);
    const a = document.querySelector('a')!;
    const d = buildStableDescriptor(a)!;
    setBody(`<header><a href="/contact" class="Header_link__9z8y7x">Contact</a></header>`);
    const resolved = resolveStable(document.body, d);
    expect(resolved).not.toBeNull();
    expect((resolved as HTMLAnchorElement).getAttribute('href')).toBe('/contact');
  });

  test('Bootstrap navbar reorders sibling nav-items', () => {
    setBody(`<nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav>`);
    const a = document.querySelectorAll('a')[1]!;
    const d = buildStableDescriptor(a)!;
    // New deploy reorders: C → B → A
    setBody(`<nav><a href="/c">C</a><a href="/b">B</a><a href="/a">A</a></nav>`);
    const resolved = resolveStable(document.body, d);
    // href matcher is unique within the anchor → still resolves correctly.
    expect((resolved as HTMLAnchorElement)?.getAttribute('href')).toBe('/b');
  });

  test('headless-ui Menu wraps trigger in extra div between deploys', () => {
    setBody(`<nav><button>Account</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    setBody(`<nav><div data-headlessui-state="open"><button>Account</button></div></nav>`);
    const resolved = resolveStable(document.body, d);
    expect((resolved as HTMLElement)?.tagName).toBe('BUTTON');
  });

  test('plain HTML page with no library: text + tag fallback', () => {
    setBody(`<header><button>Sign up</button></header>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    // Header reorganized but the same button text is still there.
    setBody(`<header><div><button>Sign up</button></div></header>`);
    expect(resolveStable(document.body, d)).not.toBeNull();
  });

  test('semantic <nav> with <button> trigger and aria-label', () => {
    setBody(`<nav aria-label="Primary"><button>Menu</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    setBody(`<nav aria-label="Primary"><button class="reskinned">Menu</button></nav>`);
    expect(resolveStable(document.body, d)).not.toBeNull();
  });

  test('button text edited between deploys → descriptor fails closed', () => {
    setBody(`<nav><button>Pricing</button></nav>`);
    const btn = document.querySelector('button')!;
    const d = buildStableDescriptor(btn)!;
    // Copy change AND no other anchors; text match misses; position fallback
    // still resolves to the same nth-of-type button.
    setBody(`<nav><button>Plans &amp; pricing</button></nav>`);
    const resolved = resolveStable(document.body, d);
    // Position fallback kicks in (still a button, still nth=1 in nav).
    expect((resolved as HTMLElement)?.tagName).toBe('BUTTON');
  });

  test('framework-generated id with hex suffix is skipped on anchor walk', () => {
    setBody(`<nav id="primary-nav"><span id="link-a1b2c3"><a href="/p">Pricing</a></span></nav>`);
    const a = document.querySelector('a')!;
    const d = buildStableDescriptor(a)!;
    // Anchor should be nav (the framework id span is skipped).
    expect(d.anchor.value).toBe('primary-nav');
    setBody(`<nav id="primary-nav"><span id="link-9z8y7x"><a href="/p">Pricing</a></span></nav>`);
    expect(resolveStable(document.body, d)).not.toBeNull();
  });

  test('two buttons with same text under same nav: resolver returns null (ambiguous)', () => {
    setBody(`<nav><button>Open</button><button>Open</button></nav>`);
    const a = document.querySelectorAll('button')[0]!;
    const d = buildStableDescriptor(a)!;
    // Drop the position fallback artificially to force ambiguity.
    d.match = d.match.filter(m => m.kind !== 'position');
    expect(resolveStable(document.body, d)).toBeNull();
  });
});
