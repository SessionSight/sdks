import type { record as rrwebRecord, eventWithTime } from 'rrweb';
import { WorkerBridge } from './worker-bridge.js';
import {
  getRegistryValue,
  redactString,
  stripUrlQuery,
  REDACTED,
  SS_BLOCKED_ATTR,
  SS_ALLOW_ATTR,
  SS_MEDIA_SHIM,
  stripStylesheetUrls,
  stripInlineStyleUrls,
  isEmbeddedMediaUrl,
  filterSrcsetForEmbeddedUrls,
  parseSrcset,
} from '@sessionsight/sdk-shared';
import type { SessionMetadata, RecordOptions, PrivacyConfig } from './types.js';

const PRE_BUFFER_MAX_MS = 5_000;
const FLAG_CHECK_INTERVAL_MS = 6_000;

// ── Lazy rrweb loader ─────────────────────────────────────────────
// rrweb is dynamically imported so the SDK can survive ad blockers,
// CSPs, and network failures that prevent rrweb from loading. If the
// import rejects, session recording is silently disabled but the rest
// of the SDK (identify, custom events, transport) keeps working.
let recordFn: typeof rrwebRecord | null = null;
let rrwebLoadPromise: Promise<typeof rrwebRecord | null> | null = null;
let rrwebLoadFailureLogged = false;

function loadRrweb(): Promise<typeof rrwebRecord | null> {
  if (recordFn) return Promise.resolve(recordFn);
  if (rrwebLoadPromise) return rrwebLoadPromise;
  rrwebLoadPromise = import('rrweb').then(
    (mod) => {
      recordFn = mod.record;
      return recordFn;
    },
    (e) => {
      if (!rrwebLoadFailureLogged) {
        rrwebLoadFailureLogged = true;
        console.warn(
          'SessionSight: rrweb failed to load (likely blocked by a browser extension, CSP, or network failure). Session recording is disabled; other SDK features remain active.',
          e,
        );
      }
      rrwebLoadPromise = null; // allow a retry on the next startRrweb call
      return null;
    },
  );
  return rrwebLoadPromise;
}

// rrweb EventType constants
const META_EVENT_TYPE = 4;
const CUSTOM_EVENT_TYPE = 5;
// rrweb FullSnapshot type
const FULL_SNAPSHOT_EVENT_TYPE = 2;
// rrweb IncrementalSnapshot type
const INCREMENTAL_SNAPSHOT_EVENT_TYPE = 3;
// rrweb IncrementalSource.Mutation
const MUTATION_SOURCE = 0;
// rrweb IncrementalSource.StyleSheetRule
const STYLESHEET_RULE_SOURCE = 8;
// rrweb IncrementalSource.StyleDeclaration
const STYLE_DECLARATION_SOURCE = 13;
// rrweb IncrementalSource.AdoptedStyleSheet
const ADOPTED_STYLESHEET_SOURCE = 15;
// rrweb serialized NodeType.Element
const SERIALIZED_ELEMENT_TYPE = 2;
// rrweb serialized NodeType.Text
const SERIALIZED_TEXT_TYPE = 3;

/**
 * Tag used on the SessionSight-internal custom rrweb event we emit when
 * a stripped naturally-sized image or video finishes loading and we want
 * the replayer to update the corresponding placeholder's `width`/`height`
 * attributes. The replayer's event-cast handler keys off this tag.
 */
export const SS_MEDIA_DIM_EVENT = 'ss_media_dim';

// ── PII Detection & Redaction ─────────────────────────────────────
// Runs on every code path (including data-ss-unmask) so sensitive data
// never reaches the server. Patterns live in @sessionsight/sdk-shared
// and are shared with the backend's server-side scrubbing step.

/**
 * Width-class character mapping for proportional fonts.
 * Characters are grouped by approximate rendered width in common sans-serif fonts.
 * Scrambling swaps within the same width class to minimize layout drift.
 */
const WIDTH_CLASSES_LOWER: Record<string, string[]> = {
  narrow: ['i', 'j', 'l'],
  semiNarrow: ['f', 'r', 't'],
  medium: ['a', 'b', 'c', 'd', 'e', 'g', 'h', 'k', 'n', 'o', 'p', 'q', 's', 'u', 'v', 'x', 'y', 'z'],
  wide: ['m', 'w'],
};

const WIDTH_CLASSES_UPPER: Record<string, string[]> = {
  narrow: ['I', 'J'],
  semiNarrow: ['E', 'F', 'L', 'T'],
  medium: ['A', 'B', 'C', 'D', 'G', 'H', 'K', 'N', 'O', 'P', 'Q', 'R', 'S', 'U', 'V', 'X', 'Y', 'Z'],
  wide: ['M', 'W'],
};

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// ── Per-session scramble cipher ──────────────────────────────────────
//
// scrambleText must not be reversible by anyone with this source code. A
// fixed substitution (the previous implementation shifted each char by +1
// in its width class) is recoverable by inspection. We instead build a
// random derangement (permutation with no fixed points) per width class
// and per digit set, kept only in module-local state and rotated each
// time a new Recorder is constructed (i.e., per session).
//
// The permutation is never transmitted, so reversing the scramble across
// sessions requires brute-forcing the per-session derangements.

interface ScrambleCipher {
  charMap: Map<string, string>;
  digitMap: Map<string, string>;
}

function secureRandomInt(maxExclusive: number): number {
  // crypto.getRandomValues is available in every browser the SDK targets,
  // and in Node 19+ via globalThis. Fall back to Math.random only if a
  // runtime somehow lacks it, since the previous implementation needed no
  // randomness at all.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    // Reject the modulo-biased tail for uniform distribution.
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(buf);
      if (buf[0]! < limit) return buf[0]! % maxExclusive;
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

function randomDerangement<T>(input: T[]): T[] {
  if (input.length <= 1) return [...input];
  // Rejection sampling: shuffle, retry if any element stayed in place. For
  // class sizes up to 18 the success rate is ~1/e (~37%), so the loop
  // converges in a small number of attempts.
  while (true) {
    const arr = [...input];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    let hasFixedPoint = false;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === input[i]) { hasFixedPoint = true; break; }
    }
    if (!hasFixedPoint) return arr;
  }
}

function createScrambleCipher(): ScrambleCipher {
  const charMap = new Map<string, string>();
  const digitMap = new Map<string, string>();

  const buildClassMap = (group: string[]) => {
    const permuted = randomDerangement(group);
    for (let i = 0; i < group.length; i++) {
      charMap.set(group[i]!, permuted[i]!);
    }
  };

  for (const group of Object.values(WIDTH_CLASSES_LOWER)) buildClassMap(group);
  for (const group of Object.values(WIDTH_CLASSES_UPPER)) buildClassMap(group);

  const permutedDigits = randomDerangement(DIGITS);
  for (let i = 0; i < DIGITS.length; i++) {
    digitMap.set(DIGITS[i]!, permutedDigits[i]!);
  }

  return { charMap, digitMap };
}

let scrambleCipher: ScrambleCipher = createScrambleCipher();

/**
 * Rotate the scramble cipher and clear the mask cache (whose entries were
 * computed against the previous cipher). Called by the Recorder constructor
 * so every new session uses a fresh per-session permutation.
 *
 * Exported for tests. Not re-exported from the package index (internal API).
 */
export function rotateScrambleCipher(): void {
  scrambleCipher = createScrambleCipher();
  maskCacheClear();
}

/**
 * Scramble text by replacing each character with another character of similar
 * rendered width, using the current per-session cipher. Preserves whitespace,
 * punctuation, character count, and any [REDACTED] tokens already inserted by
 * redactString.
 */
function scrambleText(text: string): string {
  // Preserve [REDACTED] tokens inserted by redactString so they stay readable.
  if (text.includes(REDACTED)) {
    return text.split(REDACTED).map(part => scrambleText(part)).join(REDACTED);
  }

  const { charMap, digitMap } = scrambleCipher;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const mapped = charMap.get(ch) ?? digitMap.get(ch);
    // Whitespace, punctuation, symbols, non-Latin: pass through unchanged.
    result += mapped ?? ch;
  }
  return result;
}

/**
 * Resolve the masking directive for an element by walking up to the nearest
 * data-ss-mask / data-ss-unmask ancestor. Returns 'mask', 'unmask', or null
 * (use privacy mode default).
 */
function resolveMaskDirective(element: HTMLElement | null): 'mask' | 'unmask' | null {
  if (!element) return null;
  const nearest = element.closest('[data-ss-mask], [data-ss-unmask]');
  if (!nearest) return null;
  return nearest.hasAttribute('data-ss-mask') ? 'mask' : 'unmask';
}

/**
 * Hard floor: password fields are NEVER captured, regardless of privacyMode,
 * data-ss-unmask ancestors, or any other customer configuration. Detects both
 * live `<input type="password">` and rrweb's `data-rr-is-password` marker
 * (set when an input's type was changed away from password during the
 * session — rrweb still treats those values as passwords).
 *
 * Exported for tests. Not re-exported from the package index (internal API).
 */
export function isPasswordElement(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element.tagName === 'INPUT' && (element as HTMLInputElement).type === 'password') return true;
  if (element.hasAttribute && element.hasAttribute('data-rr-is-password')) return true;
  return false;
}

// ── Masking Cache ────────────────────────────────────────────────
// Most text nodes on a page are static between snapshots. Caching the
// masking result avoids re-running 7 PII regexes + char-by-char scrambling
// on every 30s checkout and mutation batch.

const MASK_CACHE_MAX = 4_000;
const maskCache = new Map<string, string>();

function maskCacheGet(key: string): string | undefined {
  return maskCache.get(key);
}

function maskCachePut(key: string, value: string): void {
  if (maskCache.size >= MASK_CACHE_MAX) {
    // Evict oldest quarter of entries (Map iterates in insertion order)
    const evictCount = MASK_CACHE_MAX / 4;
    let i = 0;
    for (const k of maskCache.keys()) {
      if (i++ >= evictCount) break;
      maskCache.delete(k);
    }
  }
  maskCache.set(key, value);
}

function maskCacheClear(): void {
  maskCache.clear();
}

/**
 * Apply the privacy masking decision for a given DOM element.
 * Checks data-ss-mask / data-ss-unmask on the element and its ancestors,
 * then falls back to the privacy mode default. Results are cached by
 * (text, directive, privacyMode) to avoid redundant regex + scramble work.
 */
/**
 * Exported for tests. Not re-exported from the package index (internal API).
 */
export function applyMasking(text: string, element: HTMLElement | null, privacyMode: string): string {
  // Password fields are always replaced with [REDACTED]. No directive, privacy
  // mode, or ancestor unmask attribute can override this. Even with the
  // per-session scramble cipher, scrambling a password would still leak its
  // length and character-class shape — for passwords specifically we drop
  // both signals.
  if (isPasswordElement(element)) {
    return REDACTED;
  }

  const directive = resolveMaskDirective(element);
  const cacheKey = `${directive ?? 'd'}:${privacyMode}:${text}`;
  const cached = maskCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  // Always redact PII first, before any other masking. This ensures sensitive
  // patterns are caught even when text is about to be scrambled.
  let result = redactString(text);

  if (directive === 'mask') {
    result = scrambleText(result);
  } else if (directive === 'unmask') {
    // result already has PII redacted, no scramble needed
  } else if (privacyMode === 'default') {
    result = scrambleText(result);
  }

  maskCachePut(cacheKey, result);
  return result;
}

// ── Serialized Event Placeholder Masking ──────────────────────────

type SerializedNode = {
  type: number;
  tagName?: string;
  attributes?: Record<string, any>;
  childNodes?: SerializedNode[];
  id?: number;
};

const PLACEHOLDER_INPUT_TAGS = new Set(['input', 'textarea']);

// Attributes that hold URLs which may contain customer-embedded tokens or
// PII in their query string. We strip query/fragment from these wholesale —
// `src` is excluded because replay needs it to render images/media correctly.
const URL_ATTRS = ['href', 'action'] as const;

function stripUrlAttrs(attrs: Record<string, any>): void {
  for (const name of URL_ATTRS) {
    const v = attrs[name];
    if (typeof v === 'string' && v.length > 0) {
      attrs[name] = stripUrlQuery(v);
    }
  }
}

/**
 * Recursively walk a serialized rrweb node tree and scramble placeholder
 * attributes on input/textarea elements, plus strip query strings from any
 * URL-bearing attributes (href, action). Respects data-ss-mask /
 * data-ss-unmask attributes on the element itself and inherited from
 * ancestor nodes.
 *
 * @param maskState - inherited masking: 'mask', 'unmask', or null (use mode default)
 */
function scramblePlaceholders(
  node: SerializedNode,
  privacyMode: string,
  maskState: 'mask' | 'unmask' | null,
): void {
  if (node.type === SERIALIZED_ELEMENT_TYPE) {
    // Update inherited mask state if this element has a data-ss attribute
    const attrs = node.attributes;
    if (attrs) {
      if ('data-ss-unmask' in attrs) maskState = 'unmask';
      else if ('data-ss-mask' in attrs) maskState = 'mask';

      // Strip query strings from href/action regardless of mask directive.
      // Customer pages routinely embed tokens, reset codes, and PII in
      // query params; the unmask directive does not opt-in to leaking them.
      stripUrlAttrs(attrs);
    }

    // Scramble placeholder if this is an input/textarea
    if (attrs && PLACEHOLDER_INPUT_TAGS.has(node.tagName!) && typeof attrs.placeholder === 'string' && attrs.placeholder) {
      // Always redact PII in placeholders
      attrs.placeholder = redactString(attrs.placeholder);
      const shouldScramble =
        maskState === 'mask' ||
        (maskState !== 'unmask' && privacyMode === 'default');
      if (shouldScramble) {
        attrs.placeholder = scrambleText(attrs.placeholder);
      }
    }
  }

  // Recurse into children for all node types (Document, Element, etc.)
  if (node.childNodes) {
    for (const child of node.childNodes) {
      scramblePlaceholders(child, privacyMode, maskState);
    }
  }
}

/**
 * Process an rrweb event to scramble placeholder attributes on serialized
 * input/textarea nodes, strip query strings from URL-bearing attributes and
 * Meta event hrefs. Handles Meta, FullSnapshot, and IncrementalSnapshot
 * (Mutation adds and attribute changes).
 */
/**
 * Exported for tests. Not re-exported from the package index (internal API).
 */
export function maskEventPlaceholders(event: eventWithTime, privacyMode: string): void {
  // Meta events carry the page URL emitted by rrweb itself. Strip query/fragment.
  if (event.type === META_EVENT_TYPE) {
    const data = event.data as { href?: string };
    if (typeof data.href === 'string' && data.href.length > 0) {
      data.href = stripUrlQuery(data.href);
    }
    return;
  }

  // FullSnapshot: walk the entire serialized DOM tree
  if (event.type === FULL_SNAPSHOT_EVENT_TYPE) {
    const data = event.data as { node?: SerializedNode };
    if (data.node) scramblePlaceholders(data.node, privacyMode, null);
    return;
  }

  // IncrementalSnapshot with Mutation source: walk added nodes and attribute changes
  if (event.type === INCREMENTAL_SNAPSHOT_EVENT_TYPE) {
    const data = event.data as { source?: number; adds?: { node: SerializedNode }[]; attributes?: { id: number; attributes: Record<string, any> }[] };
    if (data.source !== MUTATION_SOURCE) return;

    // Added nodes can contain input/textarea with placeholders
    if (data.adds) {
      for (const add of data.adds) {
        scramblePlaceholders(add.node, privacyMode, null);
      }
    }

    // Attribute mutations can set placeholder, href, or action directly
    if (data.attributes) {
      for (const attr of data.attributes) {
        if (typeof attr.attributes.placeholder === 'string' && attr.attributes.placeholder) {
          attr.attributes.placeholder = redactString(attr.attributes.placeholder);
          const shouldScramble = privacyMode === 'default';
          if (shouldScramble) {
            attr.attributes.placeholder = scrambleText(attr.attributes.placeholder);
          }
        }
        stripUrlAttrs(attr.attributes);
      }
    }
  }
}

// ── Media stripping (image, video, audio) ────────────────────────
//
// Strips image/video/audio references — both URL refs and embedded bytes
// (data:/blob: URIs) — from rrweb event payloads before they leave the
// browser. Layout fidelity is preserved by capturing live element
// dimensions onto the serialized node before clearing the source. The
// replayer renders a stand-in via CSS keyed off `data-ss-blocked`.
//
// See dev-docs/plans/done/IMAGE_STRIPPING_PLAN.md for the full design.

const MEDIA_TAG_IMG = 'img';
const MEDIA_TAG_VIDEO = 'video';
const MEDIA_TAG_AUDIO = 'audio';
const MEDIA_TAG_SOURCE = 'source';
const MEDIA_TAG_PICTURE = 'picture';
const MEDIA_TAG_SVG_IMAGE = 'image';
const MEDIA_TAG_STYLE = 'style';
const MEDIA_TAG_LINK = 'link';

type RrwebMirror = {
  getNode(id: number): Node | null;
};

/**
 * Resolve `data-ss-allow` for a serialized node. Walks the live DOM via
 * the rrweb mirror so an ancestor opt-in is honored even when the
 * serialized node is a leaf. Returns true if the element OR any ancestor
 * carries the marker (the value is ignored — presence is the signal).
 */
function isElementOptedIn(id: number | undefined, mirror: RrwebMirror | null): boolean {
  if (id == null || !mirror) return false;
  const node = mirror.getNode(id);
  if (!node || node.nodeType !== 1) return false;
  const el = node as Element;
  return el.closest(`[${SS_ALLOW_ATTR}]`) !== null;
}

/**
 * Capture intrinsic dimensions onto a serialized <img> or <video> node so
 * the replayer can reserve the right space after the src is cleared.
 * Skipped for <audio> per the plan (no intrinsic visual size).
 *
 * Two distinct things are captured here:
 *
 *  1. `width` / `height` HTML attributes (when the customer hasn't set
 *     them already). These map to a CSS aspect-ratio fallback in modern
 *     browsers so `<img max-width:100% height:auto>` reserves space.
 *
 *  2. An inline `style="aspect-ratio: W/H"` declaration. This is
 *     load-bearing whenever the customer's stylesheet sets `height: auto`
 *     on `<img>`/`<video>` (which Tailwind's preflight does, and most
 *     production sites have something equivalent). Without an inline
 *     aspect-ratio override, the replay element falls through to the
 *     SS_MEDIA_SHIM's intrinsic ratio (1:1 from the SVG viewBox), so
 *     a 240×136 video collapses to a 240×240 square. The inline aspect
 *     wins over the shim's intrinsic.
 */
function captureMediaDimensions(
  node: SerializedNode,
  liveEl: HTMLElement | null,
): void {
  if (!liveEl || !node.attributes) return;
  const attrs = node.attributes;
  const tag = node.tagName;

  let intrinsicW = 0;
  let intrinsicH = 0;
  if (tag === MEDIA_TAG_IMG) {
    const img = liveEl as HTMLImageElement;
    intrinsicW = img.naturalWidth || 0;
    intrinsicH = img.naturalHeight || 0;
  } else if (tag === MEDIA_TAG_VIDEO) {
    const v = liveEl as HTMLVideoElement;
    intrinsicW = v.videoWidth || 0;
    intrinsicH = v.videoHeight || 0;
  }

  // Rendered (post-CSS) dimensions are what matter for aspect-ratio
  // pinning: that's what the customer actually sees at this moment.
  // Intrinsic dims drive the size when height:auto is in play, so use
  // intrinsic for aspect when available; fall back to the rendered box
  // when intrinsic is unknown (media not loaded yet).
  let aspectW = intrinsicW;
  let aspectH = intrinsicH;
  if (aspectW === 0 || aspectH === 0) {
    try {
      const rect = liveEl.getBoundingClientRect();
      aspectW = aspectW || Math.round(rect.width);
      aspectH = aspectH || Math.round(rect.height);
    } catch {
      // ignore — better to ship without dims than to throw
    }
  }

  // Don't overwrite explicit width/height already set by the customer.
  const hasWidth = 'width' in attrs && attrs.width !== '' && attrs.width != null;
  const hasHeight = 'height' in attrs && attrs.height !== '' && attrs.height != null;
  if (intrinsicW > 0 && !hasWidth) attrs.width = String(intrinsicW);
  if (intrinsicH > 0 && !hasHeight) attrs.height = String(intrinsicH);

  // Pin aspect-ratio inline so the shim's 1:1 intrinsic doesn't rewrite
  // the visible aspect. Skip when we can't determine an aspect, and
  // when the customer's inline style already declares one.
  if (aspectW > 0 && aspectH > 0) {
    const existingStyle = typeof attrs.style === 'string' ? attrs.style : '';
    if (!/(^|;)\s*aspect-ratio\s*:/i.test(existingStyle)) {
      const sep = existingStyle.length > 0 && !existingStyle.trim().endsWith(';') ? '; ' : '';
      attrs.style = `${existingStyle}${sep}aspect-ratio: ${aspectW} / ${aspectH}`;
    }
  }
}

/**
 * Resolve a possibly-relative URL against the current document's base.
 * Used on opted-in media URLs so the replayer (running in a different
 * origin's iframe) can still fetch the asset. Pass-through for inputs
 * that aren't valid URLs and for already-absolute ones.
 */
function absolutifyUrl(value: string): string {
  if (typeof value !== 'string' || value === '') return value;
  // Already-absolute URLs (including data:/blob: callers that bypass
  // this path) round-trip unchanged through the URL constructor; the
  // try/catch only catches truly malformed inputs.
  try {
    const base = (typeof document !== 'undefined' && document.baseURI) || 'http://localhost/';
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * Apply opt-in handling to a single URL-bearing media attribute. URL form
 * survives if opted in; embedded forms (data:/blob:) strip unconditionally.
 *
 * Returns one of:
 *   { kind: 'keep', value }         — write `value` back to the attribute
 *                                      (URL absolutified so the replay
 *                                      iframe can fetch from the customer's
 *                                      origin even though the iframe runs
 *                                      under SessionSight's origin)
 *   { kind: 'shim' }                — replace with SS_MEDIA_SHIM (so the
 *                                      browser doesn't render a broken-image
 *                                      icon under the replayer's stand-in)
 */
type MediaStripAction = { kind: 'keep'; value: string } | { kind: 'shim' };
function applyMediaOptIn(value: string, optIn: boolean): MediaStripAction {
  if (typeof value !== 'string' || value === '') return { kind: 'keep', value };
  if (value === SS_MEDIA_SHIM) return { kind: 'keep', value };
  if (isEmbeddedMediaUrl(value)) return { kind: 'shim' };
  if (optIn) return { kind: 'keep', value: absolutifyUrl(value) };
  return { kind: 'shim' };
}

/**
 * Apply opt-in handling to a srcset attribute value. URL-form entries
 * survive when opted in; data:/blob: entries are dropped unconditionally
 * regardless of opt-in. Surviving URL entries are absolutified so the
 * replay iframe can fetch them. Returns the resulting srcset (possibly
 * empty).
 */
function applyMediaOptInSrcset(value: string, optIn: boolean): string {
  if (typeof value !== 'string' || value === '') return '';
  if (!optIn) return '';
  // Parse the srcset properly so URLs containing commas (e.g. data:
  // URIs in mixed srcsets) don't get shredded. Then drop embedded-byte
  // entries and absolutify the rest so the replay iframe can fetch
  // them from the customer's origin.
  const entries = parseSrcset(value);
  const kept = entries.filter((e) => !isEmbeddedMediaUrl(e.url));
  if (kept.length === 0) return '';
  return kept
    .map((e) => {
      const url = absolutifyUrl(e.url);
      return e.descriptor ? `${url} ${e.descriptor}` : url;
    })
    .join(', ');
}

/**
 * Strip media references from a serialized <img> / <picture-source> /
 * <video> / <audio> / <source> / SVG <image> node. Mutates the node in
 * place.
 *
 * Marker policy (`data-ss-blocked`): set whenever the resulting element
 * will render the SS_MEDIA_SHIM placeholder. This includes cases where
 * an opted-in element had a `data:`/`blob:` source (which strips
 * unconditionally) — opt-in does not suppress the marker, only the strip.
 * The replayer's stand-in CSS keys off this marker.
 *
 * `data-ss-allow` inheritance: when the marker is inherited from an
 * ancestor wrapper, copy it down onto the serialized element so the
 * server-side scrubber (which can't walk ancestors) honors the same
 * decision.
 */
function scrubMediaElement(
  node: SerializedNode,
  mirror: RrwebMirror | null,
): void {
  const attrs = node.attributes;
  if (!attrs) return;
  const tag = node.tagName;
  if (!tag) return;

  const liveNode = node.id != null && mirror ? mirror.getNode(node.id) : null;
  const liveEl = liveNode && liveNode.nodeType === 1 ? (liveNode as Element) : null;

  // Capture dimensions BEFORE stripping src so img/video lay out correctly.
  if (tag === MEDIA_TAG_IMG || tag === MEDIA_TAG_VIDEO) {
    captureMediaDimensions(node, liveEl as HTMLElement | null);
  }

  // Resolve opt-in. Walk live ancestors via closest() so an opt-in on a
  // wrapper (e.g. <header data-ss-allow>) covers descendants.
  const optIn = liveEl ? liveEl.closest(`[${SS_ALLOW_ATTR}]`) !== null : false;

  // Tracks whether we need to render the stand-in (some primary
  // render attribute was replaced with the shim or cleared).
  let needsStandIn = false;

  const applyToUrlAttr = (name: string): void => {
    const v = attrs[name];
    if (typeof v !== 'string') return;
    const action = applyMediaOptIn(v, optIn);
    if (action.kind === 'shim') {
      attrs[name] = SS_MEDIA_SHIM;
      needsStandIn = true;
    } else if (action.value !== v) {
      attrs[name] = action.value;
    }
  };

  const applyToSrcsetAttr = (name: string): void => {
    const v = attrs[name];
    if (typeof v !== 'string' || v.length === 0) return;
    const next = applyMediaOptInSrcset(v, optIn);
    if (next !== v) {
      // srcset is a candidate list — don't shim individual entries; clear
      // the whole attribute. The element's `src` (or fallback) is what
      // determines whether we need a stand-in.
      attrs[name] = next;
    }
  };

  if (tag === MEDIA_TAG_IMG) {
    applyToUrlAttr('src');
    applyToSrcsetAttr('srcset');
  } else if (tag === MEDIA_TAG_VIDEO) {
    applyToUrlAttr('src');
    applyToUrlAttr('poster');
  } else if (tag === MEDIA_TAG_AUDIO) {
    applyToUrlAttr('src');
  } else if (tag === MEDIA_TAG_SOURCE) {
    // <source> inside <picture> uses srcset; inside <video>/<audio> uses src.
    applyToSrcsetAttr('srcset');
    applyToUrlAttr('src');
  } else if (tag === MEDIA_TAG_SVG_IMAGE) {
    // SVG raster-embed element. NOT <use>.
    applyToUrlAttr('href');
    applyToUrlAttr('xlink:href');
  }

  if (needsStandIn) {
    attrs[SS_BLOCKED_ATTR] = '';
  }
  // Copy the opt-in marker down so server-side (which doesn't walk
  // ancestors) can honor it. Only when the live element doesn't itself
  // already carry the attribute and an ancestor does.
  if (optIn && liveEl && !(SS_ALLOW_ATTR in attrs)) {
    attrs[SS_ALLOW_ATTR] = '';
  }
}


/**
 * Strip url() refs from inline-style and captured stylesheet text on a
 * single serialized element. Returns true if something was stripped.
 */
function scrubElementStyleAttributes(
  node: SerializedNode,
  mirror: RrwebMirror | null,
): boolean {
  const attrs = node.attributes;
  if (!attrs) return false;
  const tag = node.tagName;

  // Live-element opt-in resolution for inline-style strips. Captured
  // stylesheet text is global by nature, so the opt-in does not apply
  // there even if the <style>/<link> element happens to have an
  // opted-in ancestor.
  const liveNode = node.id != null && mirror ? mirror.getNode(node.id) : null;
  const liveEl = liveNode && liveNode.nodeType === 1 ? (liveNode as Element) : null;
  const inlineOptIn = liveEl ? liveEl.closest(`[${SS_ALLOW_ATTR}]`) !== null : false;

  let stripped = false;

  if (typeof attrs.style === 'string' && attrs.style.length > 0) {
    if (!inlineOptIn) {
      const out = { stripped: false };
      const next = stripInlineStyleUrls(attrs.style, out);
      if (out.stripped) {
        attrs.style = next;
        attrs[SS_BLOCKED_ATTR] = '';
        stripped = true;
      }
    }
    // When opted in, leave the inline style intact. Don't add a marker.
  }

  if (typeof attrs._cssText === 'string' && attrs._cssText.length > 0) {
    const out = { stripped: false };
    const next = stripStylesheetUrls(attrs._cssText, out);
    if (out.stripped) {
      attrs._cssText = next;
      // No per-element marker for stylesheet-text strips (intentional gap).
      stripped = true;
    }
  }

  // Belt-and-suspenders: <style> elements may also carry the original CSS
  // as a text-node child (the runtime mutated form lives in _cssText, but
  // the original source lives in childNodes). rrweb's replayer prefers
  // _cssText when present, but stripping the text-node child too removes a
  // class of "rrweb fell back to the original child" failure modes.
  if (tag === MEDIA_TAG_STYLE && Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      if (child && child.type === SERIALIZED_TEXT_TYPE && typeof (child as any).textContent === 'string') {
        const out = { stripped: false };
        const next = stripStylesheetUrls((child as any).textContent, out);
        if (out.stripped) {
          (child as any).textContent = next;
          stripped = true;
        }
      }
    }
  }

  // Copy opt-in marker down for inline-style strips only (stylesheet text
  // is global and opt-in-exempt).
  if (inlineOptIn && liveEl && !(SS_ALLOW_ATTR in attrs)) {
    attrs[SS_ALLOW_ATTR] = '';
  }

  return stripped;
}

/**
 * Walk a serialized node tree (FullSnapshot.node or mutations.adds[].node)
 * and apply media-strip rules to every element node. Recurses through
 * Document, Element, Fragment children.
 */
function scrubMedia(node: SerializedNode | null | undefined, mirror: RrwebMirror | null): void {
  if (!node || typeof node !== 'object') return;

  if (node.type === SERIALIZED_ELEMENT_TYPE) {
    scrubMediaElement(node, mirror);
    scrubElementStyleAttributes(node, mirror);
  }

  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      scrubMedia(child, mirror);
    }
  }
}

/**
 * Apply media-strip rules to the `mutations.attributes` delta array — the
 * rrweb shape for incremental attribute mutations on existing elements.
 * No node tree available; we look up the live element via the mirror to
 * read tagName + opt-in state.
 */
function scrubMediaAttributeDeltas(
  deltas: { id: number; attributes: Record<string, any> }[] | undefined,
  mirror: RrwebMirror | null,
): void {
  if (!Array.isArray(deltas)) return;

  for (const entry of deltas) {
    if (!entry || typeof entry !== 'object' || !entry.attributes) continue;
    const attrs = entry.attributes;

    const liveNode = mirror ? mirror.getNode(entry.id) : null;
    const liveEl = liveNode && liveNode.nodeType === 1 ? (liveNode as Element) : null;
    if (!liveEl) continue;
    const tag = liveEl.tagName.toLowerCase();
    const optIn = liveEl.closest(`[${SS_ALLOW_ATTR}]`) !== null;

    let needsStandIn = false;
    let inlineStripped = false;

    const stripUrlAttr = (name: string) => {
      const v = attrs[name];
      if (typeof v !== 'string') return;
      const action = applyMediaOptIn(v, optIn);
      if (action.kind === 'shim') {
        attrs[name] = SS_MEDIA_SHIM;
        needsStandIn = true;
      } else if (action.value !== v) {
        attrs[name] = action.value;
      }
    };

    const stripSrcsetAttr = (name: string) => {
      const v = attrs[name];
      if (typeof v !== 'string') return;
      const next = applyMediaOptInSrcset(v, optIn);
      if (next !== v) {
        attrs[name] = next;
      }
    };

    if (tag === MEDIA_TAG_IMG) {
      if ('src' in attrs) stripUrlAttr('src');
      if ('srcset' in attrs) stripSrcsetAttr('srcset');
    } else if (tag === MEDIA_TAG_VIDEO) {
      if ('src' in attrs) stripUrlAttr('src');
      if ('poster' in attrs) stripUrlAttr('poster');
    } else if (tag === MEDIA_TAG_AUDIO) {
      if ('src' in attrs) stripUrlAttr('src');
    } else if (tag === MEDIA_TAG_SOURCE) {
      if ('src' in attrs) stripUrlAttr('src');
      if ('srcset' in attrs) stripSrcsetAttr('srcset');
    } else if (tag === MEDIA_TAG_SVG_IMAGE) {
      if ('href' in attrs) stripUrlAttr('href');
      if ('xlink:href' in attrs) stripUrlAttr('xlink:href');
    }

    if (typeof attrs.style === 'string' && attrs.style.length > 0 && !optIn) {
      const out = { stripped: false };
      const next = stripInlineStyleUrls(attrs.style, out);
      if (out.stripped) {
        attrs.style = next;
        inlineStripped = true;
      }
    }

    if (typeof attrs._cssText === 'string' && attrs._cssText.length > 0) {
      const out = { stripped: false };
      const next = stripStylesheetUrls(attrs._cssText, out);
      if (out.stripped) {
        attrs._cssText = next;
        // No per-element marker for stylesheet-text strips (intentional).
      }
    }

    if (needsStandIn || inlineStripped) {
      attrs[SS_BLOCKED_ATTR] = '';
    }
  }
}

/**
 * Strip url() refs from an `IncrementalSource.StyleSheetRule` event payload.
 * Mutates `data.adds[].rule`, `data.replace`, and `data.replaceSync` in place.
 * Stylesheets are document-global, so opt-in does not apply.
 */
function scrubStyleSheetRule(data: any): void {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data.adds)) {
    for (const add of data.adds) {
      if (add && typeof add.rule === 'string') {
        const out = { stripped: false };
        const next = stripStylesheetUrls(add.rule, out);
        if (out.stripped) add.rule = next;
      }
    }
  }
  if (typeof data.replace === 'string') {
    const out = { stripped: false };
    const next = stripStylesheetUrls(data.replace, out);
    if (out.stripped) data.replace = next;
  }
  if (typeof data.replaceSync === 'string') {
    const out = { stripped: false };
    const next = stripStylesheetUrls(data.replaceSync, out);
    if (out.stripped) data.replaceSync = next;
  }
}

/**
 * Strip url() refs from an `IncrementalSource.StyleDeclaration` event
 * payload. Only acts on URL-bearing CSS properties; honors `data-ss-allow`
 * on the target live element (URL form only — data:/blob: still strip).
 */
function scrubStyleDeclaration(data: any, mirror: RrwebMirror | null): void {
  if (!data || typeof data !== 'object') return;
  const set = data.set;
  if (!set || typeof set !== 'object' || typeof set.property !== 'string' || typeof set.value !== 'string') {
    return;
  }
  const prop = set.property.toLowerCase();
  // URL_BEARING_CSS_PROPERTIES is the source of truth.
  if (
    prop !== 'background' &&
    prop !== 'background-image' &&
    prop !== 'mask-image' &&
    prop !== 'border-image' &&
    prop !== 'list-style-image' &&
    prop !== 'cursor'
  ) return;

  const optIn = isElementOptedIn(data.id, mirror);
  // Even with opt-in, embedded forms strip unconditionally.
  const value: string = set.value;
  if (optIn && !/data:|blob:/i.test(value)) {
    return;
  }

  const out = { stripped: false };
  const next = stripInlineStyleUrls(`${prop}: ${value}`, out);
  if (!out.stripped) return;
  // Re-extract just the value from "prop: stripped".
  const colon = next.indexOf(':');
  if (colon < 0) return;
  set.value = next.slice(colon + 1).trim();
}

/**
 * Strip url() refs from an `IncrementalSource.AdoptedStyleSheet` event
 * payload. Mutates `data.styles[].rules[].rule` strings in place.
 * Adopted stylesheets are document-global; opt-in does not apply.
 */
function scrubAdoptedStyleSheet(data: any): void {
  if (!data || typeof data !== 'object' || !Array.isArray(data.styles)) return;
  for (const style of data.styles) {
    if (!style || !Array.isArray(style.rules)) continue;
    for (const r of style.rules) {
      if (r && typeof r.rule === 'string') {
        const out = { stripped: false };
        const next = stripStylesheetUrls(r.rule, out);
        if (out.stripped) r.rule = next;
      }
    }
  }
}

/**
 * Apply media stripping to a single rrweb event in place. Dispatches by
 * event type / source. Exposed for tests.
 */
export function scrubMediaInEvent(event: eventWithTime, mirror: RrwebMirror | null): void {
  if (event.type === FULL_SNAPSHOT_EVENT_TYPE) {
    const data = event.data as { node?: SerializedNode };
    if (data?.node) scrubMedia(data.node, mirror);
    return;
  }
  if (event.type !== INCREMENTAL_SNAPSHOT_EVENT_TYPE) return;

  const data = event.data as any;
  const source = data?.source;

  if (source === MUTATION_SOURCE) {
    if (Array.isArray(data.adds)) {
      for (const add of data.adds) {
        if (add?.node) scrubMedia(add.node, mirror);
      }
    }
    scrubMediaAttributeDeltas(data.attributes, mirror);
  } else if (source === STYLESHEET_RULE_SOURCE) {
    scrubStyleSheetRule(data);
  } else if (source === STYLE_DECLARATION_SOURCE) {
    scrubStyleDeclaration(data, mirror);
  } else if (source === ADOPTED_STYLESHEET_SOURCE) {
    scrubAdoptedStyleSheet(data);
  }
}

// ── Page Exclusion Pattern Matching ────────────────────────────────

function globToRegex(pattern: string): RegExp | null {
  try {
    // Escape regex special chars except *, then convert * to .*
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = '^' + escaped.replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr);
  } catch (e) {
    console.warn('SessionSight: invalid excludePages pattern', pattern, e);
    return null;
  }
}

function matchesAnyPattern(path: string, patterns: RegExp[]): boolean {
  for (const regex of patterns) {
    if (regex.test(path)) return true;
  }
  return false;
}

export class Recorder {
  private bridge: WorkerBridge;
  private visitorId: string;
  private preBuffer: eventWithTime[] = [];
  private isRecording = false;
  private stopRrweb: (() => void) | null = null;
  // Tracks the rendered size of every stripped media element so we can
  // emit a SessionSight-internal aspect-ratio update event whenever the
  // box reflows in the original session. See installPendingMediaDimListeners.
  private mediaResizeObserver: ResizeObserver | null = null;
  private stableId: string | null = null;
  private userProperties: Record<string, string | number | boolean> = {};
  private userPropertiesDirty = false;
  private lastHref: string = '';
  private lastEmittedFlagToken: string | null = null;
  private flagCheckTimer: ReturnType<typeof setInterval> | null = null;
  private origPushState: typeof history.pushState | null = null;
  private origReplaceState: typeof history.replaceState | null = null;

  // Form tracking state
  private formStarted = new Set<string>();
  private formStartTimestamps = new Map<string, number>();
  private focusTimestamps = new Map<string, number>();

  // Heatmap tracking state
  private lastMouseMoveEmit = 0;
  // Cooldown for the media-playback synth-click fallback (see
  // installMediaPlaybackInteractionListeners). Set whenever a real click
  // on a <video>/<audio> reaches the document handler. The play/pause
  // listener checks this to avoid double-recording when the user's click
  // *did* propagate through the controls' shadow DOM.
  private lastRealMediaClickAt = 0;
  private readonly MEDIA_SYNTH_CLICK_COOLDOWN_MS = 500;

  // Frustration signal: rage click detection
  // Circular buffer of recent clicks for clustering (max 5 entries)
  private recentClicks: Array<{ x: number; y: number; t: number }> = [];
  private static readonly RAGE_CLICK_COUNT = 3;
  private static readonly RAGE_CLICK_WINDOW_MS = 1000;
  private static readonly RAGE_CLICK_RADIUS_PX = 30;

  // Frustration signal: form abandonment detection
  // Tracks whether a form is active on the current page
  private formActiveOnPage = false;

  // Frustration signal: excessive scrolling
  private scrollHistory: Array<{ y: number; t: number; dir: 'up' | 'down' }> = [];
  private lastScrollDirection: 'up' | 'down' | null = null;
  private lastScrollY = 0;

  // Frustration signal: form field retries
  private fieldFocusCounts = new Map<string, number[]>();

  // Frustration signal: idle detection
  private lastInteractionTime = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleEmitted = false;
  private static readonly IDLE_THRESHOLD_MS = 30_000;

  // Session termination after sustained idle (5 minutes with no interaction)
  private idleSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_SESSION_TIMEOUT_MS = 300_000; // 5 minutes
  public endedByIdle = false;

  // Error deduplication state
  private lastErrorMessage = '';
  private lastErrorTime = 0;

  // Scroll depth tracking via IntersectionObserver sentinels
  private static readonly SCROLL_DEPTH_THRESHOLDS = [25, 50, 75, 100];
  private scrollDepthHits = new Set<number>();
  private scrollSentinels: HTMLElement[] = [];
  private scrollDepthObserver: IntersectionObserver | null = null;

  // Tab visibility session lifecycle
  private hiddenAt: number | null = null;
  private static readonly VISIBILITY_GRACE_MS = 120_000; // 2 minutes
  public endedByVisibility = false;
  private isHidden = false;

  private propertyId: string;
  private privacyMode: 'default' | 'relaxed';
  private excludePagePatterns: RegExp[];
  private isPaused = false;

  constructor(bridge: WorkerBridge, propertyId: string, visitorId: string, options?: { privacyMode?: 'default' | 'relaxed'; excludePages?: string[] }) {
    this.bridge = bridge;
    this.propertyId = propertyId;
    this.visitorId = visitorId;
    this.privacyMode = options?.privacyMode ?? 'default';
    this.excludePagePatterns = (options?.excludePages ?? []).map(globToRegex).filter((r): r is RegExp => r !== null);

    // Fresh scramble permutation for this session, so any text scrambled in
    // a prior session can't be reversed against this one.
    rotateScrambleCipher();

    // Stop recording if the transport is killed (invalid API key, etc.)
    this.bridge.onKilled(() => {
      this.preBuffer = [];
      this.isRecording = false;
      if (this.stopRrweb) { this.stopRrweb(); this.stopRrweb = null; }
    });
  }

  start(autoRecord: boolean): void {
    try {
      this.lastHref = window.location.href;

      const initialPageExcluded = this.excludePagePatterns.length > 0 &&
        matchesAnyPattern(window.location.pathname, this.excludePagePatterns);

      // Set recording state BEFORE starting rrweb so the initial FullSnapshot
      // goes to the bridge (not the preBuffer) when autoRecord is on.
      if (autoRecord) {
        this.isRecording = true;
        this.bridge.postMetadata(this.collectMetadata());
      }

      // Always start rrweb — events go to either buffer or preBuffer.
      // rrweb's record() emits its own Meta event (type 4) with href,
      // so the initial page automatically appears in the pages list.
      // Do NOT emit a second Meta event here — it would land after the
      // FullSnapshot in the buffer, causing discardPriorSnapshots() to
      // skip the FullSnapshot on backward seeks and break replay.
      // startRrweb is async (rrweb is lazy-loaded) but we don't await it:
      // recording starts as soon as rrweb resolves, and the host page is
      // never blocked by SDK init.
      void this.startRrweb();

      // If the initial page is excluded, emit the placeholder event after rrweb
      // has started (so the session has a valid FullSnapshot), then pause.
      if (initialPageExcluded) {
        this.emitCustomEvent('ss-page-excluded', { href: stripUrlQuery(window.location.href) });
        this.bridge.flush();
        this.isPaused = true;
      }

      // Track SPA navigations
      this.patchHistoryMethods();
      window.addEventListener('popstate', this.handleNavigation);

      // Track user interactions
      document.addEventListener('submit', this.handleFormSubmit, true);
      document.addEventListener('focusin', this.handleFieldFocus, true);
      document.addEventListener('focusout', this.handleFieldBlur, true);

      // Heatmap tracking
      document.addEventListener('click', this.handleHeatmapClick, true);
      document.addEventListener('mousemove', this.handleHeatmapMouseMove, { capture: true, passive: true });
      window.addEventListener('scroll', this.handleHeatmapScroll, { capture: true, passive: true });

      // Media playback fallback: clicks on native <video>/<audio> controls
      // (the play button, scrubber, volume slider) live inside a closed
      // user-agent shadow DOM. Many browsers absorb those clicks so they
      // never propagate to document — both our heatmap listener and
      // rrweb's MouseInteraction listener miss them entirely. Listen
      // directly for `play`/`pause` events on each media element and
      // synthesize a click on the host element when the corresponding
      // user action almost certainly triggered them. The synthetic click
      // bubbles to document and is captured by both rrweb (giving the
      // replay its ripple) and our heatmap (giving the timeline/sidebar
      // its event). Real clicks that DID propagate are deduped via a
      // short cooldown.
      this.installMediaPlaybackInteractionListeners();

      // Scroll depth tracking via IntersectionObserver (replaces per-frame scroll checks)
      this.setupScrollDepthObserver();

      // Error tracking
      window.addEventListener('error', this.handleWindowError);
      window.addEventListener('unhandledrejection', this.handleUnhandledRejection);

      // Idle detection
      document.addEventListener('keydown', this.handleKeydown, true);
      this.lastInteractionTime = Date.now();
      this.resetIdleTimer();

      document.addEventListener('visibilitychange', this.handleVisibilityChange);
      window.addEventListener('beforeunload', this.handleBeforeUnload);

      // Periodically check for flag evaluation tokens (cross-SDK registry lives on main thread)
      this.flagCheckTimer = setInterval(() => this.checkFlagToken(), FLAG_CHECK_INTERVAL_MS);
    } catch (e) {
      // SDK must never break the host page
      console.warn('SessionSight: failed to start recorder', e);
    }
  }

  /** Start persisting events to the server. Call after init({ autoRecord: false }). */
  beginRecording(options?: RecordOptions): void {
    if (this.isRecording) return;

    this.isRecording = true;

    // Send metadata to the worker/bridge
    this.bridge.postMetadata(this.collectMetadata());

    // Drain pre-buffer: send kept events to the bridge
    const preRecordSecs = Math.min(5, Math.max(0, options?.preRecordSecs || 0));
    if (preRecordSecs > 0 && this.preBuffer.length > 0) {
      const cutoff = Date.now() - preRecordSecs * 1000;
      for (const e of this.preBuffer) {
        if (e.timestamp >= cutoff) this.bridge.postEvent(e);
      }
    }
    this.preBuffer = [];

    // Trigger immediate flush so the first batch goes out
    this.bridge.flush();
  }

  /**
   * Pause rrweb capture without touching identity, bridge, or listeners.
   * Events emitted while paused are dropped. Orthogonal to consent:
   * goals / feedback / split-test exposures continue to fire. Also used
   * internally by the privacy-excludePages flow.
   */
  pause(): void {
    this.isPaused = true;
  }

  /** Resume capture paused by pause(). No-op if not paused. */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Tear down the recorder. Stops rrweb, unhooks listeners, and flushes any
   * pending events.
   *
   * `keepBridge` (default false): when true, the underlying WorkerBridge is
   * left intact so the server can still deliver messages (most importantly,
   * `rotate_session`) over the existing WebSocket. Used by the internal
   * idle/visibility ending paths, where the user has gone away but the SDK
   * still needs to hear from the backend when its session gets sealed. The
   * SDK-level resurrection handler either reattaches a recorder on the same
   * bridge (short idle) or swaps to a new bridge from `rotateSession()` (the
   * server decided the old session is done).
   */
  stop(options: { keepBridge?: boolean } = {}): void {
    if (this.flagCheckTimer) {
      clearInterval(this.flagCheckTimer);
      this.flagCheckTimer = null;
    }
    this.hiddenAt = null;
    this.isHidden = false;
    if (this.stopRrweb) {
      this.stopRrweb();
      this.stopRrweb = null;
    }
    if (this.mediaResizeObserver) {
      try { this.mediaResizeObserver.disconnect(); } catch {}
      this.mediaResizeObserver = null;
    }

    this.unpatchHistoryMethods();
    window.removeEventListener('popstate', this.handleNavigation);

    document.removeEventListener('submit', this.handleFormSubmit, true);
    document.removeEventListener('focusin', this.handleFieldFocus, true);
    document.removeEventListener('focusout', this.handleFieldBlur, true);

    document.removeEventListener('click', this.handleHeatmapClick, true);
    document.removeEventListener('mousemove', this.handleHeatmapMouseMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('scroll', this.handleHeatmapScroll, { capture: true } as EventListenerOptions);
    this.teardownScrollDepthObserver();

    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleUnhandledRejection);

    document.removeEventListener('keydown', this.handleKeydown, true);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.idleSessionTimer) { clearTimeout(this.idleSessionTimer); this.idleSessionTimer = null; }

    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);

    if (this.isRecording) {
      this.bridge.flush();
    }
    this.isRecording = false;
    if (!options.keepBridge) {
      this.bridge.destroy();
    }
    maskCacheClear();
  }

  getVisitorId(): string {
    return this.visitorId;
  }

  getBridge(): WorkerBridge {
    return this.bridge;
  }

  getPropertyId(): string {
    return this.propertyId;
  }

  identify(stableId: string, properties?: Record<string, string | number | boolean>): void {
    this.stableId = stableId;
    this.bridge.postIdentify(stableId, properties);
    if (properties) {
      Object.assign(this.userProperties, properties);
      this.userPropertiesDirty = true;
      this.emitCustomEvent('set_user_properties', { ...properties });
    }
  }

  /**
   * Apply server-delivered privacy configuration. If settings differ from the
   * current defaults, update the recorder and trigger a fresh FullSnapshot so
   * replay uses the correct masking from this point forward.
   */
  applyPrivacyConfig(config: PrivacyConfig): void {
    const modeChanged = config.privacyMode !== this.privacyMode;

    // Update internal state from the server config
    this.privacyMode = config.privacyMode;
    this.excludePagePatterns = (config.excludePages ?? []).map(globToRegex).filter((r): r is RegExp => r !== null);

    // Re-evaluate page exclusion with the new patterns
    const shouldExclude = this.excludePagePatterns.length > 0 &&
      matchesAnyPattern(window.location.pathname, this.excludePagePatterns);

    if (shouldExclude && !this.isPaused) {
      this.bridge.flush();
      this.emitCustomEvent('ss-page-excluded', { href: stripUrlQuery(window.location.href) });
      this.bridge.flush();
      this.isPaused = true;
    } else if (!shouldExclude && this.isPaused) {
      this.isPaused = false;
    }

    // If the privacy mode changed, restart rrweb for a new FullSnapshot with correct masking
    if (modeChanged && !this.isPaused) {
      if (this.stopRrweb) this.stopRrweb();
      void this.startRrweb();
    }
  }

  // ── rrweb lifecycle ────────────────────────────────────────────────

  /**
   * Stamp fixed dimensions onto data-ss-exclude elements so that when rrweb
   * replaces them with empty placeholders (via blockSelector), the placeholders
   * preserve the original layout space.
   */
  private stampExcludedDimensions(): void {
    const excluded = document.querySelectorAll('[data-ss-exclude]');
    for (const el of excluded) {
      const htmlEl = el as HTMLElement;
      // Skip if already stamped
      if (htmlEl.style.getPropertyValue('--ss-stamped')) continue;
      const rect = htmlEl.getBoundingClientRect();
      htmlEl.style.setProperty('width', rect.width + 'px', 'important');
      htmlEl.style.setProperty('height', rect.height + 'px', 'important');
      htmlEl.style.setProperty('min-height', rect.height + 'px', 'important');
      htmlEl.style.setProperty('box-sizing', 'border-box', 'important');
      htmlEl.style.setProperty('--ss-stamped', '1');
    }
  }

  /**
   * Observe the rendered size of every `<img>`, `<video>`, and SVG
   * `<image>` element with a `ResizeObserver`. When the rendered size
   * changes — image load completes, video metadata arrives, the user
   * resizes the window, a CSS class swap re-aspects the box — emit a
   * SessionSight-internal custom rrweb event carrying the new
   * dimensions. The replayer applies them as inline `aspect-ratio` and
   * `width`/`height` attributes at the captured timestamp, reproducing
   * the visible layout shift even though the actual media has been
   * stripped.
   *
   * Why ResizeObserver instead of `load` / `loadedmetadata`:
   *   - It captures ALL size changes, not just media-load ones.
   *     CSS-driven resizes (class swaps, container queries) and
   *     intrinsic-driven resizes (poster→video aspect transition) both
   *     surface as a single signal.
   *   - It doesn't depend on the SDK racing to attach a listener before
   *     the underlying load completes; the observer's first delivery
   *     reports the current size.
   *
   * Per-element memo of the last-emitted dims so trivial sub-pixel
   * jitter and proportional window-resize batches don't flood the
   * stream with redundant events.
   *
   * Custom event shape:
   *   { tag: SS_MEDIA_DIM_EVENT, payload: { id, width, height } }
   * where `id` is rrweb's serialized node id (stable across recorder
   * and replayer mirrors).
   *
   * Must be called AFTER `record()` so `recordFn.mirror.getId(el)` can
   * resolve the serialized id.
   */
  private installPendingMediaDimListeners(recordFn: typeof rrwebRecord): void {
    try {
      if (typeof ResizeObserver === 'undefined') return;
      const mirror: any = (recordFn as any).mirror;
      if (!mirror) return;

      const lastEmittedDims = new WeakMap<Element, { w: number; h: number }>();

      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target as Element;
          const w = Math.round(entry.contentRect.width);
          const h = Math.round(entry.contentRect.height);
          if (w <= 0 || h <= 0) continue;
          const prev = lastEmittedDims.get(el);
          // Skip near-duplicates: <2px change in either dim is below
          // the threshold where a replay user could perceive a layout
          // shift, and prevents window-resize bursts from flooding.
          if (prev && Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2) continue;
          let id: number;
          try {
            id = mirror.getId(el);
          } catch {
            continue;
          }
          if (typeof id !== 'number' || id <= 0) continue;
          lastEmittedDims.set(el, { w, h });
          this.emitCustomEvent(SS_MEDIA_DIM_EVENT, { id, width: w, height: h });
        }
      });
      this.mediaResizeObserver = ro;

      // `<img>`, `<video>`, and SVG `<image>` are the foreground media
      // tags whose visible size we strip the source from. `<audio>`
      // renders its own native controls (no media-frame area) and
      // doesn't need aspect tracking — the controls' rendered size is
      // entirely customer-CSS-driven.
      const observe = (selector: string) => {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          try { ro.observe(el); } catch {
            // Some browsers throw on observing detached elements.
          }
        }
      };
      observe('img');
      observe('video');
      observe('image');
    } catch (e) {
      console.warn('SessionSight: error installing media-dimension observer', e);
    }
  }

  private async startRrweb(): Promise<void> {
    try {
      const record = await loadRrweb();
      if (!record) return;

      const privacyMode = this.privacyMode;

      // Stamp dimensions on excluded elements before rrweb starts.
      // rrweb's blockSelector replaces these with empty <div> placeholders,
      // but the inline width/height styles are preserved on the placeholder,
      // so the layout space is maintained.
      this.stampExcludedDimensions();

      const recordFunc = record;
      this.stopRrweb = record({
        emit: (event: eventWithTime) => {
          try {
            // Scramble placeholder attributes in serialized nodes before buffering
            maskEventPlaceholders(event, privacyMode);
            // Strip image/video/audio refs (default-on; see IMAGE_STRIPPING_PLAN).
            // record.mirror is the runtime serialization map; lookups by
            // serialized node id return the live DOM element, which we read
            // for dimensions and `data-ss-allow` ancestry.
            const mirror = (recordFunc as any)?.mirror ?? null;
            scrubMediaInEvent(event, mirror);
            this.pushEvent(event);
          } catch (e) {
            console.warn('SessionSight: error in rrweb emit callback', e);
          }
        },
        // Take a full DOM snapshot every 30s so the replayer can seek without
        // replaying every mutation from the start of the session.
        checkoutEveryNms: 30_000,
        // Default is 100ms (10fps); 33ms (~30Hz) plus the playback-side
        // interpolator in ReplayPlayer.svelte gives smooth replay at a
        // fraction of the storage cost of 60Hz capture.
        sampling: { scroll: 33 },
        inlineStylesheet: true,

        // Replace excluded elements with empty placeholders (preserves inline styles)
        blockSelector: '[data-ss-exclude]',

        // Mask all input values, with custom logic respecting data-ss attributes
        maskAllInputs: true,
        maskInputFn: (text: string, element: HTMLElement): string => {
          try {
            return applyMasking(text, element, privacyMode);
          } catch (e) {
            console.warn('SessionSight: error in maskInputFn', e);
            return text;
          }
        },

        // Fire maskTextFn for every text node.
        maskTextSelector: '*',
        maskTextFn: (text: string, element: HTMLElement | null): string => {
          try {
            return applyMasking(text, element, privacyMode);
          } catch (e) {
            console.warn('SessionSight: error in maskTextFn', e);
            return text;
          }
        },
      }) ?? null;

      // Install pending-load listeners AFTER record() so the rrweb mirror
      // is populated. The listeners emit ss_media_dim custom events when
      // stripped naturally-sized media finishes loading, which the
      // replayer applies as a width/height update at that timestamp.
      // No live-DOM mutation, no bootstrap delay.
      this.installPendingMediaDimListeners(record);
    } catch (e) {
      console.warn('SessionSight: failed to start rrweb', e);
    }
  }

  /** Route an event to the bridge or pre-buffer */
  private pushEvent(event: eventWithTime): void {
    // When paused due to page exclusion, drop all events
    if (this.isPaused) return;

    // Drop events while tab is hidden so background mutations don't inflate
    // lastEventAt on the server. The session will either resume or end when
    // the tab becomes visible again.
    if (this.isHidden) return;

    if (this.isRecording) {
      this.bridge.postEvent(event);
      // Flush FullSnapshot immediately so replay data survives early bounces
      if (event.type === FULL_SNAPSHOT_EVENT_TYPE) {
        this.bridge.flush();
      }
    } else {
      // Pre-buffer: keep last 5 seconds
      this.preBuffer.push(event);
      this.trimPreBuffer();
    }
  }

  /** Trim pre-buffer to keep only the last 5 seconds of events */
  private trimPreBuffer(): void {
    if (this.preBuffer.length === 0) return;
    const cutoff = Date.now() - PRE_BUFFER_MAX_MS;
    // Find first event that's within the window
    let firstValid = 0;
    while (firstValid < this.preBuffer.length && this.preBuffer[firstValid]!.timestamp < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.preBuffer.splice(0, firstValid);
    }
  }

  // ── Custom event helpers ───────────────────────────────────────────

  private emitCustomEvent(tag: string, payload: Record<string, any>): void {
    const event: eventWithTime = {
      type: CUSTOM_EVENT_TYPE,
      data: { tag, payload },
      timestamp: Date.now(),
    };
    this.pushEvent(event);
  }

  /**
   * Apply privacy masking to text extracted from a DOM element.
   * Respects data-ss-mask/unmask directives and the current privacy mode.
   * Must be called on ALL text read from the DOM before emitting custom events.
   */
  private maskText(text: string, element: HTMLElement | null): string {
    return applyMasking(text, element, this.privacyMode);
  }

  // ── Form identification ────────────────────────────────────────────

  private static readonly INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select';

  /** Find the nearest grouping container: <form>, [data-ss-form], or null (page-level). */
  private getFormContainer(target: HTMLElement): HTMLElement | null {
    return target.closest('form') || target.closest('[data-ss-form]');
  }

  private getFormInfo(container: HTMLElement | null): { formId: string; formName: string } {
    const page = stripUrlQuery(window.location.pathname);

    if (!container) {
      return { formId: `${page}:_page`, formName: page };
    }

    const containerId = container.id.slice(0, 100);
    if (container.tagName === 'FORM') {
      const allForms = Array.from(document.querySelectorAll('form'));
      const index = allForms.indexOf(container as HTMLFormElement);
      const indexStr = index >= 0 ? String(index) : '0';
      const formId = `${page}:${containerId || indexStr}`;
      const dataName = container.getAttribute('data-ss-form')?.slice(0, 100);
      const formName = dataName || containerId || `Form ${index + 1}`;
      return { formId, formName };
    }

    // [data-ss-form] container
    const dataName = container.getAttribute('data-ss-form')!.slice(0, 100);
    const formId = `${page}:${containerId || dataName}`;
    return { formId, formName: dataName };
  }

  private getFieldInfo(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, container: HTMLElement | null) {
    const scope = container || document;
    const inputs = Array.from(scope.querySelectorAll(Recorder.INPUT_SELECTOR));
    const index = inputs.indexOf(el);
    const elId = el.id.slice(0, 100);
    const elName = el.name.slice(0, 100);
    const fieldId = elId || elName || `field-${index}`;
    const fieldName = elName || elId || `field-${index}`;
    const fieldType = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el as HTMLInputElement).type || 'text';

    let fieldLabel = '';
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) fieldLabel = this.maskText((label.textContent?.trim() || '').slice(0, 50), label as HTMLElement);
    }
    if (!fieldLabel) {
      const parent = el.closest('label');
      if (parent) {
        const clone = parent.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, textarea, select').forEach(c => c.remove());
        fieldLabel = this.maskText((clone.textContent?.trim() || '').slice(0, 50), parent as HTMLElement);
      }
    }
    if (!fieldLabel) {
      const rawPlaceholder = el.getAttribute('placeholder')?.slice(0, 50) || fieldName;
      fieldLabel = this.maskText(rawPlaceholder, el as HTMLElement);
    }

    return { fieldId, fieldName, fieldType, fieldLabel };
  }

  // ── Field focus/blur tracking ──────────────────────────────────────

  private handleFieldFocus = (e: FocusEvent): void => {
    try {
      const target = e.target as HTMLElement;
      if (!target) return;
      if (!target.matches(Recorder.INPUT_SELECTOR)) return;

      const container = this.getFormContainer(target);
      const { formId, formName } = this.getFormInfo(container);
      const field = this.getFieldInfo(target as HTMLInputElement, container);
      const page = stripUrlQuery(window.location.pathname);

      if (!this.formStarted.has(formId)) {
        this.formStarted.add(formId);
        this.formStartTimestamps.set(formId, Date.now());
        const scope = container || document;
        const inputs = scope.querySelectorAll(Recorder.INPUT_SELECTOR);
        this.emitCustomEvent('form_start', { formId, formName, page, fieldCount: inputs.length });
          this.formActiveOnPage = true;
      }

      const focusKey = `${formId}:${field.fieldId}`;
      this.focusTimestamps.set(focusKey, Date.now());
      this.emitCustomEvent('field_focus', { formId, formName, page, ...field });

      // Frustration signal: detect repeated field focus (form field retries)
      const now = Date.now();
      const focusTimes = this.fieldFocusCounts.get(focusKey) || [];
      focusTimes.push(now);
      // Keep only entries within 30 seconds
      const retryCutoff = now - 30_000;
      const recent = focusTimes.filter(t => t >= retryCutoff);
      this.fieldFocusCounts.set(focusKey, recent);
      if (recent.length >= 3) {
        this.emitCustomEvent('form_field_retry', { formName, fieldName: field.fieldName, page, retries: recent.length });
        this.fieldFocusCounts.set(focusKey, []);
      }

      // Reset idle timer on interaction
      this.resetIdleTimer();
    } catch (e2) {
      console.warn('SessionSight: error in field focus handler', e2);
    }
  };

  private handleFieldBlur = (e: FocusEvent): void => {
    try {
      const target = e.target as HTMLElement;
      if (!target) return;
      if (!target.matches(Recorder.INPUT_SELECTOR)) return;

      const container = this.getFormContainer(target);
      const { formId, formName } = this.getFormInfo(container);
      const field = this.getFieldInfo(target as HTMLInputElement, container);
      const page = stripUrlQuery(window.location.pathname);

      const focusKey = `${formId}:${field.fieldId}`;
      const focusTime = this.focusTimestamps.get(focusKey);
      const timeSpent = focusTime ? Date.now() - focusTime : 0;
      this.focusTimestamps.delete(focusKey);

      const el = target as HTMLInputElement;
      let hasValue = false;
      if (el.type === 'checkbox' || el.type === 'radio') hasValue = el.checked;
      else hasValue = (el.value || '').trim().length > 0;

      this.emitCustomEvent('field_blur', { formId, formName, page, ...field, timeSpent, hasValue });
    } catch (e2) {
      console.warn('SessionSight: error in field blur handler', e2);
    }
  };

  // ── Click tracking ─────────────────────────────────────────────────
  // All click tracking is handled by handleHeatmapClick which emits
  // 'mouse_click' events for every click with isInteractive detection.

  private getElementLabel(el: HTMLElement): string | null {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return this.maskText(ariaLabel.slice(0, 80), el);
    const tag = el.tagName;
    // Form controls: skip .textContent (textarea initial content / select option
    // concatenation) and never fall through to .value (user's typed input).
    // Use the associated <label> or aria-labelledby instead.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const labelEl = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).labels?.[0] ?? null;
      if (labelEl) {
        const labelText = (labelEl.textContent || '').trim();
        if (labelText) return this.maskText(labelText.slice(0, 80), labelEl as HTMLElement);
      }
      const title = el.getAttribute('title');
      if (title) return this.maskText(title.slice(0, 80), el);
      return null;
    }
    const text = el.textContent?.trim();
    if (text && text.length <= 80) return this.maskText(text, el);
    if (text) return this.maskText(text.slice(0, 77) + '...', el);
    const title = el.getAttribute('title');
    if (title) return this.maskText(title.slice(0, 80), el);
    return null;
  }

  // ── Form submit tracking ───────────────────────────────────────────

  private handleFormSubmit = (e: Event): void => {
    try {
      const form = e.target as HTMLFormElement;
      if (!form || form.tagName !== 'FORM') return;
      const { formId, formName } = this.getFormInfo(form);
      const page = stripUrlQuery(window.location.pathname);
      const inputs = form.querySelectorAll(Recorder.INPUT_SELECTOR);
      const filledFields = Array.from(inputs).filter((input) => {
        const el = input as HTMLInputElement;
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
        return el.value.trim().length > 0;
      }).length;
      const startTime = this.formStartTimestamps.get(formId);
      const timeToComplete = startTime ? Date.now() - startTime : 0;
      this.emitCustomEvent('form_submit', { formId, formName, page, totalFields: inputs.length, filledFields, timeToComplete });
      this.formActiveOnPage = false;
    } catch (e2) {
      console.warn('SessionSight: error in form submit handler', e2);
    }
  };

  // ── Heatmap tracking ───────────────────────────────────────────────

  private static readonly INTERACTIVE_SELECTOR = [
    'a', 'button', 'select', 'textarea',
    'input', 'label', 'summary', 'details',
    // Media elements with controls render an interactive UI (play, scrub,
    // volume) inside a closed shadow DOM. Clicks on those internal buttons
    // retarget up to the host element. Without including the host here,
    // every play/pause click would fall through to the dead-click defer and
    // be misclassified — internal mutations in the media-controls shadow
    // DOM don't propagate to our document-level MutationObserver, so the
    // 400ms deferred check would always conclude "no mutation, no
    // interaction".
    'video', 'audio',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="radio"]', '[role="checkbox"]', '[role="option"]',
    '[role="menuitem"]', '[role="switch"]', '[role="slider"]',
    '[tabindex]', '[onclick]', '[data-action]',
    '[data-ss-interactive]',
  ].join(', ');

  // Cursor values that signal an element is interactive even when its tag/role
  // doesn't match (e.g. WebGL canvases, custom drag handles, draggable widgets).
  private static readonly INTERACTIVE_CURSORS = new Set([
    'pointer', 'grab', 'grabbing', 'move',
    'zoom-in', 'zoom-out', 'crosshair', 'all-scroll',
    'col-resize', 'row-resize',
    'ew-resize', 'ns-resize', 'ne-resize', 'nw-resize',
    'se-resize', 'sw-resize',
    'n-resize', 'e-resize', 's-resize', 'w-resize',
    'nesw-resize', 'nwse-resize',
  ]);

  private static readonly DEAD_CLICK_DEFER_MS = 400;

  private handleHeatmapClick = (e: MouseEvent): void => {
    try {
      const target = e.target as HTMLElement | null;
      let cursor = '';
      if (target) {
        try { cursor = window.getComputedStyle(target).cursor; } catch {}
      }
      // Selection gesture (reading, double/triple-click word/paragraph select):
      // ignore entirely — not an interaction attempt, would otherwise pollute
      // dead-click counts and rage-click clusters.
      if (cursor === 'text') return;
      // Cooldown stamp for the media-playback synth-click fallback. When a
      // real click on <video>/<audio> *did* propagate through the controls
      // shadow DOM, mark the timestamp so the upcoming play/pause event
      // doesn't synthesize a duplicate. The check is on the original target
      // (pre-closest) so we only suppress when the click landed directly on
      // the media host.
      const targetTag = target?.tagName?.toLowerCase();
      if (targetTag === 'video' || targetTag === 'audio') {
        this.lastRealMediaClickAt = Date.now();
      }
      // Walk up to find the nearest interactive ancestor
      const interactive = target?.closest(Recorder.INTERACTIVE_SELECTOR) as HTMLElement | null;
      let isInteractive = !!interactive;
      // Fallback: if no semantic match, treat an interactive cursor style as a strong
      // signal (covers canvases and custom widgets where the dev set cursor: pointer/grab/etc.)
      if (!isInteractive && cursor && Recorder.INTERACTIVE_CURSORS.has(cursor)) {
        isInteractive = true;
      }
      const el = interactive || target;
      const tagName = el?.tagName?.toLowerCase() || '';
      // Form controls (input, textarea, select): NEVER read .value, .textContent,
      // or rendered option text. .value is the user's typed input. <textarea>'s
      // .textContent reflects initial HTML which can include dynamic content the
      // customer's app rendered into it. <select>'s .textContent concatenates all
      // <option> text, which can include user-facing data (names, emails) the
      // customer's app populated. Safe substitutes: aria-label, associated <label>
      // text via the .labels collection, or a generic tag/type marker.
      const isFormControl = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
      let rawText: string;
      if (isFormControl) {
        const ariaLabel = el?.getAttribute?.('aria-label')?.trim() || '';
        const labelEl = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)?.labels?.[0] ?? null;
        const labelText = labelEl ? (labelEl.textContent || '').trim().slice(0, 100) : '';
        const inputType = tagName === 'input' ? `:${(el as HTMLInputElement)?.type || 'text'}` : '';
        rawText = ariaLabel || labelText || `<${tagName}${inputType}>`;
      } else {
        rawText = (el?.textContent || '').trim().slice(0, 100);
      }
      const text = this.maskText(rawText, el as HTMLElement | null);
      const href = stripUrlQuery((el as HTMLAnchorElement)?.href || '');

      const clickData = {
        x: Math.round((e.clientX / window.innerWidth) * 10000) / 100,
        y: Math.round(((e.clientY + window.scrollY) / document.documentElement.scrollHeight) * 10000) / 100,
        documentHeight: document.documentElement.scrollHeight,
        viewportX: e.clientX,
        viewportY: e.clientY,
        page: stripUrlQuery(window.location.pathname),
        elementTag: tagName,
        elementText: text,
        elementHref: href,
        isInteractive: true,
      };

      // If the element is clearly interactive, emit immediately
      if (isInteractive) {
        this.emitCustomEvent('mouse_click', clickData);
      } else {
        // Defer: watch for DOM mutations or URL changes that indicate the click did something
        this.deferDeadClickCheck(clickData, target);
      }

      // Reset idle timer on click
      this.resetIdleTimer();

      // Rage click detection: check if 3+ clicks landed within 1s and 30px radius
      this.checkRageClick(e.clientX, e.clientY);
    } catch (e2) {
      console.warn('SessionSight: error in heatmap click handler', e2);
    }
  };

  private deferDeadClickCheck(clickData: Record<string, any>, _clickedEl: HTMLElement | null): void {
    const startUrl = window.location.href;
    let sawMutation = false;

    const observeTarget = document.body || document.documentElement;
    if (!observeTarget) {
      clickData.isInteractive = false;
      this.emitCustomEvent('mouse_click', clickData);
      return;
    }

    // Snapshot elements that already have CSS animations/transitions running
    // before the click so we can ignore their mutations as false positives.
    const animatingEls = new Set<Element>();
    try {
      for (const el of document.getAnimations().map(a => (a as any).effect?.target).filter(Boolean)) {
        animatingEls.add(el);
      }
    } catch {
      // getAnimations() not supported; fall through without filtering
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // Skip mutations on or inside elements that were already animating
        const target = m.target as Element;
        if (animatingEls.has(target)) continue;
        let ancestor: Element | null = target;
        let isAnimating = false;
        while (ancestor) {
          if (animatingEls.has(ancestor)) { isAnimating = true; break; }
          ancestor = ancestor.parentElement;
        }
        if (isAnimating) continue;

        sawMutation = true;
        break;
      }
    });
    try {
      observer.observe(observeTarget, { childList: true, subtree: true });
    } catch (e) {
      console.warn('SessionSight: error observing mutations', e);
      clickData.isInteractive = false;
      this.emitCustomEvent('mouse_click', clickData);
      return;
    }

    setTimeout(() => {
      observer.disconnect();
      const urlChanged = window.location.href !== startUrl;
      // If the click left an active text selection, treat it as a selection gesture
      // rather than a dead click.
      let hasSelection = false;
      try {
        const sel = window.getSelection();
        hasSelection = !!sel && !sel.isCollapsed && (sel.toString() || '').length > 0;
      } catch {}
      if (hasSelection) return;
      clickData.isInteractive = sawMutation || urlChanged;
      this.emitCustomEvent('mouse_click', clickData);
    }, Recorder.DEAD_CLICK_DEFER_MS);
  }

  /**
   * Install fallback listeners on every `<video>` and `<audio>` to
   * recover click events that get absorbed by the user-agent shadow DOM
   * around native controls. Many browsers don't propagate clicks on the
   * play/pause/scrubber buttons up to the document — so neither rrweb's
   * MouseInteraction recorder nor our heatmap handler ever sees them.
   *
   * The play/pause events do fire reliably regardless of whether the
   * underlying click propagated. When one fires and a real click on the
   * media element wasn't already captured in the last few hundred ms,
   * synthesize a `MouseEvent('click')` on the media element so it
   * bubbles to document and lands in both pipelines (rrweb → ripple,
   * our heatmap → mouse_click custom event).
   *
   * The synthesized event's `clientX`/`clientY` approximate the play
   * button's location (lower-left of the controls bar). Synthetic
   * MouseEvents don't trigger default actions, so re-dispatching can't
   * loop back into another play/pause cycle.
   */
  private installMediaPlaybackInteractionListeners(): void {
    try {
      const onPlaybackToggle = (media: HTMLMediaElement) => () => {
        // Cooldown: if a real click on this media just propagated, don't
        // double-record. lastRealMediaClickAt is updated by the heatmap
        // click handler whenever target is video/audio.
        if (Date.now() - this.lastRealMediaClickAt < this.MEDIA_SYNTH_CLICK_COOLDOWN_MS) return;
        try {
          const rect = media.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          // Approximate play-button location: lower-left of the
          // controls bar (which is rendered at the bottom of the
          // media element across all major browsers).
          const x = Math.round(rect.left + Math.min(30, rect.width / 2));
          const y = Math.round(rect.bottom - Math.min(20, rect.height / 4));
          const evt = new MouseEvent('click', {
            clientX: x,
            clientY: y,
            bubbles: true,
            composed: true,
            cancelable: true,
          });
          media.dispatchEvent(evt);
        } catch {
          // ignore — best-effort recovery
        }
      };

      const mediaEls = document.querySelectorAll('video, audio');
      for (const el of mediaEls) {
        const media = el as HTMLMediaElement;
        const handler = onPlaybackToggle(media);
        media.addEventListener('play', handler, { passive: true });
        media.addEventListener('pause', handler, { passive: true });
      }
    } catch (e) {
      console.warn('SessionSight: error installing media playback listeners', e);
    }
  }

  /**
   * Check for rage clicks: 3+ clicks within 1s and 30px radius.
   * Maintains a circular buffer of recent clicks (max 5).
   */
  private checkRageClick(x: number, y: number): void {
    const now = Date.now();
    this.recentClicks.push({ x, y, t: now });
    if (this.recentClicks.length > 5) this.recentClicks.shift();

    // Count clicks within the time window and radius of the latest click
    const windowStart = now - Recorder.RAGE_CLICK_WINDOW_MS;
    let nearby = 0;
    for (const click of this.recentClicks) {
      if (click.t < windowStart) continue;
      const dx = click.x - x;
      const dy = click.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= Recorder.RAGE_CLICK_RADIUS_PX) {
        nearby++;
      }
    }

    if (nearby >= Recorder.RAGE_CLICK_COUNT) {
      this.emitCustomEvent('rage_click', {
        x,
        y,
        page: stripUrlQuery(window.location.pathname),
        clickCount: nearby,
      });
      // Clear buffer to avoid re-firing on the next click
      this.recentClicks.length = 0;
    }
  }

  /**
   * Check for form abandonment on navigation or unload.
   * If a form was started but not submitted before the user leaves, emit form_abandonment.
   */
  private checkFormAbandonment(): void {
    if (this.formActiveOnPage) {
      this.emitCustomEvent('form_abandonment', {
        page: stripUrlQuery(window.location.pathname),
      });
      this.formActiveOnPage = false;
    }
  }

  private handleHeatmapMouseMove = (e: MouseEvent): void => {
    try {
      const now = Date.now();
      // Reset idle timer on mouse move (cheap check, no timeout reset every move)
      if (now - this.lastInteractionTime > 5000) this.resetIdleTimer();
      if (now - this.lastMouseMoveEmit < 500) return;
      this.lastMouseMoveEmit = now;
      this.emitCustomEvent('mouse_move', {
        x: Math.round((e.clientX / window.innerWidth) * 10000) / 100,
        y: Math.round(((e.clientY + window.scrollY) / document.documentElement.scrollHeight) * 10000) / 100,
        documentHeight: document.documentElement.scrollHeight,
        page: stripUrlQuery(window.location.pathname),
      });
    } catch (e2) {
      console.warn('SessionSight: error in mousemove handler', e2);
    }
  };

  private handleHeatmapScroll = (): void => {
    try {
      const now = Date.now();
      const scrollY = window.scrollY;

      // Detect excessive scrolling: rapid direction changes
      if (this.lastScrollY !== 0) {
        const dir: 'up' | 'down' = scrollY > this.lastScrollY ? 'down' : 'up';
        if (dir !== this.lastScrollDirection && this.lastScrollDirection !== null) {
          this.scrollHistory.push({ y: scrollY, t: now, dir });
          // Keep only entries within 3 seconds
          const cutoff = now - 3000;
          while (this.scrollHistory.length > 0 && this.scrollHistory[0]!.t < cutoff) {
            this.scrollHistory.shift();
          }
          // 4+ direction reversals in 3s = excessive scrolling
          if (this.scrollHistory.length >= 4) {
            this.emitCustomEvent('excessive_scroll', { page: stripUrlQuery(window.location.pathname), count: this.scrollHistory.length });
            this.scrollHistory = [];
          }
        }
        this.lastScrollDirection = dir;
      }
      this.lastScrollY = scrollY;

      // Reset idle timer on scroll
      this.resetIdleTimer();
    } catch (e) {
      console.warn('SessionSight: error in scroll handler', e);
    }
  };

  // ── Scroll depth via IntersectionObserver ──────────────────────────

  private setupScrollDepthObserver(): void {
    this.teardownScrollDepthObserver();

    if (typeof IntersectionObserver === 'undefined') return;

    this.scrollDepthObserver = new IntersectionObserver((entries) => {
      try {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const threshold = Number((entry.target as HTMLElement).dataset.ssDepth);
          if (isNaN(threshold) || this.scrollDepthHits.has(threshold)) continue;

          this.scrollDepthHits.add(threshold);
          const scrollY = window.scrollY;
          const maxScrollY = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
          this.emitCustomEvent('scroll_depth', {
            scrollY,
            maxScrollY,
            scrollPercent: threshold,
            viewportHeight: window.innerHeight,
            page: stripUrlQuery(window.location.pathname),
          });

          // Unobserve this sentinel since it already fired
          this.scrollDepthObserver?.unobserve(entry.target);
        }
      } catch (e) {
        console.warn('SessionSight: error in scroll depth observer', e);
      }
    }, { threshold: 0 });

    this.placeSentinels();
  }

  private placeSentinels(): void {
    // Remove existing sentinels before placing new ones
    for (const el of this.scrollSentinels) el.remove();
    this.scrollSentinels = [];

    const docHeight = document.documentElement.scrollHeight;
    for (const pct of Recorder.SCROLL_DEPTH_THRESHOLDS) {
      if (this.scrollDepthHits.has(pct)) continue;
      const sentinel = document.createElement('div');
      sentinel.dataset.ssDepth = String(pct);
      sentinel.setAttribute('aria-hidden', 'true');
      sentinel.style.cssText = 'position:absolute;left:0;width:1px;height:1px;pointer-events:none;opacity:0;z-index:-1;';
      // Place at the % offset from top. 100% = bottom of the document.
      sentinel.style.top = `${Math.min(docHeight - 1, (pct / 100) * docHeight)}px`;
      document.documentElement.appendChild(sentinel);
      this.scrollSentinels.push(sentinel);
      this.scrollDepthObserver?.observe(sentinel);
    }
  }

  private teardownScrollDepthObserver(): void {
    if (this.scrollDepthObserver) {
      this.scrollDepthObserver.disconnect();
      this.scrollDepthObserver = null;
    }
    for (const el of this.scrollSentinels) el.remove();
    this.scrollSentinels = [];
  }

  // ── Error tracking ───────────────────────────────────────────────

  private sanitizePii(str: string): string {
    return str
      // Strip email addresses
      .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
      // Strip phone numbers (various formats)
      .replace(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[phone]')
      // Strip query strings AND fragments from URLs. Fragments matter for
      // OAuth implicit flow (#access_token=...) and any client-side token
      // routing pattern. Drop everything from ? or # onward; preserve the
      // path so error logs still show *where* the failure happened.
      .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)"]*/g, '$1');
  }

  private emitErrorEvent(data: {
    message: string;
    stack: string;
    source: string;
    lineno: number;
    colno: number;
    type: 'uncaught' | 'unhandled_rejection';
  }): void {
    const now = Date.now();
    if (data.message === this.lastErrorMessage && now - this.lastErrorTime < 1000) return;
    this.lastErrorMessage = data.message;
    this.lastErrorTime = now;

    this.emitCustomEvent('error', {
      message: this.sanitizePii(data.message),
      stack: this.sanitizePii(data.stack),
      source: stripUrlQuery(data.source),
      lineno: data.lineno,
      colno: data.colno,
      type: data.type,
      page: stripUrlQuery(window.location.pathname),
    });
  }

  private handleWindowError = (e: ErrorEvent): void => {
    this.emitErrorEvent({
      message: e.message || 'Unknown error',
      stack: (e.error?.stack || '').slice(0, 4000),
      source: e.filename || '',
      lineno: e.lineno || 0,
      colno: e.colno || 0,
      type: 'uncaught',
    });
  };

  private handleUnhandledRejection = (e: PromiseRejectionEvent): void => {
    const reason = e.reason;
    const message = reason instanceof Error ? reason.message : String(reason || 'Unhandled rejection');
    const stack = reason instanceof Error ? (reason.stack || '').slice(0, 4000) : '';
    this.emitErrorEvent({
      message,
      stack,
      source: '',
      lineno: 0,
      colno: 0,
      type: 'unhandled_rejection',
    });
  };

  // ── Idle detection ────────────────────────────────────────────────

  private resetIdleTimer(): void {
    this.lastInteractionTime = Date.now();
    this.idleEmitted = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleSessionTimer) {
      clearTimeout(this.idleSessionTimer);
      this.idleSessionTimer = null;
    }
    this.idleTimer = setTimeout(() => this.checkIdle(), Recorder.IDLE_THRESHOLD_MS);
  }

  private checkIdle(): void {
    if (this.idleEmitted) return;
    if (document.visibilityState !== 'visible') return;
    const elapsed = Date.now() - this.lastInteractionTime;
    if (elapsed >= Recorder.IDLE_THRESHOLD_MS) {
      this.idleEmitted = true;
      this.emitCustomEvent('idle_detected', { duration: elapsed, page: stripUrlQuery(window.location.pathname) });

      // Start the session termination countdown. If the user doesn't interact
      // within IDLE_SESSION_TIMEOUT_MS, the session is ended to prevent zombie
      // sessions that inflate duration from background DOM mutations / rrweb
      // checkout snapshots.
      if (!this.idleSessionTimer) {
        this.idleSessionTimer = setTimeout(() => {
          this.idleSessionTimer = null;
          // Only terminate if still idle (no resetIdleTimer call cleared this).
          // Keep the bridge alive so the server can still push `rotate_session`
          // when it seals the session — otherwise the seal signal has nowhere
          // to land and the SDK would be stuck on a stale sessionId.
          if (this.idleEmitted) {
            this.endedByIdle = true;
            this.stop({ keepBridge: true });
          }
        }, Recorder.IDLE_SESSION_TIMEOUT_MS - Recorder.IDLE_THRESHOLD_MS);
      }
    }
  }

  private handleKeydown = (): void => {
    this.resetIdleTimer();
  };

  // ── SPA navigation tracking ────────────────────────────────────────

  private patchHistoryMethods(): void {
    const nativePushState = History.prototype.pushState;
    const nativeReplaceState = History.prototype.replaceState;
    this.origPushState = history.pushState.bind(history);
    this.origReplaceState = history.replaceState.bind(history);
    const self = this;
    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      // Use saved original if available, fall back to native prototype method.
      // Another library may hold a reference to this patched function after we
      // unpatch (setting origPushState to null), so we must never throw.
      const fn = self.origPushState || nativePushState.bind(history);
      fn(...args);
      try { self.handleNavigation(); } catch (e) { console.warn('SessionSight: error in pushState handler', e); }
    };
    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const fn = self.origReplaceState || nativeReplaceState.bind(history);
      fn(...args);
      try { self.handleNavigation(); } catch (e) { console.warn('SessionSight: error in replaceState handler', e); }
    };
  }

  private unpatchHistoryMethods(): void {
    if (this.origPushState) { history.pushState = this.origPushState; this.origPushState = null; }
    if (this.origReplaceState) { history.replaceState = this.origReplaceState; this.origReplaceState = null; }
  }

  private handleNavigation = (): void => {
    try {
      // Compare against full href (so SPAs that update only the query string
      // still trigger a navigation event), but emit a stripped URL so query
      // params never reach the server.
      const currentHref = window.location.href;
      if (currentHref === this.lastHref) return;
      const safeHref = stripUrlQuery(currentHref);

      // Check for form abandonment before processing the navigation
      this.checkFormAbandonment();

      this.lastHref = currentHref;

      // Check if the new page should be excluded
      const shouldExclude = this.excludePagePatterns.length > 0 &&
        matchesAnyPattern(window.location.pathname, this.excludePagePatterns);

      if (shouldExclude && !this.isPaused) {
        // Entering an excluded page: flush remaining events, emit placeholder, then pause
        this.bridge.flush();
        const metaEvent: eventWithTime = {
          type: META_EVENT_TYPE,
          data: { href: safeHref, width: window.innerWidth, height: window.innerHeight },
          timestamp: Date.now(),
        };
        this.pushEvent(metaEvent);
        this.emitCustomEvent('ss-page-excluded', { href: safeHref });
        this.bridge.flush();
        this.isPaused = true;
        return;
      }

      if (!shouldExclude && this.isPaused) {
        // Leaving an excluded page: resume and take a fresh FullSnapshot
        this.isPaused = false;
      }

      // Flush all buffered events from the previous page before doing anything else.
      // Without this, SPA navigations can cause in-flight fetches to be aborted,
      // losing the entire previous page's recording.
      this.bridge.flush();

      // Previous page's text is now irrelevant, free the memory
      maskCacheClear();

      const metaEvent: eventWithTime = {
        type: META_EVENT_TYPE,
        data: { href: safeHref, width: window.innerWidth, height: window.innerHeight },
        timestamp: Date.now(),
      };
      this.pushEvent(metaEvent);

      // Restart rrweb for a fresh FullSnapshot of the new page. Null out
      // stopRrweb so guards (scroll handler) correctly skip takeFullSnapshot
      // while recording is stopped.
      if (this.stopRrweb) {
        this.stopRrweb();
        this.stopRrweb = null;
      }
      // Reset scroll depth tracking for the new page
      this.scrollDepthHits.clear();
      setTimeout(() => {
        void this.startRrweb();
        this.setupScrollDepthObserver();
      }, 100);
    } catch (e) {
      console.warn('SessionSight: error in navigation handler', e);
    }
  };

  // ── Flag token check ────────────────────────────────────────────

  private checkFlagToken(): void {
    try {
      const rawFlagToken = getRegistryValue<string>('flagEvaluationToken');
      const flagToken = rawFlagToken ? rawFlagToken.slice(0, 256) : rawFlagToken;
      if (flagToken && flagToken !== this.lastEmittedFlagToken) {
        this.lastEmittedFlagToken = flagToken;
        this.emitCustomEvent('flag_evaluation', { token: flagToken });
      }
    } catch (e) {
      console.warn('SessionSight: error checking flag token', e);
    }
  }

  private collectMetadata(): SessionMetadata {
    return {
      url: stripUrlQuery(window.location.href),
      referrer: stripUrlQuery(document.referrer || ''),
      userAgent: navigator.userAgent,
      screenWidth: window.innerWidth,
      screenHeight: window.innerHeight,
      language: navigator.language,
    };
  }

  private handleVisibilityChange = (): void => {
    try {
      if (document.visibilityState === 'hidden') {
        this.bridge.sendBeacon();
        this.hiddenAt = Date.now();
        this.isHidden = true;
      } else {
        this.isHidden = false;
        // Check elapsed time since the tab was hidden. Browsers throttle/freeze
        // setTimeout in background tabs, so a timestamp comparison is reliable
        // where a timer is not.
        if (this.hiddenAt && (Date.now() - this.hiddenAt) >= Recorder.VISIBILITY_GRACE_MS) {
          this.hiddenAt = null;
          this.endedByVisibility = true;
          // Keep the bridge alive so a pending server-side seal can still
          // deliver `rotate_session`. See the equivalent note in the idle path.
          this.stop({ keepBridge: true });
        } else {
          this.hiddenAt = null;
        }
      }
    } catch (e) {
      console.warn('SessionSight: error in visibility handler', e);
    }
  };

  private handleBeforeUnload = (): void => {
    try {
      this.checkFormAbandonment();
      this.bridge.sendBeacon();
    } catch (e) {
      console.warn('SessionSight: error in beforeunload handler', e);
    }
  };
}
