// ── Redaction ────────────────────────────────────────────────────────

import { containsProhibitedPII } from './redact.js';

export {
  redactString,
  containsProhibitedPII,
  stripUrlQuery,
  REDACTED,
  luhnCheck,
  // Media stripping primitives (image, video, audio)
  SS_BLOCKED_ATTR,
  SS_ALLOW_ATTR,
  SS_MEDIA_SHIM,
  SS_HATCH_GRADIENT,
  URL_BEARING_CSS_PROPERTIES,
  URL_FUNC_RE,
  stripStylesheetUrls,
  stripInlineStyleUrls,
  isEmbeddedMediaUrl,
  filterSrcsetForEmbeddedUrls,
  parseSrcset,
} from './redact.js';
export type { RedactOptions } from './redact.js';

// ── Selectors ────────────────────────────────────────────────────────

export { buildStableSelector } from './selectors/build-stable-selector.js';
export {
  buildStableDescriptor,
  serializeDescriptor,
  deserializeDescriptor,
  signaturePayload,
  isFrameworkGeneratedId,
} from './selectors/stable-descriptor.js';
export type {
  StableDescriptor,
  DescriptorAnchor,
  DescriptorMatch,
  AnchorKind,
} from './selectors/stable-descriptor.js';
export { resolveStable, resolveStableTraced } from './selectors/resolve-stable.js';

// ── Identify payload limits ──────────────────────────────────────────
//
// Single source of truth for the limits enforced on the SDK's `identify()`
// payload. The SDK validator (`packages/insights/src/index.ts`) and the
// ingest zod schema (`apps/api/src/schemas/ingest.schema.ts`) both import
// these. Adding or changing a limit is a one-file edit.

/** Maximum length of the customer-supplied `id` (opaque stable identifier). */
export const MAX_ID_LEN = 256;

/** RFC 5321 absolute limit for an email address. */
export const MAX_EMAIL_LEN = 320;

/** Maximum length of a custom property key name. */
export const MAX_CUSTOM_KEY_LEN = 128;

/** Maximum length of a custom property string value. */
export const MAX_CUSTOM_VALUE_LEN = 1024;

/** Maximum number of custom properties on a single visitor profile. */
export const MAX_CUSTOM_PROPERTY_COUNT = 20;

/**
 * Keys the SDK extracts from the flat `identify()` payload and routes to
 * dedicated top-level wire slots. Reserved at the SDK so callers cannot
 * smuggle them into `customProperties`.
 *
 * Other field names that exist on the visitor profile (`visitorId`,
 * `firstSeenAt`, etc.) are intentionally NOT reserved because custom
 * properties live under `customProperties.*` in storage and cannot collide
 * with the top-level profile fields.
 */
export const RESERVED_CUSTOM_PROPERTY_KEYS = ['id', 'email'] as const;

/**
 * Email-shape validator shared between the SDK and the ingest zod schema.
 * The SDK calls this directly; the schema uses it via `z.string().refine`.
 *
 * Stricter than `z.string().email()` (which accepts `foo@bar` without a TLD)
 * to keep a single, consistent contract on both sides of the wire.
 *
 * If `containsProhibitedPII` ever drops `skipEmail`, the email-shape
 * rejection on the `id` slot becomes redundant; see notes in the SDK.
 */
export function isValidEmail(input: string): boolean {
  if (typeof input !== 'string') return false;
  if (input.length === 0 || input.length > MAX_EMAIL_LEN) return false;
  if (/\s/.test(input)) return false;
  const at = input.indexOf('@');
  if (at < 1) return false;
  if (input.indexOf('@', at + 1) !== -1) return false;
  const local = input.slice(0, at);
  const domain = input.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  const dot = domain.lastIndexOf('.');
  if (dot < 1 || dot === domain.length - 1) return false;
  const tld = domain.slice(dot + 1);
  if (tld.length < 2) return false;
  if (!/^[A-Za-z]+$/.test(tld)) return false;
  return true;
}

// ── SDK Constants ────────────────────────────────────────────────────

export const DEFAULT_API_URL = 'https://api.sessionsight.com';

export function normalizeApiUrl(url: string): string {
  const normalized = (url || DEFAULT_API_URL).replace(/\/$/, '');
  // After stripping a trailing slash, an input of '/' collapses to ''.
  // Fall back to DEFAULT_API_URL so callers don't end up building relative
  // URLs against an empty base.
  if (normalized.length === 0) return DEFAULT_API_URL;
  if (normalized.startsWith('http://') && !normalized.startsWith('http://localhost')) {
    console.warn('SessionSight: API URL uses http:// instead of https://. Data will be transmitted unencrypted.');
  }
  return normalized;
}

// ── Visitor Identity ────────────────────────────────────────────────

const VISITOR_STORAGE_KEY = 'sessionsight_visitor_id';
const VISITOR_COOKIE_NAME = 'ss_vid';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string, maxAge: number): void {
  if (typeof document === 'undefined') return;
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${value}; path=/; max-age=${maxAge}; SameSite=Lax${secure}`;
  } catch {
    // Cookie access may be blocked
  }
}

/**
 * Generate a cryptographically random v4 UUID.
 * Refuses to fall back to Math.random: predictable IDs would let an attacker
 * collide with or forge real visitor/session records.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
  }
  throw new Error('SessionSight: secure random generator unavailable (no crypto.randomUUID or crypto.getRandomValues)');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Re-evaluate per call whether `localStorage` is usable. Returns false in
 * SSR, in private-mode browsers that throw on write, and when the page
 * disables storage (e.g. some embedded contexts). Callers should NOT
 * memoize the result at module load time; an SSR import followed by a
 * browser-run would permanently see `false`.
 */
export function hasLocalStorage(): boolean {
  try {
    const key = '__ss_test__';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the browser signals that persistent tracking IDs should be suppressed.
 * Returns true if Global Privacy Control (GPC) or Do Not Track (DNT) is enabled.
 */
export function shouldSuppressPersistentId(): boolean {
  if (typeof navigator !== 'undefined') {
    if ((navigator as any).globalPrivacyControl === true) return true;
    if (navigator.doNotTrack === '1') return true;
  }
  return false;
}

/**
 * Get or create a stable visitor ID. Checks (in order):
 * 1. Provided ID (if given)
 * 2. Cookie `ss_vid`
 * 3. localStorage `sessionsight_visitor_id`
 * 4. Generate new UUID and persist to both
 *
 * If DNT or GPC signals are active, generates an in-memory-only UUID
 * that is not persisted to cookie or localStorage.
 */
export function getOrCreateVisitorId(providedId?: string): string {
  if (providedId) return providedId;

  // When DNT/GPC is active, return a fresh in-memory ID without persisting
  if (shouldSuppressPersistentId()) {
    return generateUUID();
  }

  const canStore = typeof window !== 'undefined' && hasLocalStorage();

  const cookieId = readCookie(VISITOR_COOKIE_NAME);
  if (cookieId && isValidUUID(cookieId)) {
    if (canStore) localStorage.setItem(VISITOR_STORAGE_KEY, cookieId);
    return cookieId;
  }

  if (canStore) {
    const stored = localStorage.getItem(VISITOR_STORAGE_KEY);
    if (stored && isValidUUID(stored)) {
      setCookie(VISITOR_COOKIE_NAME, stored, VISITOR_COOKIE_MAX_AGE);
      return stored;
    }
  }

  const id = generateUUID();
  if (canStore) localStorage.setItem(VISITOR_STORAGE_KEY, id);
  setCookie(VISITOR_COOKIE_NAME, id, VISITOR_COOKIE_MAX_AGE);
  return id;
}

/**
 * Persist a server-issued visitorId to cookie and localStorage. Used when
 * bootstrap refuses to reuse the client's cached id (it was already claimed
 * by another browser) and mints a fresh one. Skipped under DNT/GPC; those
 * sessions already use in-memory-only IDs and must not start persisting.
 */
export function writeVisitorId(id: string): void {
  if (!isValidUUID(id)) return;
  if (shouldSuppressPersistentId()) return;
  if (typeof window !== 'undefined' && hasLocalStorage()) {
    try { localStorage.setItem(VISITOR_STORAGE_KEY, id); } catch { /* ignore */ }
  }
  setCookie(VISITOR_COOKIE_NAME, id, VISITOR_COOKIE_MAX_AGE);
}

// ── Visitor Token Storage ───────────────────────────────────────────

const VISITOR_TOKEN_COOKIE_NAME = 'ss_vtoken';
const VISITOR_TOKEN_STORAGE_KEY = 'sessionsight_visitor_token';

/** Matches the v1 token format produced by the backend (v1.<b64>.<b64>). */
const VISITOR_TOKEN_RE = /^v\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isValidVisitorToken(token: string): boolean {
  return typeof token === 'string' && token.length >= 55 && token.length <= 80 && VISITOR_TOKEN_RE.test(token);
}

/**
 * Read the stored visitor token, if any. Checks cookie first, then
 * localStorage. Returns null if neither has a syntactically-valid value.
 *
 * Does not check expiration or verify the signature; those are server
 * concerns. The server rejects stale tokens with 401 VISITOR_TOKEN_EXPIRED
 * and the SDK's transport layer clears + re-bootstraps on that response.
 */
export function getStoredVisitorToken(): string | null {
  const cookie = readCookie(VISITOR_TOKEN_COOKIE_NAME);
  if (cookie && isValidVisitorToken(cookie)) return cookie;

  if (typeof window !== 'undefined' && hasLocalStorage()) {
    const stored = localStorage.getItem(VISITOR_TOKEN_STORAGE_KEY);
    if (stored && isValidVisitorToken(stored)) return stored;
  }

  return null;
}

/**
 * Persist a visitor token to cookie and localStorage. Skips persistence
 * entirely when DNT/GPC is active, matching the visitor-id behavior: the
 * token still lives in memory for the tab (callers that need it should
 * pass the value around, not re-read from storage).
 */
export function writeVisitorToken(token: string): void {
  if (!isValidVisitorToken(token)) return;
  if (shouldSuppressPersistentId()) return;

  setCookie(VISITOR_TOKEN_COOKIE_NAME, token, VISITOR_COOKIE_MAX_AGE);
  if (typeof window !== 'undefined' && hasLocalStorage()) {
    try {
      localStorage.setItem(VISITOR_TOKEN_STORAGE_KEY, token);
    } catch {
      // Storage quota or disabled; cookie alone is still useful.
    }
  }
}

/**
 * Remove the stored visitor token from cookie and localStorage. Called
 * when the server reports the token is required / expired / invalid and
 * the SDK is about to re-bootstrap.
 */
export function clearVisitorToken(): void {
  if (typeof document !== 'undefined') {
    try {
      // Expire the cookie by setting max-age=0. Mirror the create-path's
      // `Secure` attribute on HTTPS so the deletion cookie matches the
      // attributes of the cookie it's clearing.
      const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${VISITOR_TOKEN_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax${secure}`;
    } catch {
      // Cookie access may be blocked.
    }
  }
  if (typeof window !== 'undefined' && hasLocalStorage()) {
    try {
      localStorage.removeItem(VISITOR_TOKEN_STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}

// ── Visitor Token Bootstrap ─────────────────────────────────────────

export interface BootstrapVisitorTokenOptions {
  apiUrl: string;
  publicApiKey: string;
  propertyId: string;
  /**
   * Optional UUID the caller wants to claim. If it is already claimed by
   * another browser, the server returns a fresh server-minted id instead;
   * callers must use the returned `visitorId` as canonical.
   */
  clientVisitorId?: string;
}

export interface BootstrapVisitorTokenResult {
  visitorId: string;
  visitorToken: string;
  issuedAt: number;
}

/**
 * Call POST /v1/sdk/visitor/bootstrap to obtain a server-signed visitor
 * token. On success the token is persisted via writeVisitorToken and the
 * result is returned. Failures throw; callers should treat bootstrap as
 * best-effort (the ingest endpoint's inline-mint path catches first-time
 * events that arrive without a token).
 */
export async function bootstrapVisitorToken(
  opts: BootstrapVisitorTokenOptions,
): Promise<BootstrapVisitorTokenResult> {
  const res = await fetch(`${opts.apiUrl}/v1/sdk/visitor/bootstrap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.publicApiKey,
    },
    body: JSON.stringify({
      propertyId: opts.propertyId,
      ...(opts.clientVisitorId ? { clientVisitorId: opts.clientVisitorId } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`bootstrapVisitorToken failed with status ${res.status}`);
  }
  const data = (await res.json()) as BootstrapVisitorTokenResult;
  if (!data?.visitorToken || !data?.visitorId) {
    throw new Error('bootstrapVisitorToken: malformed response');
  }
  // Format-validate before persisting. writeVisitorToken silently no-ops on
  // invalid input, so without these checks an unwriteable token would still
  // be returned as success and the caller's storage would be empty,
  // triggering re-bootstrap on every event.
  if (typeof data.visitorToken !== 'string' || !VISITOR_TOKEN_RE.test(data.visitorToken) || data.visitorToken.length < 55 || data.visitorToken.length > 80) {
    throw new Error('bootstrapVisitorToken: visitorToken does not match expected format');
  }
  if (typeof data.visitorId !== 'string' || !UUID_RE.test(data.visitorId)) {
    throw new Error('bootstrapVisitorToken: visitorId is not a valid UUID');
  }
  if (typeof data.issuedAt !== 'number' || !Number.isFinite(data.issuedAt)) {
    throw new Error('bootstrapVisitorToken: issuedAt is not a number');
  }
  writeVisitorToken(data.visitorToken);
  return data;
}

// ── Session Identity ────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'ss_sid';

/**
 * Write the current sessionId to a browser-session-scoped cookie (no max-age,
 * clears on browser close). Backend SDKs read this cookie to pair server-side
 * events with the active recording session.
 *
 * Multi-tab note: cookies are shared across tabs, so the last writer wins.
 * Callers should re-write on focus/visibility changes so the currently-active
 * tab owns the cookie.
 */
export function writeSessionCookie(sessionId: string): void {
  if (typeof document === 'undefined' || !sessionId) return;
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; path=/; SameSite=Lax${secure}`;
  } catch {
    // Cookie access may be blocked
  }
}

/** Read the current sessionId from the browser-session cookie, or null. */
export function readSessionCookie(): string | null {
  return readCookie(SESSION_COOKIE_NAME);
}

/**
 * Clear the session-id cookie. Used by consent withdrawal
 * (setConsent(false)) as part of session-scoped teardown. Does not touch
 * the visitor cookie or localStorage.
 */
export function clearSessionCookie(): void {
  if (typeof document === 'undefined') return;
  try {
    // Mirror the create-path's `Secure` attribute on HTTPS for consistency
    // with `writeSessionCookie`.
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${SESSION_COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax${secure}`;
  } catch {
    // Cookie access may be blocked.
  }
}

// ── Server-side request-context extraction ──────────────────────────

export interface RequestIds {
  visitorId: string | null;
  sessionId: string | null;
}

/**
 * Parse a cookie header string (e.g., "a=1; b=2") into a name → value map.
 * Values are URL-decoded. Returns empty object for null/empty input.
 */
function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Extract `ss_vid` and `ss_sid` from a request-like object.
 *
 * Duck-types across common server frameworks so the host doesn't need to
 * know what shape their request exposes. Tried in order:
 *   1. `cookies.get(name)` method: SvelteKit Cookies, Koa Cookies
 *   2. Pre-parsed cookies map: `req.cookies?.ss_vid` (Express + cookie-parser, Next.js Pages Router)
 *   3. Fetch-style header: `req.headers?.get?.('cookie')` (Next.js App Router, SvelteKit, Hono, Remix, Workers, Deno, Bun, native Request)
 *   4. Node-style header: `req.headers?.cookie` (raw Node, Express, Koa, Fastify)
 *   5. Nested Nuxt/h3 event: `event.node.req.headers.cookie`
 *   6. Raw cookie-header string passed directly
 *
 * Returns `{ visitorId: null, sessionId: null }` if neither is found.
 */
export function extractIdsFromRequest(req: unknown): RequestIds {
  if (req == null) return { visitorId: null, sessionId: null };

  // 6. Raw string → treat as cookie header.
  if (typeof req === 'string') {
    const parsed = parseCookieHeader(req);
    return {
      visitorId: parsed[VISITOR_COOKIE_NAME] || null,
      sessionId: parsed[SESSION_COOKIE_NAME] || null,
    };
  }

  if (typeof req !== 'object') return { visitorId: null, sessionId: null };
  const r = req as any;

  // 1. SvelteKit / Koa Cookies object: method-style .get(name). Checked
  //    before the map-style check because the SvelteKit `cookies` object
  //    looks like an object but the cookie values aren't exposed as
  //    enumerable keys.
  if (r.cookies && typeof r.cookies.get === 'function') {
    try {
      const v = r.cookies.get(VISITOR_COOKIE_NAME);
      const s = r.cookies.get(SESSION_COOKIE_NAME);
      if (v || s) {
        return {
          visitorId: typeof v === 'string' ? v : null,
          sessionId: typeof s === 'string' ? s : null,
        };
      }
    } catch {}
  }

  // 2. Pre-parsed cookies map.
  if (r.cookies && typeof r.cookies === 'object') {
    const viaMap = {
      visitorId: typeof r.cookies[VISITOR_COOKIE_NAME] === 'string' ? r.cookies[VISITOR_COOKIE_NAME] : null,
      sessionId: typeof r.cookies[SESSION_COOKIE_NAME] === 'string' ? r.cookies[SESSION_COOKIE_NAME] : null,
    };
    if (viaMap.visitorId || viaMap.sessionId) return viaMap;
  }

  // 3/4. Pull a cookie header string, then parse.
  let cookieHeader: string | null = null;
  const headers = r.headers;
  if (headers) {
    if (typeof headers.get === 'function') {
      // Fetch-style Headers (preferred; may reflect the freshest value)
      try { cookieHeader = headers.get('cookie'); } catch {}
    }
    if (!cookieHeader && typeof headers.cookie === 'string') {
      cookieHeader = headers.cookie;
    }
    if (!cookieHeader && typeof headers.Cookie === 'string') {
      cookieHeader = headers.Cookie;
    }
  }

  // 5. Nuxt 3 / h3 event: cookie lives at event.node.req.headers.cookie.
  //    Lets users pass the event directly without knowing the internal shape.
  if (!cookieHeader && r.node?.req?.headers) {
    const nh = r.node.req.headers;
    if (typeof nh.cookie === 'string') cookieHeader = nh.cookie;
    else if (typeof nh.Cookie === 'string') cookieHeader = nh.Cookie;
  }

  const parsed = parseCookieHeader(cookieHeader);
  return {
    visitorId: parsed[VISITOR_COOKIE_NAME] || null,
    sessionId: parsed[SESSION_COOKIE_NAME] || null,
  };
}

// ── Goal Types ──────────────────────────────────────────────────────

export interface GoalOptions {
  amount?: number;
  /**
   * Session-scoped goal attribution. Required when calling goal APIs
   * directly; the browser SDK pulls sessionId from its own state.
   * Server-side integrations (Stripe webhook, CRM sync, async pipelines)
   * must thread the originating session's sessionId through.
   */
  sessionId?: string;
  metadata?: Record<string, string>;
}

export interface GoalResult {
  success: boolean;
  error?: string;
}

export interface GoalPayloadOptions extends GoalOptions {
  apiKey?: string;
  visitorToken?: string;
}

// ── Goal Validation & Payload ───────────────────────────────────────

export function validateGoalId(goalId: unknown): string | null {
  if (typeof goalId !== 'string' || goalId.trim().length === 0) return 'goalId must be a non-empty string';
  return null;
}

export function validateGoalAmount(amount: unknown): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return 'amount must be a positive finite number';
  }
  return null;
}

export interface GoalPayloadBody {
  goalId: string;
  propertyId: string;
  amount: number;
  apiKey?: string;
  sessionId?: string;
  metadata?: Record<string, string>;
  visitorToken?: string;
}

/**
 * Build the wire shape for a goal {increment,decrement} call. Under the
 * session-as-identity model every goal fire is session-scoped; the
 * payload must carry sessionId, and visitorId is never accepted.
 *
 * Metadata values are PII-screened: any value containing prohibited PII
 * (SSN, credit card, phone, credentials, IPs, addresses, etc.) is dropped
 * from the payload. This mirrors the asymmetry already enforced by
 * `identify()` user-properties: goals are session-scoped and stored long
 * term for revenue attribution, so PII there violates the same boundary.
 * Email is allowed through (it is the canonical stable identifier).
 */
export function buildGoalPayload(
  goalId: string,
  propertyId: string,
  options?: GoalPayloadOptions,
): { body: GoalPayloadBody } {
  let safeMetadata: Record<string, string> | undefined;
  if (options?.metadata) {
    safeMetadata = {};
    for (const [key, value] of Object.entries(options.metadata)) {
      if (typeof value !== 'string') {
        // Permit non-string values to flow through unchecked (containsProhibitedPII
        // only operates on strings); but match the existing wire shape which is
        // string-typed. Coerce-and-screen instead so we don't widen the contract.
        const coerced = String(value);
        if (!containsProhibitedPII(coerced)) safeMetadata[key] = coerced;
        continue;
      }
      if (!containsProhibitedPII(value)) safeMetadata[key] = value;
    }
  }

  return {
    body: {
      goalId,
      propertyId,
      amount: options?.amount ?? 1,
      ...(options?.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(safeMetadata && Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
      ...(options?.visitorToken ? { visitorToken: options.visitorToken } : {}),
    },
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────

/**
 * Default timeout (10s) used when a caller doesn't pass one. Lifted out so
 * the four SDKs that previously declared `FETCH_TIMEOUT_MS` themselves can
 * keep the same default by simply omitting the third argument.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` with an AbortController-driven timeout. Aborts the request after
 * `timeoutMs` (default 10_000) and clears the timer on settle. Mirrors the
 * 5-line helper that previously lived in feedback/flags/goals/split-testing
 * so the four SDKs share one implementation.
 *
 * Caller-supplied `options.signal` is overridden. If you need to combine
 * with another abort signal, do so externally before calling.
 *
 * Return shape: this helper resolves to `Response` directly and rejects
 * (with `name === 'AbortError'` on timeout, otherwise the underlying
 * network error) on failure. Three of the four SDK clients (feedback,
 * goals, split-testing) already used this shape; the Flags client
 * previously had its own `{response, timedOut, error}` variant and was
 * refactored to match this one when consolidating, so all four call
 * sites now share a single contract. Detect timeouts at call sites by
 * checking `error.name === 'AbortError'`.
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── Cross-SDK Registry ──────────────────────────────────────────────
// Module-scoped registry for cross-SDK communication.
// Not bound to window, not accessible from the browser console.

// TODO: tighten typing. The registry stores values of varying shapes
// (flagEvaluationToken strings, etc.) across SDKs. A typed key→shape map
// would require coordinating every consuming SDK, so `unknown` is the
// safest broadening short of that refactor.
const registry = new Map<string, unknown>();

export function setRegistryValue(key: string, value: unknown): void {
  registry.set(key, value);
}

export function getRegistryValue<T = unknown>(key: string): T | undefined {
  return registry.get(key) as T | undefined;
}
