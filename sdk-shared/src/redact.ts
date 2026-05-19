/**
 * Shared redaction patterns for SessionSight.
 *
 * Two rings of patterns, run in one pass via redactString:
 *
 * 1. Credentials  - things that leak through code (bearer tokens, PEM
 *    private keys, provider API keys, JWTs, AWS presigned URL params).
 * 2. Personal PII - things users type into pages (credit cards with Luhn
 *    validation, SSNs with area-number exclusions, emails, phone numbers
 *    with E.164 length checks, IBANs).
 *
 * This module has zero runtime dependencies so it is safe to import from
 * the browser SDK bundle. The backend imports the same function through
 * packages/shared/redact.ts, which re-exports redactString and layers its
 * own tree-walker (redactDeep) and pino-backed path redactor (redactPaths)
 * on top.
 */

export const REDACTED = '[REDACTED]';

// ── Luhn ───────────────────────────────────────────────────────────

export function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ── Credentials patterns ───────────────────────────────────────────

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BASIC_AUTH_URL_RE = /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi;
const AUTH_HEADER_RE = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._\-+/=]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_\-]{20,}/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_\-]{20,}/g;
const STRIPE_KEY_RE = /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{16,}/g;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
const SLACK_TOKEN_RE = /\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const AWS_PRESIGNED_RE = /(X-Amz-(?:Signature|Credential|Security-Token|Algorithm|Date|Expires|SignedHeaders))=([^&\s"']+)/gi;
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_\-]{35,}/g;

// ── Personal PII patterns ──────────────────────────────────────────

// IBAN: 2-letter country + 2 check digits + up to 30 alphanumeric.
// Run BEFORE credit-card because an IBAN's digit span can pass Luhn.
const IBAN_RE = /\b[A-Z]{2}\d{2}[\s\-]?[\dA-Z]{4}[\s\-]?(?:[\dA-Z]{4}[\s\-]?){1,7}[\dA-Z]{1,4}\b/g;

// Credit card: 13-19 digit sequences with optional spaces/dashes, Luhn-validated.
const CREDIT_CARD_RE = /\b(\d[\d\s\-]{11,22}\d)\b/g;

// SSN: 3-2-4 digit pattern. Area number cannot be 000, 666, or 900-999.
const SSN_RE = /\b(?!000|666|9\d\d)(\d{3})[- ]?(?!00)(\d{2})[- ]?(?!0000)(\d{4})\b/g;

// US Individual Taxpayer Identification Number (ITIN). Starts with 9 (which
// SSN_RE excludes), middle digits restricted to IRS-published ranges. Issued
// to non-resident taxpayers and dependents; same sensitivity as SSN.
const US_ITIN_RE = /\b9\d{2}[- ]?(?:7\d|8[0-8]|9[0-2]|9[4-9])[- ]?\d{4}\b/g;

// UK National Insurance number. Two letters (excluding reserved prefixes
// D/F/I/Q/U/V; second letter also excludes O), six digits, mandatory A-D
// suffix. The mandatory suffix prevents generic 8-character alphanumerics
// from collapsing into false positives.
const UK_NI_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g;

// Canadian Social Insurance Number. Nine digits in 3-3-3 grouping. Luhn-
// validated below, identical to credit-card gating, to avoid eating any
// nine-digit run that happens to use that grouping.
const CANADIAN_SIN_RE = /\b(\d{3})[- ]?(\d{3})[- ]?(\d{3})\b/g;

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

// US 10-digit phone with optional +1. Leading \b prevents mid-run matches
// like the tail of a UUID (e.g. `...6655440000` at the end of
// `550e8400-e29b-41d4-a716-446655440000`) from being read as a phone number.
// The leading \b still permits parenthesized formats: the engine skips the
// optional `\(?` and starts matching at the first digit, which sits at a
// word boundary relative to the preceding `(`.
const PHONE_US_RE = /\b(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;

// International: +country code followed by 7-14 digits with optional separators.
const PHONE_INTL_RE = /\+\d{1,3}[\s.\-]\d[\d\s.\-]{6,16}\d\b/g;

// IPv4: four octets each strictly 0-255. Strict bounds reject most generic
// "1.2.3.4" version strings, but anything that happens to look like a real
// IP (e.g. "10.0.0.1" used as a software version) will still match.
// Customers with such displays can opt out with data-ss-unmask.
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g;

// IPv6: tightened to require at least one hex char per group and a minimum
// colon-group count of 3 so HH:MM:SS / H:MM:SS timestamps cannot match.
// Two alternatives: full form (4+ groups, 3+ colons) and `::` shorthand
// forms (e.g. `::1`, `2001:db8::1`, `fe80::`). The leading group captures
// the preceding boundary character so it can be re-emitted in the
// replacement; we avoid lookbehind because Safari < 16.4 throws a
// SyntaxError on the regex literal.
const IPV6_RE = /(^|[^\w:])((?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){3,7})|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4})*::(?:[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{1,4})*)?)|(?:::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?))(?=[^\w:]|$)/g;

// US street address (best-effort). Matches "<number> <street name> <suffix>"
// with an optional unit qualifier. International formats vary too widely to
// regex reliably, so non-US addresses are not covered. Customers should
// wrap address fields in data-ss-mask if they need stronger guarantees.
//
// Suffixes are the USPS standard list. The leading capture group preserves
// the boundary character (start-of-string or any non-alphanumeric) for
// re-emission, again to avoid lookbehind for Safari < 16.4 compatibility.
const US_STREET_ADDRESS_RE = /(^|[^A-Za-z0-9])(\d{1,5}\s+(?:[A-Z][a-zA-Z'.\-]+\s+){1,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Terrace|Ter|Circle|Cir|Square|Sq|Trail|Trl|Loop|Run|Crossing|Xing)\b\.?(?:\s*(?:Apt|Apartment|Suite|Ste|Unit|#)\s*[A-Za-z0-9-]+\b\.?)?)/g;

// Drop the entire query and fragment portion of any absolute URL. Customer
// pages put session tokens, reset codes, and PII into query params; we treat
// anything after `?` or `#` as toxic and strip it. Path portion (which is
// usually the meaningful navigation signal) is preserved.
//
// Limitation: a URL that contains literal whitespace before its `?` will
// stop matching at the whitespace and leave the trailing query exposed, e.g.
// `https://example.com/page ?token=abc`. The space terminates the URL
// match, so the query string remains in the output. Real URLs never contain
// unencoded whitespace, but free-text inputs (paste-buffer, user-typed
// "see this URL ?token=...") can produce this shape. Callers handling
// known-URL fields should prefer `stripUrlQuery` on the field directly.
const URL_QUERY_FRAGMENT_RE = /(\bhttps?:\/\/[^\s"'<>?#)]+)[?#][^\s"'<>)]*/gi;

// ── redactString ───────────────────────────────────────────────────

export interface RedactOptions {
  /**
   * Skip the email pattern. Used by the Insights SDK's identify() path,
   * where email is the canonical stable identifier and must pass through
   * while all other PII (SSN, credit card, credentials, phone) is still
   * detected.
   */
  skipEmail?: boolean;
}

/**
 * Scrub inline secrets and personal PII from an arbitrary string. Idempotent.
 * Returns input unchanged if it is falsy.
 */
export function redactString(input: string, options?: RedactOptions): string {
  if (!input) return input;
  let out = input;

  // Credentials: order matters for nothing here, but keeps pattern families
  // grouped for readability.
  out = out.replace(PEM_PRIVATE_KEY_RE, REDACTED);
  out = out.replace(BASIC_AUTH_URL_RE, `$1${REDACTED}@`);
  out = out.replace(AUTH_HEADER_RE, `$1 ${REDACTED}`);
  out = out.replace(JWT_RE, REDACTED);
  out = out.replace(ANTHROPIC_KEY_RE, REDACTED);
  out = out.replace(OPENAI_KEY_RE, REDACTED);
  out = out.replace(STRIPE_KEY_RE, REDACTED);
  out = out.replace(GITHUB_TOKEN_RE, REDACTED);
  out = out.replace(SLACK_TOKEN_RE, REDACTED);
  out = out.replace(AWS_ACCESS_KEY_RE, REDACTED);
  out = out.replace(AWS_PRESIGNED_RE, `$1=${REDACTED}`);
  out = out.replace(GOOGLE_API_KEY_RE, REDACTED);

  // Personal PII: IBAN first (see comment above), then credit card with
  // Luhn, then the rest.
  out = out.replace(IBAN_RE, REDACTED);
  out = out.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/[\s\-]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      return REDACTED;
    }
    return match;
  });
  out = out.replace(SSN_RE, REDACTED);
  out = out.replace(US_ITIN_RE, REDACTED);
  out = out.replace(UK_NI_RE, REDACTED);
  out = out.replace(CANADIAN_SIN_RE, (match) => {
    const digits = match.replace(/[\s\-]/g, '');
    if (digits.length === 9 && luhnCheck(digits)) {
      return REDACTED;
    }
    return match;
  });
  if (!options?.skipEmail) {
    out = out.replace(EMAIL_RE, REDACTED);
  }
  out = out.replace(PHONE_US_RE, REDACTED);
  out = out.replace(PHONE_INTL_RE, (match) => {
    const digits = match.replace(/\D/g, '');
    // Must have 8-15 digits total (E.164 range) to avoid matching arbitrary
    // number sequences.
    if (digits.length >= 8 && digits.length <= 15) return REDACTED;
    return match;
  });

  // Network identifiers. IPv6 first because IPv4-mapped addresses
  // (::ffff:1.2.3.4) embed an IPv4 tail; matching the IPv6 form first lets
  // the leftover IPv4 piece be cleaned up by IPV4_RE on the next pass.
  // IPv6 and street-address regexes capture the preceding boundary character
  // in $1 so we can re-emit it (instead of using lookbehind, which Safari
  // < 16.4 cannot parse).
  out = out.replace(IPV6_RE, `$1${REDACTED}`);
  out = out.replace(IPV4_RE, REDACTED);

  // Best-effort US street address detection. Run after PII patterns so any
  // numbers inside an address that look like phones/cards/etc. are caught
  // by their stricter detectors first.
  out = out.replace(US_STREET_ADDRESS_RE, `$1${REDACTED}`);

  // Strip query strings last so any URL-shaped credentials above (basic-auth
  // user:pass@, AWS-presigned signature params) get a chance to redact their
  // own fields first. This way a URL like https://x:y@s3.amazonaws.com/?X-Amz-Signature=z
  // becomes https://[REDACTED]@s3.amazonaws.com/ rather than losing the
  // credential telemetry that downstream auditing relies on.
  out = out.replace(URL_QUERY_FRAGMENT_RE, '$1');

  return out;
}

/**
 * Strip the query string and fragment from a single URL (or URL-shaped
 * string). Tries the WHATWG URL parser first for accuracy, falls back to
 * regex for relative paths and malformed inputs. Idempotent.
 *
 * Use this for fields that are KNOWN to be a single URL (page metadata,
 * referrer, navigation events). For free-text content that may contain
 * embedded URLs, use redactString; its URL_QUERY_FRAGMENT_RE handles
 * substring matches without choking on surrounding text.
 *
 * Note: this function does NOT validate that the input looks URL-shaped.
 * The regex fallback runs on any input, stripping everything after the
 * first `?` or `#` and truncating to URL_MAX_LENGTH (2048). For non-URL
 * inputs the result is meaningless but predictable. Callers that need
 * URL-only behavior should pre-validate (e.g. `new URL(input)` in a try).
 */
// Hard ceiling for any URL-shaped string flowing through stripUrlQuery.
// Sized for RFC-realistic URLs while staying well under MongoDB doc limits;
// this is the single chokepoint that bounds pageview pathnames, hrefs,
// referrers, error filenames, and metadata URLs across the SDK and ingest.
export const URL_MAX_LENGTH = 2048;

export function stripUrlQuery(input: string): string {
  if (!input) return input;
  let stripped: string;
  try {
    const u = new URL(input);
    stripped = u.origin + u.pathname;
  } catch {
    stripped = input.replace(/[?#].*$/, '');
  }
  return stripped.length > URL_MAX_LENGTH ? stripped.slice(0, URL_MAX_LENGTH) : stripped;
}

/**
 * Returns true if the input contains any prohibited-PII pattern: everything
 * redactString catches except email. Email is explicitly allowed because it
 * is the canonical stable identifier integrators reach for.
 *
 * Implementation leans on redactString's substitute-on-match behavior: if
 * nothing matched, the output equals the input. Single source of truth for
 * the pattern list and ordering.
 */
export function containsProhibitedPII(input: string): boolean {
  if (typeof input !== 'string') return false;
  if (!input) return false;
  return redactString(input, { skipEmail: true }) !== input;
}

// ── Media stripping primitives ─────────────────────────────────────
//
// Used by both the SDK (client-side rrweb emit walker) and the API
// (server-side ingest-buffer scrubber) to strip image/video/audio
// references from rrweb event payloads.

/** Marker the SDK writes onto stripped elements so the replayer can render a stand-in. */
export const SS_BLOCKED_ATTR = 'data-ss-blocked';

/** Customer opt-in attribute. Presence on the element or any ancestor keeps the URL form. */
export const SS_ALLOW_ATTR = 'data-ss-allow';

/**
 * SessionSight-controlled placeholder image used when stripping a media
 * `src`/`href`/`poster`. A small inline SVG that paints a low-contrast
 * diagonal-hatch pattern when stretched to the host element's box.
 *
 * Why a hatched SVG instead of a transparent gif: SVG `<image>` elements
 * (and any host that ignores the replayer's HTML-CSS background overlay)
 * render the shim itself as the visible placeholder. A transparent shim
 * is invisible there, leaving an empty box. The hatch makes the
 * stand-in visible across all renderers in one shot.
 *
 * Both client and server scrubbers recognize this exact value and leave
 * it untouched (see `isEmbeddedMediaUrl`; it returns false for this one
 * specific data URI even though the value technically starts with `data:`).
 */
export const SS_MEDIA_SHIM =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='xMidYMid slice' viewBox='0 0 100 100'><defs><pattern id='h' patternUnits='userSpaceOnUse' width='8' height='8' patternTransform='rotate(45)'><line x1='0' y1='0' x2='0' y2='8' stroke='%23787888' stroke-width='2' opacity='0.30'/></pattern></defs><rect width='100%25' height='100%25' fill='url(%23h)'/></svg>";

/**
 * CSS properties whose value may carry `url(...)` references that need to
 * be stripped. Includes longhand and shorthand forms; the regex strip is
 * applied to the value of each occurrence in inline `style` attributes,
 * captured stylesheet text, and runtime style mutations.
 *
 * `cursor` is included because CSS allows `cursor: url(...) auto` and the
 * URL portion can leak the same as a background image. After the strip the
 * remaining keyword fallback (`auto`, `pointer`) covers the cursor.
 */
export const URL_BEARING_CSS_PROPERTIES = [
  'background',
  'background-image',
  'mask-image',
  'border-image',
  'list-style-image',
  'cursor',
] as const;

/**
 * Match a CSS `url(...)` token. Handles unquoted, single-quoted, and
 * double-quoted forms with arbitrary inner content (including `data:` and
 * `blob:` URIs). The non-greedy inner match prevents two adjacent `url(...)`
 * references on the same declaration from being eaten as one match.
 *
 * Lazy-construct a fresh RegExp per call site that needs `.test()` or
 * `.exec()` semantics so the `g` flag's `lastIndex` doesn't leak between
 * callers; for `.replace()` callers, share the constant.
 */
export const URL_FUNC_RE = /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*?)\s*\)/gi;

/**
 * Match an `@font-face { ... }` block (greedy through nested-brace-free
 * content). Used by stripStylesheetUrls to skip url() inside font-face
 * declarations so customer typography keeps rendering.
 *
 * Stylesheet text rarely contains `@font-face` blocks with nested braces, so
 * this single-level match is sufficient for the captured-stylesheet-text
 * shape rrweb emits.
 */
const FONT_FACE_BLOCK_RE = /@font-face\s*\{[^}]*\}/gi;

/**
 * The "stand-in" gradient string we substitute in place of `url(...)` so
 * the stripped declaration still paints a visible diagonal-hatch pattern.
 * Using a gradient (rather than `none`) means stylesheet-text strips
 * (which can't be tied to a specific element's `data-ss-blocked` marker)
 * still produce a visible placeholder on their own.
 *
 * Compatible with `background`, `background-image`, `mask-image`,
 * `border-image`. For `cursor` and `list-style-image` (which only accept
 * url() / none), the engine treats this gradient as invalid and skips
 * the declaration, falling back to whatever else is in scope.
 *
 * Visually matches the replayer's foreground stand-in CSS so the page
 * looks consistent across both kinds of strip.
 */
export const SS_HATCH_GRADIENT =
  'repeating-linear-gradient(45deg, rgba(120,120,130,0.10), rgba(120,120,130,0.10) 1px, transparent 1px, transparent 8px)';

/**
 * Strip `url(...)` references from a stylesheet text body, preserving
 * `@font-face { src: url(...) }` declarations so customer typography
 * still renders on replay.
 *
 * Replacement strategy: replace each `url(...)` token with a CSS
 * `repeating-linear-gradient(...)` (see SS_HATCH_GRADIENT) so the
 * resulting declaration paints the same low-contrast hatch pattern the
 * replayer uses for foreground media stand-ins. This is what lets a
 * stripped `<style>body { background: url(x) }</style>` rule render a
 * visible "media hidden" pattern at replay time without needing to track
 * which elements matched the rule.
 *
 * Returns the stripped string. Sets the optional out-param `stripped` to
 * true if any replacement occurred.
 */
export function stripStylesheetUrls(
  cssText: string,
  out?: { stripped: boolean },
): string {
  if (typeof cssText !== 'string' || cssText.length === 0) return cssText;

  // Carve out @font-face blocks first so font url()s survive. Replace each
  // block with a placeholder, run the strip, then put them back.
  const blocks: string[] = [];
  const placeholdered = cssText.replace(FONT_FACE_BLOCK_RE, (match) => {
    blocks.push(match);
    return `__FF__${blocks.length - 1}__FF__`;
  });

  let didStrip = false;
  const stripped = placeholdered.replace(URL_FUNC_RE, () => {
    didStrip = true;
    return SS_HATCH_GRADIENT;
  });

  if (out) out.stripped = out.stripped || didStrip;

  if (blocks.length === 0) return stripped;

  return stripped.replace(/__FF__(\d+)__FF__/g, (_m, idx) => blocks[Number(idx)] ?? '');
}

/**
 * Strip `url(...)` references from an inline-style attribute value. Only
 * touches declarations whose property is in URL_BEARING_CSS_PROPERTIES;
 * other declarations (color, padding, etc.) pass through untouched.
 *
 * Returns the stripped value. Sets the optional out-param `stripped` to
 * true if any url() was removed.
 */
export function stripInlineStyleUrls(
  styleValue: string,
  out?: { stripped: boolean },
): string {
  if (typeof styleValue !== 'string' || styleValue.length === 0) return styleValue;

  // Walk the style string declaration-by-declaration. We can't naively
  // split on `;` because a `data:image/png;base64,...` URI inside a
  // `url(...)` value contains semicolons that would shred the parse.
  // Track parenthesis depth so semicolons inside `url(...)` (or any other
  // function) don't prematurely terminate a declaration.
  const parts = splitDeclarationsRespectingParens(styleValue);
  let didStrip = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (!URL_BEARING_CSS_PROPERTIES.includes(prop as any)) continue;
    const value = part.slice(colon + 1);
    let stripped = false;
    const newValue = value.replace(URL_FUNC_RE, () => {
      stripped = true;
      return SS_HATCH_GRADIENT;
    });
    if (stripped) {
      didStrip = true;
      parts[i] = `${part.slice(0, colon + 1)}${newValue}`;
    }
  }

  if (out) out.stripped = out.stripped || didStrip;
  return didStrip ? parts.join(';') : styleValue;
}

/**
 * Split an inline-style string on top-level `;` boundaries only.
 * Semicolons inside parentheses (e.g. inside `url(data:image/png;base64,...)`)
 * are kept intact so the per-declaration parser doesn't see broken url()
 * values.
 */
function splitDeclarationsRespectingParens(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
    else if (ch === ';' && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

/**
 * Returns true if a media URL string is an embedded-bytes form (data: or
 * blob:). The opt-in attribute does NOT honor these; embedded bytes have
 * to be persisted on our servers, which is a different liability class
 * than referencing a URL the replayer fetches at replay time.
 */
export function isEmbeddedMediaUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  // The SS_MEDIA_SHIM constant is our own controlled byte sequence, never
  // customer-supplied. Skip the data: check for it so the strip pipeline
  // doesn't repeatedly strip and replace its own placeholder.
  if (url === SS_MEDIA_SHIM) return false;
  const trimmed = url.trimStart().toLowerCase();
  return trimmed.startsWith('data:') || trimmed.startsWith('blob:');
}

/**
 * Parse a `srcset` value into its `(url, descriptor)` entries.
 *
 * Splitting naively on commas is wrong because URLs in srcset can
 * contain unescaped commas, most commonly inside `data:` URIs
 * (`data:image/png;base64,...`). The spec-correct shape is "URL
 * whitespace DESCRIPTOR comma URL whitespace DESCRIPTOR ...", where
 * descriptor is `Nx` or `Nw`. We anchor on the descriptor pattern to
 * find entry boundaries instead of splitting on `,`.
 *
 * A trailing URL without a descriptor (valid; defaults to `1x`) is
 * captured as `{ url, descriptor: '' }`.
 */
export function parseSrcset(srcset: string): Array<{ url: string; descriptor: string }> {
  if (typeof srcset !== 'string' || srcset.length === 0) return [];
  // Match: required whitespace, descriptor (digits with optional fraction +
  // 'w'|'x'), optional whitespace, then either `,` or end-of-string.
  const ENTRY_END_RE = /\s+(\d+(?:\.\d+)?[wx])\s*(?:,|$)/g;
  const out: Array<{ url: string; descriptor: string }> = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY_END_RE.exec(srcset)) !== null) {
    const url = srcset.slice(lastIdx, m.index).replace(/^[\s,]+/, '').replace(/\s+$/, '');
    if (url.length > 0) out.push({ url, descriptor: m[1]! });
    lastIdx = m.index + m[0].length;
  }
  const trailing = srcset.slice(lastIdx).replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
  if (trailing.length > 0) out.push({ url: trailing, descriptor: '' });
  return out;
}

/**
 * Filter a `srcset` attribute value to remove embedded-bytes entries.
 * Returns the rebuilt srcset string, or empty string if no entries
 * survive.
 *
 * Used in the opt-in path: even when an element has `data-ss-allow`,
 * any `data:` or `blob:` entries in its `srcset` are stripped because
 * those would persist embedded bytes server-side.
 */
export function filterSrcsetForEmbeddedUrls(srcset: string): string {
  if (typeof srcset !== 'string' || srcset.length === 0) return srcset;
  const entries = parseSrcset(srcset);
  const kept = entries.filter((e) => !isEmbeddedMediaUrl(e.url));
  return kept.map((e) => (e.descriptor ? `${e.url} ${e.descriptor}` : e.url)).join(', ');
}
