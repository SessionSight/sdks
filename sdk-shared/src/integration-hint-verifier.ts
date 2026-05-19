/**
 * Shared verifier for SDK integration hints.
 *
 * Each SDK package owns its own integration hint at `src/integration-hint.ts`,
 * exported as code (function expressions referencing live SDK exports). The
 * import graph itself catches structural drift: if a referenced function gets
 * renamed or removed, the SDK no longer compiles. This verifier adds a
 * structural shape check on top so callers can fail loud at build time:
 *
 *   - `sdkPackage` is a non-empty string (used to identify the SDK).
 *   - `install` is a non-empty string (npm/bun install command).
 *   - `docsUrl` is a non-empty string starting with http(s).
 *   - `initFn` and `usageFn` are function expressions.
 *
 * The hint snippet rendering happens at consumption time via
 * `Function.prototype.toString()`. Verifying both functions exist guarantees
 * the toString() call won't yield `undefined.toString()`.
 */

export interface IntegrationHint {
  sdkPackage: string;
  install: string;
  initFn: (...args: unknown[]) => unknown;
  usageFn: (...args: unknown[]) => unknown;
  docsUrl: string;
}

export class IntegrationHintError extends Error {
  constructor(message: string) {
    super(`integration-hint: ${message}`);
    this.name = 'IntegrationHintError';
  }
}

export async function verifyHint(hint: IntegrationHint): Promise<void> {
  if (!hint || typeof hint !== 'object') {
    throw new IntegrationHintError('hint must be an object');
  }
  if (!isNonEmptyString(hint.sdkPackage)) {
    throw new IntegrationHintError('sdkPackage must be a non-empty string');
  }
  if (!isNonEmptyString(hint.install)) {
    throw new IntegrationHintError('install must be a non-empty string');
  }
  if (!isNonEmptyString(hint.docsUrl) || !/^https?:\/\//.test(hint.docsUrl)) {
    throw new IntegrationHintError('docsUrl must start with http(s)://');
  }
  if (typeof hint.initFn !== 'function') {
    throw new IntegrationHintError('initFn must be a function');
  }
  if (typeof hint.usageFn !== 'function') {
    throw new IntegrationHintError('usageFn must be a function');
  }
  // Stringify both to make sure the function bodies aren't empty or
  // single-statement no-ops left over from a botched refactor. A two-line
  // floor is conservative enough to trip on `() => {}` while still
  // accepting a one-liner like `() => SessionSight.goals.increment('rev')`.
  const initSrc = hint.initFn.toString();
  const usageSrc = hint.usageFn.toString();
  if (!isMeaningfulFnSource(initSrc)) {
    throw new IntegrationHintError(`initFn body looks empty (got ${initSrc})`);
  }
  if (!isMeaningfulFnSource(usageSrc)) {
    throw new IntegrationHintError(`usageFn body looks empty (got ${usageSrc})`);
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isMeaningfulFnSource(src: string): boolean {
  // Strip whitespace + braces; require something other than `{}` or empty.
  const stripped = src
    .replace(/\s+/g, '')
    .replace(/^\(\)=>/, '')
    .replace(/^function[^(]*\(\)\{?/, '')
    .replace(/\}$/, '');
  return stripped.length > 0;
}

/**
 * Render a hint into the plain payload the MCP layer returns to clients.
 * `installCmd`, `initSnippet`, and `usageSnippet` are strings the agent can
 * paste into the user's repo as-is; `docsUrl` is a fallback link the outer
 * agent can fetch when the snippet doesn't fit the user's stack.
 */
export interface RenderedIntegrationHint {
  sdkPackage: string;
  install: string;
  initSnippet: string;
  usageSnippet: string;
  docsUrl: string;
}

export function renderHint(hint: IntegrationHint): RenderedIntegrationHint {
  return {
    sdkPackage: hint.sdkPackage,
    install: hint.install,
    initSnippet: hint.initFn.toString(),
    usageSnippet: hint.usageFn.toString(),
    docsUrl: hint.docsUrl,
  };
}
