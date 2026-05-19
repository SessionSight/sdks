/**
 * Resolve a `StableDescriptor` against a live DOM root.
 *
 * Strict semantics: each match strategy must produce exactly one element
 * inside the descriptor's anchor subtree. Strategies that produce zero or
 * multiple matches fall through to the next strategy. If every strategy
 * fails, the descriptor is unresolved and we return null. The viewer
 * marks the catalog row unresolved rather than guessing.
 *
 * Callable from both browser (heatmap viewer) and server (JSDOM in the
 * session-analytics worker / inference pass). The only DOM surface used
 * is `querySelectorAll`, `getAttribute`, `tagName`, `textContent`, all
 * supported by JSDOM.
 */

import type {
  StableDescriptor,
  DescriptorAnchor,
  DescriptorMatch,
} from './stable-descriptor.js';

// Re-export the types here so callers can `import type { ... } from '.../resolve-stable.js'`
// without reaching into the builder module.
export type { StableDescriptor, DescriptorMatch, DescriptorAnchor } from './stable-descriptor.js';

/** Escape a value for use inside `[attr="..."]`. */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Locate the descriptor anchor in `root`. Returns the anchor element or
 * `root` itself when the descriptor anchors to the document.
 */
function findAnchor(root: ParentNode, anchor: DescriptorAnchor): Element | ParentNode | null {
  switch (anchor.kind) {
    case 'document':
      return root;
    case 'testid':
      return root.querySelector(`[data-testid="${escapeAttr(anchor.value)}"]`);
    case 'id':
      // Anchor ids should be uniquely-rooted. Use a regular query so the
      // resolver also works on document fragments (which lack
      // getElementById).
      return root.querySelector(`#${cssEscapeId(anchor.value)}`);
    case 'landmark': {
      // Match either tag (nav/header/main/...) or role (navigation/banner/...)
      const v = anchor.value;
      const TAG_VALUES = new Set(['nav', 'header', 'footer', 'main', 'aside', 'dialog']);
      if (TAG_VALUES.has(v)) {
        // Tagged landmark. Anchor.tag may also be set; prefer it when present.
        const tag = (anchor.tag || v).toLowerCase();
        return root.querySelector(tag);
      }
      // Otherwise it's a role: select by role attribute.
      return root.querySelector(`[role="${escapeAttr(v)}"]`);
    }
    case 'aria': {
      // aria-label match; tag (if present) constrains the element kind.
      const sel = anchor.tag
        ? `${anchor.tag}[aria-label="${escapeAttr(anchor.value)}"]`
        : `[aria-label="${escapeAttr(anchor.value)}"]`;
      return root.querySelector(sel);
    }
    default:
      return null;
  }
}

function cssEscapeId(id: string): string {
  // Minimal CSS.escape polyfill that's safe for the id characters we
  // actually emit (no leading digits because framework patterns reject
  // those; no whitespace because the redactor would have dropped them).
  return id.replace(/([^\w-])/g, '\\$1');
}

/**
 * Collect the candidate elements for a single match strategy, scoped to
 * the anchor subtree.
 */
function candidatesFor(scope: ParentNode, strategy: DescriptorMatch): Element[] {
  switch (strategy.kind) {
    case 'testid':
      return Array.from(scope.querySelectorAll(`[data-testid="${escapeAttr(strategy.value)}"]`));
    case 'id':
      return Array.from(scope.querySelectorAll(`#${cssEscapeId(strategy.value)}`));
    case 'ariaLabel':
      return Array.from(scope.querySelectorAll(`[aria-label="${escapeAttr(strategy.value)}"]`));
    case 'role': {
      const tag = strategy.tag || '*';
      return Array.from(scope.querySelectorAll(`${tag}[role="${escapeAttr(strategy.value)}"]`));
    }
    case 'text': {
      // textContent matching: collect all elements of the given tag (or
      // any tag if no tag hint) and compare normalized text.
      const tag = strategy.tag || '*';
      const all = Array.from(scope.querySelectorAll(tag));
      const target = normalize(strategy.value);
      return all.filter((el) => normalize(el.textContent || '') === target);
    }
    case 'href':
      return Array.from(scope.querySelectorAll(`a[href="${escapeAttr(strategy.value)}"]`));
    case 'position': {
      // Position is a last-resort fallback. The builder records the
      // immediate-sibling index of the target, but the resolver scopes
      // over the entire anchor subtree via querySelectorAll; those
      // two indices aren't the same thing in general. To keep position
      // from confidently picking an unrelated "Nth div in the
      // document" we only let it resolve when the scope is narrow:
      // ≤ POSITION_MAX_CANDIDATES same-tag candidates. Beyond that,
      // return [] so the resolver falls through to "no match" and the
      // caller treats the descriptor as unresolved (better than a
      // wrong reveal).
      const POSITION_MAX_CANDIDATES = 8;
      const all = Array.from(scope.querySelectorAll(strategy.tag));
      if (all.length > POSITION_MAX_CANDIDATES) return [];
      const pick = all[strategy.index - 1];
      return pick ? [pick] : [];
    }
    default:
      return [];
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Resolve `descriptor` against `root`. Returns the matched element, or
 * null when no strategy produces a unique match.
 */
export function resolveStable(
  root: ParentNode | null | undefined,
  descriptor: StableDescriptor | null | undefined,
): Element | null {
  if (!root || !descriptor) return null;
  const anchorNode = findAnchor(root, descriptor.anchor);
  if (!anchorNode) return null;

  // For each strategy in priority order, look for a unique match. The
  // first strategy producing exactly one candidate wins. Strategies
  // producing zero or many candidates fall through.
  for (const strategy of descriptor.match) {
    const candidates = candidatesFor(anchorNode, strategy);
    if (candidates.length === 1) return candidates[0]!;
  }

  return null;
}

/**
 * Try to resolve a descriptor against a root, returning both the result
 * and which strategy succeeded (for telemetry). Slightly more expensive
 * than `resolveStable` because it records the winning strategy.
 */
export function resolveStableTraced(
  root: ParentNode | null | undefined,
  descriptor: StableDescriptor | null | undefined,
): { element: Element | null; strategy: DescriptorMatch['kind'] | null } {
  if (!root || !descriptor) return { element: null, strategy: null };
  const anchorNode = findAnchor(root, descriptor.anchor);
  if (!anchorNode) return { element: null, strategy: null };

  for (const strategy of descriptor.match) {
    const candidates = candidatesFor(anchorNode, strategy);
    if (candidates.length === 1) return { element: candidates[0]!, strategy: strategy.kind };
  }
  return { element: null, strategy: null };
}
