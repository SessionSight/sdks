/**
 * Stable selector builder for SessionSight.
 *
 * Used by the SDK recorder (scroll-container detection, state-trigger
 * attribution, state subtree roots, state label fallback) and by any
 * server-side label finalization that needs to derive the same selector
 * from the same element. The function only consults attributes/tag/index
 * (no live styles, no client coordinates), so the same Element produces
 * the same selector across calls.
 *
 * Priority chain per ancestor:
 *   1. [data-testid="..."]
 *   2. #<id>                  (skipping framework-generated patterns)
 *   3. [aria-label="..."]
 *   4. <tag>:nth-of-type(<n>)
 *
 * After building each segment string we run it through `redactString`. If
 * the redactor changed anything, the segment carries PII; drop it and
 * advance the priority chain. This is the single source of truth for what
 * counts as PII (`applyMasking`, server-side `redactSerializedNode`,
 * state-label generation, and this util all share the same regex set).
 *
 * Hard cap at 200 characters: selectors past that are usually unstable
 * framework chains and don't aggregate well anyway.
 */

import { redactString } from '../redact.js';

const MAX_SELECTOR_LEN = 200;

// Framework-generated id patterns: churn per render so they break cross-
// session aggregation. Listed conservatively; add cases here when observed
// in real customer pages.
//
// React 18 `useId` returns `:r<id>:`; we match a leading `:r` followed by
// any chars. The colon itself isn't valid in a plain selector, but ids in
// the wild may still hit this shape via attribute attr.
const FRAMEWORK_ID_PATTERNS: RegExp[] = [
  /^radix-/i,
  /^headlessui-/i,
  /^mui-/i,
  /^react-aria-/i,
  /^:r[0-9a-z]*:?$/i,
  /-[0-9a-f]{6,}$/i,
  /^\d+$/,
];

function isFrameworkGeneratedId(id: string): boolean {
  for (const re of FRAMEWORK_ID_PATTERNS) {
    if (re.test(id)) return true;
  }
  return false;
}

/**
 * Run a candidate selector segment through `redactString`. If the output
 * differs from the input, the segment had PII spans replaced; we drop it.
 * Returns the safe segment, or null if the segment must be dropped.
 */
function piiSafe(segment: string): string | null {
  if (!segment) return null;
  const redacted = redactString(segment);
  if (redacted !== segment) return null;
  return segment;
}

/**
 * CSS-escape an attribute value for use inside `[attr="..."]`. Replaces
 * backslashes and double quotes; sufficient for the data-testid /
 * aria-label / id values we consult.
 */
function cssEscapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Compute the 1-based `nth-of-type` index of the element among its
 * same-tag siblings. Returns 1 if the element has no parent.
 */
function nthOfType(el: Element): number {
  const parent = el.parentNode;
  if (!parent) return 1;
  let n = 1;
  let cursor: Node | null = el.previousSibling;
  while (cursor) {
    if (
      cursor.nodeType === 1 /* ELEMENT_NODE */ &&
      (cursor as Element).tagName === el.tagName
    ) {
      n++;
    }
    cursor = cursor.previousSibling;
  }
  return n;
}

/**
 * Build the best-effort segment for a single element. Walks the priority
 * chain (data-testid → id → aria-label → nth-of-type) and returns the
 * first option that passes the PII filter.
 */
function buildSegment(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // 1. data-testid
  const testid = el.getAttribute('data-testid');
  if (testid) {
    const segment = `[data-testid="${cssEscapeAttrValue(testid)}"]`;
    const safe = piiSafe(segment);
    if (safe) return safe;
  }

  // 2. id (skipping framework-generated patterns)
  const id = el.getAttribute('id');
  if (id && !isFrameworkGeneratedId(id)) {
    const segment = `#${id.replace(/([^\w-])/g, '\\$1')}`;
    const safe = piiSafe(segment);
    if (safe) return safe;
  }

  // 3. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const segment = `[aria-label="${cssEscapeAttrValue(ariaLabel)}"]`;
    const safe = piiSafe(segment);
    if (safe) return safe;
  }

  // 4. nth-of-type fallback (always safe; no user content)
  return `${tag}:nth-of-type(${nthOfType(el)})`;
}

/**
 * Build a stable CSS selector for `el`, walking up the ancestor chain
 * until a uniquely-rooted selector is found (data-testid / non-framework
 * id) or we hit `<html>`.
 *
 * Returns a string that `document.querySelector` can consume on the same
 * document, capped at 200 characters. For pathological cases (very deep
 * trees with no stable anchors) the cap is hit and the rest of the chain
 * is dropped; aggregation across sessions is best-effort there, by
 * design.
 */
export function buildStableSelector(el: Element): string {
  if (!el || el.nodeType !== 1) return '';
  if (el.tagName === 'HTML' || el.tagName === 'BODY') {
    return el.tagName.toLowerCase();
  }

  const segments: string[] = [];
  let cursor: Element | null = el;

  while (cursor && cursor.nodeType === 1) {
    const tag = cursor.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      // Don't include the document root in the chain; it's implicit.
      break;
    }

    const segment = buildSegment(cursor);
    segments.unshift(segment);

    // If the segment is "uniquely rooted" (data-testid or a stable id),
    // we can stop walking up: querySelector against this segment from the
    // document root should resolve to the same element across renders.
    if (segment.startsWith('[data-testid=') || segment.startsWith('#')) {
      break;
    }

    cursor = cursor.parentElement;
  }

  if (segments.length === 0) return el.tagName.toLowerCase();

  let result = segments.join(' > ');
  if (result.length > MAX_SELECTOR_LEN) {
    // Truncate from the left; keep the most specific (deepest) tail.
    // Drop leading segments until under the cap.
    while (segments.length > 1 && result.length > MAX_SELECTOR_LEN) {
      segments.shift();
      result = segments.join(' > ');
    }
    if (result.length > MAX_SELECTOR_LEN) {
      result = result.slice(result.length - MAX_SELECTOR_LEN);
    }
  }
  return result;
}
