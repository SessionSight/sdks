/**
 * Stable, anchor-relative descriptors for cross-deploy element identity.
 *
 * Replaces CSS-selector chains (which encode every ancestor's position and
 * break when any sibling shifts) with a structured object that walks up to
 * a stable anchor, then describes the target element with a priority chain
 * of match strategies.
 *
 * Currently unused after the state-machinery removal; retained as a
 * general-purpose utility for any future feature that needs durable
 * element identity across deploys.
 *
 * The match priority chain inside a descriptor mirrors the priority chain
 * the legacy `buildStableSelector` used, but each strategy is structured
 * rather than concatenated into a single CSS string. The resolver tries
 * strategies in order, picks the first one that produces exactly one
 * match. Returning null is preferable to guessing; the catalog row gets
 * marked unresolved and the viewer hides its affordance.
 *
 * All text-based match strategies route through `redactString`. PII is
 * dropped at descriptor-build time so it never reaches storage.
 */

import { redactString } from '../redact.js';

/** Document landmark tags recognized as anchor candidates. */
const LANDMARK_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'DIALOG']);

/** ARIA landmark roles recognized as anchor candidates. */
const LANDMARK_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'main',
  'complementary',
  'dialog',
]);

// Framework-generated id patterns from the legacy selector builder. Kept
// in sync because the same churn problem affects descriptor anchors.
const FRAMEWORK_ID_PATTERNS: RegExp[] = [
  /^radix-/i,
  /^headlessui-/i,
  /^mui-/i,
  /^react-aria-/i,
  /^:r[0-9a-z]*:?$/i,
  /-[0-9a-f]{6,}$/i,
  /^\d+$/,
];

export function isFrameworkGeneratedId(id: string): boolean {
  for (const re of FRAMEWORK_ID_PATTERNS) {
    if (re.test(id)) return true;
  }
  return false;
}

export type AnchorKind = 'testid' | 'id' | 'landmark' | 'aria' | 'document';

export interface DescriptorAnchor {
  kind: AnchorKind;
  /** Empty when kind === 'document'. */
  value: string;
  /** Landmark/aria carry the element tag for disambiguation. */
  tag?: string;
}

export type DescriptorMatch =
  | { kind: 'testid'; value: string }
  | { kind: 'id'; value: string }
  | { kind: 'ariaLabel'; value: string }
  | { kind: 'role'; value: string; tag?: string }
  | { kind: 'text'; value: string; tag?: string }
  | { kind: 'href'; value: string }
  | { kind: 'position'; tag: string; index: number };

export interface StableDescriptor {
  anchor: DescriptorAnchor;
  match: DescriptorMatch[];
}

/** Trim, collapse whitespace, cap to 80 chars for text-based matchers. */
function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function piiSafe(input: string): string | null {
  if (!input) return null;
  const redacted = redactString(input);
  if (redacted !== input) return null;
  return input;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/**
 * 1-based document-order position of `el` among its same-tag siblings
 * inside the anchor's subtree. The anchor here is the descriptor's
 * anchor; we count siblings in the live DOM walk because the resolver
 * uses the same convention.
 */
function positionWithinAnchor(el: Element, anchorEl: Element): number {
  const tag = el.tagName;
  let cursor: Node | null = el.previousSibling;
  let n = 1;
  while (cursor) {
    if (cursor.nodeType === 1 && (cursor as Element).tagName === tag) {
      n++;
    }
    cursor = cursor.previousSibling;
  }
  // If the element shares no parent with anchor (e.g., anchor === doc),
  // position is still its sibling index. The resolver mirrors this.
  void anchorEl;
  return n;
}

/**
 * Locate the nearest ancestor that qualifies as a stable anchor for the
 * descriptor. Walks from `el` upward, returning the first ancestor that
 * matches an anchor kind. Returns `null` if no qualifying ancestor exists
 * before `<body>` (the descriptor anchors to `document` in that case).
 */
function findAnchorAncestor(el: Element): { anchor: Element; kind: AnchorKind; value: string } | null {
  let cursor: Element | null = el.parentElement;
  while (cursor) {
    const tag = cursor.tagName;
    if (tag === 'BODY' || tag === 'HTML') return null;

    const testid = cursor.getAttribute('data-testid');
    if (testid) {
      const safe = piiSafe(testid);
      if (safe) return { anchor: cursor, kind: 'testid', value: safe };
    }

    const idAttr = cursor.getAttribute('id');
    if (idAttr && !isFrameworkGeneratedId(idAttr)) {
      const safe = piiSafe(idAttr);
      if (safe) return { anchor: cursor, kind: 'id', value: safe };
    }

    if (LANDMARK_TAGS.has(tag)) {
      return { anchor: cursor, kind: 'landmark', value: tag.toLowerCase() };
    }

    const role = cursor.getAttribute('role');
    if (role && LANDMARK_ROLES.has(role)) {
      return { anchor: cursor, kind: 'landmark', value: role };
    }

    const aria = cursor.getAttribute('aria-label');
    if (aria) {
      const safe = piiSafe(normalizeText(aria));
      if (safe) return { anchor: cursor, kind: 'aria', value: safe };
    }

    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Build the match priority chain for `el` relative to its anchor subtree.
 * Each strategy that survives the PII filter is appended. Position is
 * always emitted as the last-resort tie-breaker.
 */
function buildMatchChain(el: Element): DescriptorMatch[] {
  const out: DescriptorMatch[] = [];
  const tag = tagOf(el);

  const testid = el.getAttribute('data-testid');
  if (testid) {
    const safe = piiSafe(testid);
    if (safe) out.push({ kind: 'testid', value: safe });
  }

  const idAttr = el.getAttribute('id');
  if (idAttr && !isFrameworkGeneratedId(idAttr)) {
    const safe = piiSafe(idAttr);
    if (safe) out.push({ kind: 'id', value: safe });
  }

  const aria = el.getAttribute('aria-label');
  if (aria) {
    const safe = piiSafe(normalizeText(aria));
    if (safe) out.push({ kind: 'ariaLabel', value: safe });
  }

  const role = el.getAttribute('role');
  if (role) {
    const safe = piiSafe(role);
    if (safe) out.push({ kind: 'role', value: safe, tag });
  }

  // textContent for buttons/links/headings is the most stable signal
  // across class/id churn. Cap normalized text at 80 chars.
  const text = normalizeText(el.textContent || '');
  if (text) {
    const safe = piiSafe(text);
    if (safe) out.push({ kind: 'text', value: safe, tag });
  }

  // href for anchor elements is uniquely identifying within an anchor's
  // subtree more often than text.
  if (tag === 'a') {
    const href = (el as HTMLAnchorElement).getAttribute('href');
    if (href) {
      // Strip query/fragment via the redactor's URL-stripper would be
      // overkill here; the redactString filter handles PII in URLs.
      const safe = piiSafe(href);
      if (safe) out.push({ kind: 'href', value: safe });
    }
  }

  return out;
}

/**
 * Build a stable descriptor for `el`. The descriptor is anchor-relative
 * and carries a priority chain of match strategies the resolver tries in
 * order. Returns `null` for non-element nodes.
 */
export function buildStableDescriptor(el: Element | null): StableDescriptor | null {
  if (!el || el.nodeType !== 1) return null;

  const anchorInfo = findAnchorAncestor(el);
  const anchor: DescriptorAnchor = anchorInfo
    ? {
        kind: anchorInfo.kind,
        value: anchorInfo.value,
        tag: anchorInfo.kind === 'landmark' || anchorInfo.kind === 'aria' ? anchorInfo.anchor.tagName.toLowerCase() : undefined,
      }
    : { kind: 'document', value: '' };

  const match = buildMatchChain(el);

  // Always append a position fallback. The "anchor" for position is the
  // resolved anchor element (or the document root for kind === 'document').
  // We compute position relative to the immediate parent inside the
  // anchor. That's the cheapest stable thing to compute and matches the
  // resolver's behavior. Tag is required so the resolver can scope the
  // siblings considered.
  const anchorEl = anchorInfo?.anchor ?? null;
  const index = positionWithinAnchor(el, anchorEl ?? el);
  match.push({ kind: 'position', tag: tagOf(el), index });

  return { anchor, match };
}

/** Compact JSON serialization for storage and wire transport. */
export function serializeDescriptor(d: StableDescriptor): string {
  return JSON.stringify(d);
}

/** Round-trip the JSON form. Returns null on parse failure. */
export function deserializeDescriptor(s: string): StableDescriptor | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.anchor || !Array.isArray(parsed.match)) return null;
    return parsed as StableDescriptor;
  } catch {
    return null;
  }
}

/**
 * Canonical wire payload used by the backend's `signatureFor`. Lives
 * here so the descriptor pair → bytes contract has a single source of
 * truth shared by builder and hasher. The backend's hash is computed
 * over `JSON.stringify(signaturePayload(trigger, subtree))`.
 */
export function signaturePayload(
  triggerDescriptor: StableDescriptor | null,
  subtreeRootDescriptor: StableDescriptor | null,
): unknown {
  return [triggerDescriptor, subtreeRootDescriptor];
}
