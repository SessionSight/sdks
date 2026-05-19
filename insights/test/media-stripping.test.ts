import { test, expect, describe } from 'bun:test';
import { scrubMediaInEvent } from '../src/recorder.js';
import { SS_BLOCKED_ATTR, SS_ALLOW_ATTR, SS_MEDIA_SHIM, SS_HATCH_GRADIENT } from '@sessionsight/sdk-shared';

// Stripped src/href/poster values are replaced with SS_MEDIA_SHIM (a
// hatched SVG data URI) instead of an empty string so the browser
// doesn't render its native broken-image icon underneath the replayer's
// stand-in.
const STRIPPED = SS_MEDIA_SHIM;
// Stripped url() values inside style/cssText are replaced with the
// SS_HATCH_GRADIENT so the rule itself paints a visible placeholder
// pattern, even when the rule comes from captured stylesheet text
// where no per-element marker can be applied.
const STRIPPED_URL_VALUE = SS_HATCH_GRADIENT;

// ── Stubs ──────────────────────────────────────────────────────────
//
// scrubMediaInEvent reads two things from the live DOM via the rrweb
// mirror: element dimensions (naturalWidth/videoWidth/getBoundingClientRect)
// and `data-ss-allow` ancestry (closest()). Build a minimal mirror+element
// shim that exposes those without dragging in jsdom.

interface ElementOpts {
  tagName: string;
  attrs?: Record<string, string>;
  ancestorAllow?: boolean; // simulate `closest('[data-ss-allow]')` resolving to a non-null ancestor
  naturalWidth?: number;
  naturalHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
  rect?: { width: number; height: number };
}

function makeElement(opts: ElementOpts): any {
  const attrs = opts.attrs ?? {};
  const tagName = opts.tagName.toUpperCase();
  return {
    nodeType: 1,
    tagName,
    naturalWidth: opts.naturalWidth ?? 0,
    naturalHeight: opts.naturalHeight ?? 0,
    videoWidth: opts.videoWidth ?? 0,
    videoHeight: opts.videoHeight ?? 0,
    hasAttribute: (n: string) => n in attrs,
    getAttribute: (n: string) => (n in attrs ? attrs[n]! : null),
    getBoundingClientRect: () => ({
      width: opts.rect?.width ?? 0,
      height: opts.rect?.height ?? 0,
    }),
    closest: (selector: string) => {
      // Simple matcher for our needs: only `[data-ss-allow]`.
      if (selector === `[${SS_ALLOW_ATTR}]`) {
        if (SS_ALLOW_ATTR in attrs) return { hasAttribute: () => true };
        return opts.ancestorAllow ? { hasAttribute: () => true } : null;
      }
      return null;
    },
  };
}

function makeMirror(map: Record<number, any>) {
  return {
    getNode: (id: number) => map[id] ?? null,
  };
}

// FullSnapshot envelope helper.
function fullSnapshot(rootNode: any) {
  return {
    type: 2,
    timestamp: 1,
    data: { node: rootNode },
  } as any;
}

function elNode(id: number, tagName: string, attributes: Record<string, any>, childNodes: any[] = []) {
  return { type: 2, id, tagName, attributes, childNodes };
}

function textNode(textContent: string) {
  return { type: 3, textContent, childNodes: [] };
}

// ── FullSnapshot: <img> ─────────────────────────────────────────────

describe('scrubMediaInEvent:FullSnapshot <img>', () => {
  test('clears src+srcset and marks data-ss-blocked', () => {
    const ev = fullSnapshot(elNode(1, 'img', { src: 'https://cdn/x.png', srcset: 'https://a 1x, https://b 2x' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img' }) });
    scrubMediaInEvent(ev, mirror);
    const node = ev.data.node;
    expect(node.attributes.src).toBe(STRIPPED);
    expect(node.attributes.srcset).toBe('');
    expect(node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('preserves explicit width/height', () => {
    const ev = fullSnapshot(elNode(1, 'img', { src: 'https://cdn/x.png', width: '100', height: '50' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img', naturalWidth: 999, naturalHeight: 888 }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.width).toBe('100');
    expect(ev.data.node.attributes.height).toBe('50');
  });

  test('writes naturalWidth/naturalHeight when missing', () => {
    const ev = fullSnapshot(elNode(1, 'img', { src: 'https://cdn/x.png' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img', naturalWidth: 320, naturalHeight: 240 }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.width).toBe('320');
    expect(ev.data.node.attributes.height).toBe('240');
  });

  test('falls back to bounding rect for inline aspect-ratio when natural dims are zero', () => {
    // Width/height attributes only come from intrinsic dims (so the
    // replay element's natural size matches the original media). When
    // intrinsic isn't available the rendered bounding rect is used as
    // a backup signal, but only to pin the aspect-ratio inline,
    // because the bounding rect reflects post-CSS sizing rather than
    // the underlying media's natural size.
    const ev = fullSnapshot(elNode(1, 'img', { src: 'https://cdn/x.png' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', naturalWidth: 0, naturalHeight: 0, rect: { width: 200, height: 120 } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.style).toContain('aspect-ratio: 200 / 120');
  });
});

// ── FullSnapshot: <video> + <audio> ─────────────────────────────────

describe('scrubMediaInEvent:FullSnapshot <video>', () => {
  test('clears src + poster, marks blocked, preserves dims, pins aspect-ratio', () => {
    const ev = fullSnapshot(elNode(1, 'video', {
      src: 'https://cdn/v.mp4', poster: 'https://cdn/thumb.jpg', width: '640', height: '360',
    }));
    // Pre-metadata: videoWidth/Height are zero; the bounding rect
    // (driven by the live element's CSS-applied size) feeds the
    // aspect-ratio pin.
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video', videoWidth: 0, videoHeight: 0, rect: { width: 640, height: 360 } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe(STRIPPED);
    expect(ev.data.node.attributes.poster).toBe(STRIPPED);
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
    expect(ev.data.node.attributes.width).toBe('640');
    expect(ev.data.node.attributes.height).toBe('360');
    // Inline aspect-ratio pin: load-bearing under Tailwind's preflight
    // (height:auto on img/video). Without it, the shim's 1:1 SVG
    // intrinsic would collapse a 640×360 video into a 640×640 square.
    expect(ev.data.node.attributes.style).toContain('aspect-ratio: 640 / 360');
  });

  test('captures videoWidth/videoHeight when no explicit dims', () => {
    const ev = fullSnapshot(elNode(1, 'video', { src: 'https://cdn/v.mp4' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'video', videoWidth: 1280, videoHeight: 720 }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.width).toBe('1280');
    expect(ev.data.node.attributes.height).toBe('720');
  });

  test('falls back to bounding rect for inline aspect-ratio when videoWidth is zero (metadata not loaded)', () => {
    // See the parallel <img> case above; width/height attrs only come
    // from intrinsic dims; bounding rect feeds the aspect-ratio pin.
    const ev = fullSnapshot(elNode(1, 'video', { src: 'https://cdn/v.mp4' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video', videoWidth: 0, videoHeight: 0, rect: { width: 800, height: 450 } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.style).toContain('aspect-ratio: 800 / 450');
  });

  test('clears <source src> children inside <video>', () => {
    const ev = fullSnapshot(elNode(1, 'video', {}, [
      elNode(2, 'source', { src: 'https://cdn/x.mp4', type: 'video/mp4' }),
    ]));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video' }),
      2: makeElement({ tagName: 'source' }),
    });
    scrubMediaInEvent(ev, mirror);
    const src = ev.data.node.childNodes[0]!;
    expect(src.attributes.src).toBe(STRIPPED);
    expect(src.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('strips data: poster unconditionally even when opted in', () => {
    const ev = fullSnapshot(elNode(1, 'video', {
      [SS_ALLOW_ATTR]: '',
      src: 'https://cdn/v.mp4',
      poster: 'data:image/png;base64,iVBOR',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    // src is URL form + opted in -> survives
    expect(ev.data.node.attributes.src).toBe('https://cdn/v.mp4');
    // poster is data: -> stripped unconditionally
    expect(ev.data.node.attributes.poster).toBe(STRIPPED);
  });
});

describe('scrubMediaInEvent:FullSnapshot <audio>', () => {
  test('clears src and marks blocked, no width/height added', () => {
    const ev = fullSnapshot(elNode(1, 'audio', { src: 'https://cdn/a.mp3' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'audio' }) });
    scrubMediaInEvent(ev, mirror);
    const attrs = ev.data.node.attributes;
    expect(attrs.src).toBe(STRIPPED);
    expect(attrs[SS_BLOCKED_ATTR]).toBe('');
    expect('width' in attrs).toBe(false);
    expect('height' in attrs).toBe(false);
  });

  test('clears <source src> children inside <audio>', () => {
    const ev = fullSnapshot(elNode(1, 'audio', {}, [
      elNode(2, 'source', { src: 'https://cdn/a.mp3', type: 'audio/mpeg' }),
    ]));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'audio' }),
      2: makeElement({ tagName: 'source' }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.childNodes[0]!.attributes.src).toBe(STRIPPED);
  });

  test('opt-in keeps URL src, no marker', () => {
    const ev = fullSnapshot(elNode(1, 'audio', { [SS_ALLOW_ATTR]: '', src: 'https://cdn/sample.mp3' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'audio', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe('https://cdn/sample.mp3');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('strips data: audio unconditionally even when opted in', () => {
    const ev = fullSnapshot(elNode(1, 'audio', { [SS_ALLOW_ATTR]: '', src: 'data:audio/mpeg;base64,SUQz' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'audio', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe(STRIPPED);
  });
});

// ── blob: URL handling ──────────────────────────────────────────────
//
// Same liability class as data: URIs (we can't rehydrate them on replay
// anyway, and they're commonly user-uploaded content). Should always
// strip even with data-ss-allow on the element.

describe('scrubMediaInEvent:blob: URLs', () => {
  test('clears <img src="blob:...">', () => {
    const ev = fullSnapshot(elNode(1, 'img', { src: 'blob:https://example.com/abc-123' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe(STRIPPED);
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('clears <video src="blob:..."> and <audio src="blob:...">', () => {
    const ev = fullSnapshot({
      type: 0,
      childNodes: [
        elNode(1, 'video', { src: 'blob:https://example.com/v', poster: 'blob:https://example.com/p' }),
        elNode(2, 'audio', { src: 'blob:https://example.com/a' }),
      ],
    });
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video' }),
      2: makeElement({ tagName: 'audio' }),
    });
    scrubMediaInEvent(ev, mirror);
    const [vid, aud] = ev.data.node.childNodes;
    expect(vid.attributes.src).toBe(STRIPPED);
    expect(vid.attributes.poster).toBe(STRIPPED);
    expect(aud.attributes.src).toBe(STRIPPED);
  });

  test('strips blob: even when opted in (parity with data: URIs)', () => {
    const ev = fullSnapshot(elNode(1, 'img', { [SS_ALLOW_ATTR]: '', src: 'blob:https://example.com/x' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe(STRIPPED);
  });

  test('opt-in srcset drops blob: entries while keeping URL entries', () => {
    const ev = fullSnapshot(elNode(1, 'img', {
      [SS_ALLOW_ATTR]: '',
      srcset: 'https://a.png 1x, blob:https://example.com/x 2x',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.srcset).toContain('https://a.png');
    expect(ev.data.node.attributes.srcset).not.toContain('blob:');
  });

  test('source 13 StyleDeclaration: blob: in url() strips even when opted in', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, set: { property: 'background-image', value: 'url(blob:https://example.com/x)' } },
    };
    const mirror = makeMirror({
      1: makeElement({ tagName: 'div', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.set.value).not.toContain('blob:');
  });
});

// ── Opt-in on <video> with all sources ──────────────────────────────

describe('scrubMediaInEvent:<video> opt-in coverage', () => {
  test('opted-in <video> keeps URL src and poster', () => {
    const ev = fullSnapshot(elNode(1, 'video', {
      [SS_ALLOW_ATTR]: '',
      src: 'https://cdn/promo.mp4',
      poster: 'https://cdn/cover.jpg',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'video', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toContain('promo.mp4');
    expect(ev.data.node.attributes.poster).toContain('cover.jpg');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });
});

// ── Absolutification of opt-in URLs ─────────────────────────────────

describe('scrubMediaInEvent:opt-in URL absolutification', () => {
  test('relative src on opted-in <img> is absolutified against document.baseURI', () => {
    const ev = fullSnapshot(elNode(1, 'img', { [SS_ALLOW_ATTR]: '', src: '/test-image.png' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    // Without document, absolutify falls back to the http://localhost/ base.
    scrubMediaInEvent(ev, mirror);
    const src: string = ev.data.node.attributes.src;
    // Either an absolute URL (test environment has document.baseURI) or
    // unchanged (no document available). In both cases the path piece
    // survives.
    expect(src).toContain('test-image.png');
    expect(src).toMatch(/^https?:\/\//);
  });

  test('opted-in srcset with a data: URI entry: data entry dropped, URL entry preserved (regression: comma-in-data-URI no longer shreds the parse)', () => {
    // Realistic shape: a customer's <picture>/<img> srcset that contains
    // a base64 data URI as the 2x option. The naive split-on-comma
    // parser was eating a piece of the data URI as a separate "URL"
    // and shipping it to the replayer as a broken-link path. The
    // proper srcset parser anchors on `Nx`/`Nw` descriptor terminators.
    const ev = fullSnapshot(elNode(1, 'img', {
      [SS_ALLOW_ATTR]: '',
      src: '/test-image.png',
      srcset: '/test-image.png 1x, data:image/png;base64,AAAA,BBBB,CCCC 2x',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    const srcset: string = ev.data.node.attributes.srcset;
    // The URL entry survives (absolutified).
    expect(srcset).toContain('test-image.png 1x');
    // No fragment of the data URI made it into the rebuilt srcset.
    expect(srcset).not.toContain('data:');
    expect(srcset).not.toContain('AAAA');
    expect(srcset).not.toContain('BBBB');
    expect(srcset).not.toContain('CCCC');
  });

  test('opted-in srcset URL entries are absolutified per-entry', () => {
    const ev = fullSnapshot(elNode(1, 'img', {
      [SS_ALLOW_ATTR]: '',
      srcset: '/img/1x.png 1x, /img/2x.png 2x',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    const srcset: string = ev.data.node.attributes.srcset;
    expect(srcset).toContain('1x.png 1x');
    expect(srcset).toContain('2x.png 2x');
    expect(srcset).toMatch(/^https?:\/\//);
  });
});

// ── Inline style ────────────────────────────────────────────────────

describe('scrubMediaInEvent:inline style', () => {
  test('strips background-image url() but preserves other declarations', () => {
    const ev = fullSnapshot(elNode(1, 'div', {
      style: 'background-image: url(https://cdn/hero.jpg) no-repeat center; color: red',
    }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    const style: string = ev.data.node.attributes.style;
    expect(style).toContain('color: red');
    expect(style).toContain('no-repeat center');
    expect(style).not.toContain('https://cdn/hero.jpg');
    // The url() is replaced with a hatch gradient so the rule itself
    // paints the placeholder pattern (the marker-driven CSS overlay
    // handles the text label).
    expect(style).toContain('repeating-linear-gradient');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  // Cover every URL-bearing CSS property in URL_BEARING_CSS_PROPERTIES
  // individually so a regression in the property list (e.g. someone
  // forgetting to add a new one) shows up as a targeted failure rather
  // than a single 'background-image' green bar.
  const urlBearingCases: Array<{ prop: string; before: string; expectIn?: string }> = [
    { prop: 'background', before: 'background: url(https://x.png) center/cover no-repeat #000', expectIn: '#000' },
    { prop: 'mask-image', before: 'mask-image: url(https://x.png)', expectIn: 'mask-image' },
    { prop: 'border-image', before: 'border-image: url(https://x.png) 30 round', expectIn: '30 round' },
    { prop: 'list-style-image', before: 'list-style-image: url(https://x.png)', expectIn: 'list-style-image' },
    { prop: 'cursor', before: 'cursor: url(https://x.png), auto', expectIn: 'auto' },
  ];

  for (const c of urlBearingCases) {
    test(`strips url() in ${c.prop}`, () => {
      const ev = fullSnapshot(elNode(1, 'div', { style: c.before }));
      const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
      scrubMediaInEvent(ev, mirror);
      const style: string = ev.data.node.attributes.style;
      expect(style).not.toContain('https://x.png');
      expect(style).toContain('repeating-linear-gradient');
      if (c.expectIn) expect(style).toContain(c.expectIn);
      expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
    });
  }

  test('non-URL-bearing properties (color, padding) are not touched even when they happen to contain "url"', () => {
    // Defensive: confirm we don't sloppily run url() regex on every property.
    const ev = fullSnapshot(elNode(1, 'div', {
      style: 'color: red; --my-url: url(https://x.png)',
    }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    // CSS custom property '--my-url' is not in URL_BEARING_CSS_PROPERTIES,
    // so it survives. (Customers using --my-bg: url() for theme tokens
    // would expect this; they declare the actual usage via
    // background-image: var(--my-bg), which strips at the usage site.)
    expect(ev.data.node.attributes.style).toContain('https://x.png');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('multiple URL-bearing properties on the same element all strip', () => {
    const ev = fullSnapshot(elNode(1, 'div', {
      style: 'background-image: url(/a.png); mask-image: url(/b.png); color: red',
    }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    const style: string = ev.data.node.attributes.style;
    expect(style).not.toContain('/a.png');
    expect(style).not.toContain('/b.png');
    expect(style).toContain('color: red');
  });

  test('does not mark elements whose style has no url() refs', () => {
    const ev = fullSnapshot(elNode(1, 'div', { style: 'color: red' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('opt-in via ancestry preserves background-image url()', () => {
    const ev = fullSnapshot(elNode(1, 'section', {
      style: 'background-image: url(https://cdn/hero.jpg)',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'section', ancestorAllow: true }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.style).toContain('https://cdn/hero.jpg');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
    // marker copied down for server-side honoring
    expect(ev.data.node.attributes[SS_ALLOW_ATTR]).toBe('');
  });
});

// ── Captured stylesheet text ────────────────────────────────────────

describe('scrubMediaInEvent:_cssText on <style>', () => {
  test('strips url() references but preserves @font-face', () => {
    const css = `@font-face { src: url(/fonts/Inter.woff2) format('woff2'); }
body { background-image: url(/img/bg.png); color: black; }
.icon { background: url("/img/icon.svg") no-repeat; }`;
    const ev = fullSnapshot(elNode(1, 'style', { _cssText: css }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'style' }) });
    scrubMediaInEvent(ev, mirror);
    const out: string = ev.data.node.attributes._cssText;
    expect(out).toContain('Inter.woff2'); // @font-face survives
    expect(out).not.toContain('/img/bg.png');
    expect(out).not.toContain('/img/icon.svg');
    // No per-element marker for stylesheet-text strips.
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('also strips text-node child of <style> (belt-and-suspenders)', () => {
    const child = textNode('body { background: url(/img/bg.png) }');
    const ev = fullSnapshot(elNode(1, 'style', { _cssText: 'body { background: url(/img/bg.png) }' }, [child]));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'style' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes._cssText).not.toContain('/img/bg.png');
    expect(ev.data.node.childNodes[0]!.textContent).not.toContain('/img/bg.png');
  });

  test('strips text-node child even with no _cssText, font-face skip applies', () => {
    const css = '@font-face { src: url(/Inter.woff2) }\nbody { background: url(/bg.png) }';
    const child = textNode(css);
    const ev = fullSnapshot(elNode(1, 'style', {}, [child]));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'style' }) });
    scrubMediaInEvent(ev, mirror);
    const out: string = ev.data.node.childNodes[0]!.textContent;
    expect(out).toContain('Inter.woff2');
    expect(out).not.toContain('/bg.png');
  });

  test('opt-in does not apply to stylesheet text', () => {
    const ev = fullSnapshot(elNode(1, 'style', {
      [SS_ALLOW_ATTR]: '',
      _cssText: 'body { background: url(/bg.png) }',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'style', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes._cssText).not.toContain('/bg.png');
  });
});

// ── Mutations ───────────────────────────────────────────────────────

describe('scrubMediaInEvent:Mutation source 0', () => {
  test('scrubs adds[].node tree', () => {
    const ev: any = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        adds: [{ parentId: 0, node: elNode(1, 'img', { src: 'https://cdn/x.png' }) }],
      },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.adds[0].node.attributes.src).toBe(STRIPPED);
    expect(ev.data.adds[0].node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('scrubs attribute deltas: src on existing img', () => {
    const ev: any = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        attributes: [{ id: 1, attributes: { src: 'https://cdn/new.png' } }],
      },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.attributes[0].attributes.src).toBe(STRIPPED);
    expect(ev.data.attributes[0].attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('scrubs attribute delta srcset with strip marker', () => {
    const ev: any = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        attributes: [{ id: 1, attributes: { srcset: 'https://a 1x, https://b 2x' } }],
      },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'img' }) });
    scrubMediaInEvent(ev, mirror);
    // srcset cleared. No marker on srcset-only deltas: we have no signal
    // that the element's primary src has been stripped (the original src
    // may still be in place from the FullSnapshot, where the marker was
    // applied if needed).
    expect(ev.data.attributes[0].attributes.srcset).toBe('');
    expect(ev.data.attributes[0].attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('scrubs attribute delta with style adding background-image', () => {
    const ev: any = {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        attributes: [{ id: 1, attributes: { style: 'background-image: url(https://x); color: blue' } }],
      },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    const style: string = ev.data.attributes[0].attributes.style;
    expect(style).not.toContain('https://x');
    expect(style).toContain('color: blue');
    expect(ev.data.attributes[0].attributes[SS_BLOCKED_ATTR]).toBe('');
  });
});

// ── source 8: StyleSheetRule ────────────────────────────────────────

describe('scrubMediaInEvent:source 8 StyleSheetRule', () => {
  test('strips url() in adds[].rule but preserves @font-face', () => {
    const ev: any = {
      type: 3,
      timestamp: 1,
      data: {
        source: 8,
        adds: [
          { rule: 'body { background: url(https://x.png) }' },
          { rule: '@font-face { src: url(/Inter.woff2) }' },
        ],
      },
    };
    scrubMediaInEvent(ev, null);
    expect(ev.data.adds[0].rule).not.toContain('https://x.png');
    expect(ev.data.adds[1].rule).toContain('/Inter.woff2');
  });

  test('strips replace and replaceSync', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 8, replace: 'body { background: url(https://r.png) }', replaceSync: '.x { background: url(/s.png) }' },
    };
    scrubMediaInEvent(ev, null);
    expect(ev.data.replace).not.toContain('https://r.png');
    expect(ev.data.replaceSync).not.toContain('/s.png');
  });

  test('removes-only event is a no-op', () => {
    const ev: any = { type: 3, timestamp: 1, data: { source: 8, removes: [{ index: 0 }] } };
    scrubMediaInEvent(ev, null);
    expect(ev.data.removes).toEqual([{ index: 0 }]);
  });
});

// ── source 13: StyleDeclaration ─────────────────────────────────────

describe('scrubMediaInEvent:source 13 StyleDeclaration', () => {
  test('strips url() value when property is URL-bearing', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, set: { property: 'background-image', value: 'url(https://x.png)' } },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.set.value).not.toContain('https://x.png');
    expect(ev.data.set.value).toBe(STRIPPED_URL_VALUE);
  });

  test('untouched when property is not URL-bearing', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, set: { property: 'color', value: 'red' } },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.set.value).toBe('red');
  });

  test('opt-in URL value survives unstripped', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, set: { property: 'background-image', value: 'url(https://x.png)' } },
    };
    const mirror = makeMirror({
      1: makeElement({ tagName: 'div', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.set.value).toContain('https://x.png');
  });

  test('data: URI strips even when opted in', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, set: { property: 'background-image', value: 'url(data:image/png;base64,xx)' } },
    };
    const mirror = makeMirror({
      1: makeElement({ tagName: 'div', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.set.value).not.toContain('data:image');
  });

  test('remove event with no set is a no-op', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: { source: 13, id: 1, index: 0, remove: { property: 'background-image' } },
    };
    const mirror = makeMirror({ 1: makeElement({ tagName: 'div' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.remove).toEqual({ property: 'background-image' });
  });
});

// ── source 15: AdoptedStyleSheet ────────────────────────────────────

describe('scrubMediaInEvent:source 15 AdoptedStyleSheet', () => {
  test('strips background url() but preserves @font-face', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: {
        source: 15,
        id: 1,
        styles: [
          {
            styleId: 1,
            rules: [
              { rule: 'body { background: url(https://x.png) }' },
              { rule: '@font-face { src: url(/Inter.woff2) }' },
            ],
          },
        ],
        styleIds: [1],
      },
    };
    scrubMediaInEvent(ev, null);
    expect(ev.data.styles[0].rules[0].rule).not.toContain('https://x.png');
    expect(ev.data.styles[0].rules[1].rule).toContain('/Inter.woff2');
  });

  test('opt-in does not apply (document-global)', () => {
    const ev: any = {
      type: 3, timestamp: 1,
      data: {
        source: 15,
        id: 1,
        styles: [{ styleId: 1, rules: [{ rule: 'body { background: url(/x.png) }' }] }],
        styleIds: [1],
      },
    };
    const mirror = makeMirror({
      1: makeElement({ tagName: 'div', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.styles[0].rules[0].rule).not.toContain('/x.png');
  });
});

// ── <picture>, <source srcset>, SVG <image>, <use> ──────────────────

describe('scrubMediaInEvent:picture, SVG image, use', () => {
  test('<source srcset> inside <picture> is stripped', () => {
    const ev = fullSnapshot(elNode(1, 'picture', {}, [
      elNode(2, 'source', { srcset: 'https://a 1x' }),
      elNode(3, 'img', { src: 'https://fallback.png' }),
    ]));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'picture' }),
      2: makeElement({ tagName: 'source' }),
      3: makeElement({ tagName: 'img' }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.childNodes[0]!.attributes.srcset).toBe('');
    expect(ev.data.node.childNodes[1]!.attributes.src).toBe(STRIPPED);
  });

  test('SVG <image> raster embed is stripped', () => {
    const ev = fullSnapshot(elNode(1, 'image', {
      href: 'https://x.png',
      'xlink:href': 'https://y.png',
    }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'image' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.href).toBe(STRIPPED);
    expect(ev.data.node.attributes['xlink:href']).toBe(STRIPPED);
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('SVG <use href="#icon"> is untouched', () => {
    const ev = fullSnapshot(elNode(1, 'use', { href: '#icon' }));
    const mirror = makeMirror({ 1: makeElement({ tagName: 'use' }) });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.href).toBe('#icon');
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('mixed <picture>: data URI source dropped, URL sources stripped (no opt-in)', () => {
    const ev = fullSnapshot(elNode(1, 'picture', {}, [
      elNode(2, 'source', { srcset: 'https://a.png 1x' }),
      elNode(3, 'source', { srcset: 'data:image/png;base64,xx 2x' }),
      elNode(4, 'img', { src: 'https://fallback.png' }),
    ]));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'picture' }),
      2: makeElement({ tagName: 'source' }),
      3: makeElement({ tagName: 'source' }),
      4: makeElement({ tagName: 'img' }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.childNodes[0]!.attributes.srcset).toBe('');
    expect(ev.data.node.childNodes[1]!.attributes.srcset).toBe('');
    expect(ev.data.node.childNodes[2]!.attributes.src).toBe(STRIPPED);
  });
});

// ── Opt-in semantics ────────────────────────────────────────────────

describe('scrubMediaInEvent:data-ss-allow opt-in', () => {
  test('opt-in on element survives URL src, no marker', () => {
    const ev = fullSnapshot(elNode(1, 'img', { [SS_ALLOW_ATTR]: '', src: 'https://logo.png' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    // URL is absolutified so the replay iframe (which lives under
    // SessionSight's origin) can fetch the asset from the customer's
    // origin. The host portion survives unchanged; only relative paths
    // become absolute.
    expect(ev.data.node.attributes.src).toContain('logo.png');
    expect(ev.data.node.attributes.src).toMatch(/^https?:\/\//);
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBeUndefined();
  });

  test('value-ignored: data-ss-allow="false" still opts in', () => {
    const ev = fullSnapshot(elNode(1, 'img', { [SS_ALLOW_ATTR]: 'false', src: 'https://x.png' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: 'false' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toContain('x.png');
    expect(ev.data.node.attributes.src).toMatch(/^https?:\/\//);
  });

  test('opt-in inheritance: ancestor allow propagates and copies marker down', () => {
    const ev = fullSnapshot(elNode(1, 'img', { src: 'https://x.png' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', ancestorAllow: true }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toContain('x.png');
    expect(ev.data.node.attributes[SS_ALLOW_ATTR]).toBe('');
  });

  test('opt-in does not honor data: URIs', () => {
    const ev = fullSnapshot(elNode(1, 'img', { [SS_ALLOW_ATTR]: '', src: 'data:image/png;base64,xx' }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.src).toBe(STRIPPED);
    // Marker IS set even though the element was opted in: the data:-strip
    // shimmed the primary attribute, so the replayer needs to render a
    // stand-in (the original case where the placeholder was missing).
    expect(ev.data.node.attributes[SS_BLOCKED_ATTR]).toBe('');
  });

  test('opt-in mixed srcset: URL entries kept, data: dropped', () => {
    const ev = fullSnapshot(elNode(1, 'img', {
      [SS_ALLOW_ATTR]: '',
      src: 'https://a.png',
      srcset: 'https://b.png 1x, data:image/png;base64,xx 2x',
    }));
    const mirror = makeMirror({
      1: makeElement({ tagName: 'img', attrs: { [SS_ALLOW_ATTR]: '' } }),
    });
    scrubMediaInEvent(ev, mirror);
    expect(ev.data.node.attributes.srcset).toContain('https://b.png');
    expect(ev.data.node.attributes.srcset).not.toContain('data:image');
  });
});
