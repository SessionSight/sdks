import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { JSDOM } from 'jsdom';
import { buildStableSelector } from '../src/selectors/build-stable-selector.js';

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

describe('buildStableSelector', () => {
  test('prefers data-testid', () => {
    setBody(`<div><button id="x" data-testid="open-menu">Open</button></div>`);
    const btn = document.querySelector('button')!;
    expect(buildStableSelector(btn)).toBe('[data-testid="open-menu"]');
  });

  test('falls back to id when no data-testid', () => {
    setBody(`<div><button id="open-menu">Open</button></div>`);
    const btn = document.querySelector('button')!;
    expect(buildStableSelector(btn)).toBe('#open-menu');
  });

  test('skips framework-generated radix- ids and walks up', () => {
    setBody(`<nav id="main"><button id="radix-12">Open</button></nav>`);
    const btn = document.querySelector('button')!;
    // Should advance the priority chain (no aria-label here) and fall to nth-of-type,
    // then continue up to the stable nav#main parent.
    const sel = buildStableSelector(btn);
    expect(sel).toBe('#main > button:nth-of-type(1)');
  });

  test('skips React 18 useId :r* pattern', () => {
    setBody(`<section id="section-1"><div id=":r1:"><button>Open</button></div></section>`);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    // :r1: should be skipped; falls through to nth-of-type at the div level.
    expect(sel.startsWith('#section-1 >')).toBe(true);
    expect(sel.includes(':r1:')).toBe(false);
  });

  test('skips hex-suffix patterns (CSS modules)', () => {
    setBody(`<main id="root"><div id="menu-a1b2c3"><button>Open</button></div></main>`);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    expect(sel.includes('menu-a1b2c3')).toBe(false);
    expect(sel.startsWith('#root >')).toBe(true);
  });

  test('uses aria-label when no testid/id (and walks up for rooting)', () => {
    setBody(`<div id="bar"><button aria-label="Close dialog">X</button></div>`);
    const btn = document.querySelector('button')!;
    // aria-label is not uniquely rooted, so the walker continues up to the
    // stable parent id #bar.
    expect(buildStableSelector(btn)).toBe('#bar > [aria-label="Close dialog"]');
  });

  test('escapes double quotes in aria-label', () => {
    setBody(`<div id="bar"><button aria-label='Say "hi"'>X</button></div>`);
    const btn = document.querySelector('button')!;
    expect(buildStableSelector(btn)).toBe('#bar > [aria-label="Say \\"hi\\""]');
  });

  test('drops aria-label that contains PII (email)', () => {
    setBody(`<div id="bar"><button aria-label="Email user@example.com">X</button></div>`);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    expect(sel.includes('user@example.com')).toBe(false);
    expect(sel).toBe('#bar > button:nth-of-type(1)');
  });

  test('drops testid that contains PII', () => {
    setBody(`<div id="bar"><button data-testid="user-555-123-4567">X</button></div>`);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    expect(sel.includes('555-123-4567')).toBe(false);
  });

  test('falls back to nth-of-type when nothing else works', () => {
    setBody(`<div><span></span><span></span><span></span></div>`);
    const target = document.querySelectorAll('span')[2]!;
    const sel = buildStableSelector(target);
    expect(sel.endsWith('span:nth-of-type(3)')).toBe(true);
  });

  test('stops at uniquely-rooted ancestor (id)', () => {
    setBody(`<div id="root"><section><article><span>x</span></article></section></div>`);
    const span = document.querySelector('span')!;
    const sel = buildStableSelector(span);
    expect(sel.startsWith('#root > ')).toBe(true);
  });

  test('respects 200-char cap', () => {
    const deep = Array.from({ length: 60 }).map(() => '<div>').join('') + '<button>X</button>' + Array.from({ length: 60 }).map(() => '</div>').join('');
    setBody(deep);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    expect(sel.length).toBeLessThanOrEqual(200);
  });

  test('skips pure-numeric ids', () => {
    setBody(`<section id="root"><div id="12345"><button>X</button></div></section>`);
    const btn = document.querySelector('button')!;
    const sel = buildStableSelector(btn);
    expect(sel.includes('#12345')).toBe(false);
  });

  test('html / body short-circuit', () => {
    expect(buildStableSelector(document.body)).toBe('body');
    expect(buildStableSelector(document.documentElement)).toBe('html');
  });
});
