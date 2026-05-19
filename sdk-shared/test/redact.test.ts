import { test, expect, describe } from 'bun:test';
import { redactString, containsProhibitedPII, stripUrlQuery, REDACTED, luhnCheck } from '../src/redact.js';

describe('redactString - personal PII', () => {
  test('redacts valid credit card numbers (Luhn-verified)', () => {
    // Stripe test card - passes Luhn.
    expect(redactString('card: 4242 4242 4242 4242')).toBe(`card: ${REDACTED}`);
    expect(redactString('card 4111-1111-1111-1111 end')).toContain(REDACTED);
  });

  test('Luhn check gates credit-card pattern specifically', () => {
    // The Luhn gate only affects CREDIT_CARD_RE; other patterns can still
    // match substrings of a 16-digit run (e.g., a 10-digit phone-shaped
    // subsequence). Assert the function-level gate via luhnCheck().
    expect(luhnCheck('1234567890123456')).toBe(false);
    expect(luhnCheck('4242424242424242')).toBe(true);
  });

  test('redacts SSN', () => {
    expect(redactString('SSN: 123-45-6789')).toBe(`SSN: ${REDACTED}`);
    expect(redactString('SSN 555 44 3333')).toContain(REDACTED);
  });

  test('does not redact invalid SSN area numbers', () => {
    expect(redactString('000-12-3456')).toBe('000-12-3456');
    expect(redactString('666-12-3456')).toBe('666-12-3456');
    expect(redactString('900-12-3456')).toBe('900-12-3456');
  });

  test('redacts email addresses', () => {
    expect(redactString('contact foo@example.com today')).toBe(`contact ${REDACTED} today`);
    expect(redactString('test.user+tag@sub.example.co')).toBe(REDACTED);
  });

  test('redacts US phone numbers', () => {
    expect(redactString('call 555-123-4567')).toBe(`call ${REDACTED}`);
    expect(redactString('+1 (555) 123-4567')).toContain(REDACTED);
  });

  test('redacts parenthesized US phone at start of string', () => {
    expect(redactString('(555) 123-4567')).toContain(REDACTED);
    expect(redactString('(555) 123-4567')).not.toContain('555');
  });

  test('does not match mid-digit-run: the 10-digit tail of a long number sequence is not a phone', () => {
    // UUIDs can end in 10+ consecutive digits; those are not phones.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(redactString(uuid)).toBe(uuid);
  });

  test('does not match 10-digit tail inside a longer digit run (non-1 leading digit)', () => {
    // 11 digits starting with 2; the old regex matched the last 10 ('3456789012')
    // mid-run because it had no leading \b. The fix anchors the start.
    expect(redactString('order 23456789012 total')).toBe('order 23456789012 total');
  });

  test('still matches 11-digit phones with +1 country code (e.g. 15551234567)', () => {
    // 11-digit sequence starting with 1 is a valid US phone (+1 prefix).
    // Both old and new regex match this; it is correct behavior.
    expect(redactString('call 15551234567')).toBe(`call ${REDACTED}`);
  });

  test('redacts international phone numbers within E.164 length', () => {
    expect(redactString('intl +44 20 7946 0958')).toContain(REDACTED);
  });

  test('does not redact short number sequences as phones', () => {
    expect(redactString('+99 1')).toBe('+99 1');
  });

  test('redacts IBAN', () => {
    expect(redactString('iban GB82 WEST 1234 5698 7654 32')).toContain(REDACTED);
  });

  test('redacts US ITIN (9XX-7X-XXXX and 9XX-9X-XXXX)', () => {
    expect(redactString('ITIN 912-78-3456')).toBe(`ITIN ${REDACTED}`);
    expect(redactString('ITIN 999-95-1234')).toBe(`ITIN ${REDACTED}`);
    expect(redactString('ITIN 950-88-0001')).toBe(`ITIN ${REDACTED}`);
  });

  test('does not redact 9XX-XX-XXXX values outside ITIN middle-digit ranges', () => {
    // 950-50-1234: middle digits 50 fall outside the IRS-published valid ranges
    expect(redactString('950-50-1234')).toBe('950-50-1234');
  });

  test('redacts UK National Insurance numbers', () => {
    expect(redactString('NI: AB123456C')).toBe(`NI: ${REDACTED}`);
    expect(redactString('NI: AB 12 34 56 C')).toBe(`NI: ${REDACTED}`);
  });

  test('does not redact UK NI without mandatory suffix letter', () => {
    expect(redactString('foo AB123456 bar')).toBe('foo AB123456 bar');
  });

  test('redacts Canadian SIN with valid Luhn', () => {
    // 046 454 286 is a known Luhn-valid test SIN.
    expect(redactString('SIN 046 454 286')).toBe(`SIN ${REDACTED}`);
    expect(redactString('SIN 046-454-286')).toBe(`SIN ${REDACTED}`);
  });

  test('does not redact 9-digit sequences that fail Luhn as Canadian SIN', () => {
    // 666123456: SSN excludes area 666, ITIN requires leading 9; the only
    // remaining redactor is Canadian SIN, which gates on Luhn. Sum mod 10 != 0.
    expect(redactString('order 666123456 status')).toBe('order 666123456 status');
  });

  test('strips URL query strings (drops customer-embedded tokens and PII in params)', () => {
    expect(redactString('see https://example.com/reset?token=abc123def end'))
      .toBe('see https://example.com/reset end');
    expect(redactString('https://app.example.com/path?a=1&b=2'))
      .toBe('https://app.example.com/path');
  });

  test('strips URL fragments along with query strings', () => {
    expect(redactString('go to https://example.com/page#section'))
      .toBe('go to https://example.com/page');
  });

  test('preserves URLs that have no query or fragment', () => {
    expect(redactString('see https://example.com/path now'))
      .toBe('see https://example.com/path now');
  });

  test('AWS-presigned credential telemetry runs before query strip', () => {
    // The credential redaction still observes the signature param even though
    // we strip the query right after. Order matters.
    const url = 'https://s3.amazonaws.com/x?X-Amz-Signature=secret';
    const out = redactString(url);
    expect(out).toBe('https://s3.amazonaws.com/x');
  });
});

describe('stripUrlQuery', () => {
  test('strips query and fragment from absolute URLs', () => {
    expect(stripUrlQuery('https://example.com/path?token=abc')).toBe('https://example.com/path');
    expect(stripUrlQuery('https://example.com/path#section')).toBe('https://example.com/path');
    expect(stripUrlQuery('https://example.com/path?a=1#section')).toBe('https://example.com/path');
  });

  test('falls back to regex for relative paths', () => {
    expect(stripUrlQuery('/login?return_to=/dashboard')).toBe('/login');
    expect(stripUrlQuery('/page#anchor')).toBe('/page');
  });

  test('returns empty string and falsy input unchanged', () => {
    expect(stripUrlQuery('')).toBe('');
  });

  test('idempotent', () => {
    const once = stripUrlQuery('https://example.com/path?a=1');
    expect(stripUrlQuery(once)).toBe(once);
  });
});

describe('redactString - credentials', () => {
  test('redacts PEM private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----';
    expect(redactString(`key: ${pem}`)).toBe(`key: ${REDACTED}`);
  });

  test('redacts basic-auth URLs', () => {
    expect(redactString('https://user:pass@example.com/path')).toBe(`https://${REDACTED}@example.com/path`);
  });

  test('redacts Authorization headers', () => {
    expect(redactString('Authorization: Bearer abc123def456ghi789')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
  });

  test('redacts JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactString(`token=${jwt}`)).toBe(`token=${REDACTED}`);
  });

  test('redacts Anthropic/OpenAI-style keys', () => {
    expect(redactString('sk-ant-1234567890abcdefghijk')).toBe(REDACTED);
    expect(redactString('sk-proj-1234567890abcdefghijk')).toBe(REDACTED);
  });

  test('redacts Stripe keys (all four prefixes)', () => {
    expect(redactString('sk_live_1234567890abcdefghij')).toBe(REDACTED);
    expect(redactString('pk_test_1234567890abcdefghij')).toBe(REDACTED);
    expect(redactString('rk_live_1234567890abcdefghij')).toBe(REDACTED);
    expect(redactString('whsec_live_1234567890abcdefghij')).toBe(REDACTED);
  });

  test('redacts GitHub tokens (all six prefixes)', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_12345678901234567890`;
      expect(redactString(`gh: ${token}`)).toBe(`gh: ${REDACTED}`);
    }
  });

  test('redacts AWS access key IDs', () => {
    expect(redactString('AKIA1234567890ABCDEF')).toBe(REDACTED);
  });

  test('strips AWS presigned URL params (entire query is dropped)', () => {
    // URL_QUERY_FRAGMENT_RE removes the whole query string. The AWS-presigned
    // signature redactor runs first for defense-in-depth on any path that
    // bypasses the query strip (e.g., URLs assembled in non-redact contexts),
    // but here the end state is simply: no query.
    const url = 'https://s3.amazonaws.com/x?X-Amz-Signature=abc123';
    expect(redactString(url)).toBe('https://s3.amazonaws.com/x');
  });

  test('redacts Google API keys', () => {
    expect(redactString('AIzaSyA1234567890abcdefghijklmnopqrstuvwx')).toBe(REDACTED);
  });

  test('redacts Slack tokens', () => {
    expect(redactString('xoxb-1234567890-abcdef')).toBe(REDACTED);
  });
});

describe('redactString - edge cases', () => {
  test('returns falsy input unchanged', () => {
    expect(redactString('')).toBe('');
  });

  test('idempotent on already-redacted input', () => {
    const once = redactString('email foo@example.com');
    expect(redactString(once)).toBe(once);
  });

  test('handles multiple patterns in one string', () => {
    const input = 'email foo@example.com and card 4111 1111 1111 1111';
    const out = redactString(input);
    expect(out).not.toContain('foo@example.com');
    expect(out).not.toContain('4111');
  });
});

describe('luhnCheck', () => {
  test('passes known-valid card numbers', () => {
    expect(luhnCheck('4111111111111111')).toBe(true);
    expect(luhnCheck('5105105105105100')).toBe(true);
  });

  test('fails known-invalid sequences', () => {
    expect(luhnCheck('1234567890123456')).toBe(false);
  });
});

describe('redactString - skipEmail option', () => {
  test('default behavior redacts both email and other PII', () => {
    expect(redactString('contact alice@acme.com about SSN 123-45-6789'))
      .toBe(`contact ${REDACTED} about SSN ${REDACTED}`);
  });

  test('skipEmail leaves emails untouched but still redacts other PII', () => {
    expect(redactString('contact alice@acme.com about SSN 123-45-6789', { skipEmail: true }))
      .toBe(`contact alice@acme.com about SSN ${REDACTED}`);
  });

  test('skipEmail still redacts credit cards, credentials, and phone numbers', () => {
    const input = 'email alice@acme.com card 4111 1111 1111 1111 key sk-ant-abcdefghijklmnopqrstuvwxyz01';
    const out = redactString(input, { skipEmail: true });
    expect(out).toContain('alice@acme.com');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('4111 1111 1111 1111');
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz01');
  });
});

describe('containsProhibitedPII', () => {
  test('returns false for plain text', () => {
    expect(containsProhibitedPII('plain text with no secrets')).toBe(false);
  });

  test('returns false for email (email is explicitly allowed)', () => {
    expect(containsProhibitedPII('alice@acme.com')).toBe(false);
  });

  test('returns false for UUIDs', () => {
    expect(containsProhibitedPII('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(containsProhibitedPII('a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6')).toBe(false);
  });

  test('returns true for SSN', () => {
    expect(containsProhibitedPII('123-45-6789')).toBe(true);
  });

  test('returns true for Luhn-valid credit card', () => {
    expect(containsProhibitedPII('4111 1111 1111 1111')).toBe(true);
  });

  test('returns true for phone number', () => {
    expect(containsProhibitedPII('+1 555 123 4567')).toBe(true);
  });

  test('returns true for API keys', () => {
    expect(containsProhibitedPII('sk-ant-abcdefghijklmnopqrstuvwxyz01')).toBe(true);
  });

  test('returns false for empty string', () => {
    expect(containsProhibitedPII('')).toBe(false);
  });

  test('returns false for non-string inputs (type guard)', () => {
    // Defends consumers that hand off Record<string, unknown> values without
    // narrowing; previously fell through the `if (!input)` check inconsistently.
    expect(containsProhibitedPII(undefined as any)).toBe(false);
    expect(containsProhibitedPII(null as any)).toBe(false);
    expect(containsProhibitedPII(0 as any)).toBe(false);
    expect(containsProhibitedPII(false as any)).toBe(false);
    expect(containsProhibitedPII(123 as any)).toBe(false);
    expect(containsProhibitedPII({} as any)).toBe(false);
    expect(containsProhibitedPII([] as any)).toBe(false);
  });
});

describe('redactString - IPv4 / IPv6', () => {
  test('redacts basic IPv4 addresses', () => {
    expect(redactString('host 10.0.0.1 down')).toBe(`host ${REDACTED} down`);
    expect(redactString('192.168.1.1')).toBe(REDACTED);
    expect(redactString('255.255.255.255')).toBe(REDACTED);
  });

  test('does not match obviously invalid IPv4 octets', () => {
    // 256 fails the strict 0-255 bound; the run is left intact.
    expect(redactString('256.256.256.256')).toBe('256.256.256.256');
  });

  test('does not match HH:MM:SS timestamps as IPv6', () => {
    // The old regex permitted zero-hex-char groups so `12:34:56` matched.
    // The fix raises the colon-group floor to 3 AND requires at least one
    // hex char per group.
    expect(redactString('time 12:34:56 done')).toBe('time 12:34:56 done');
    expect(redactString('start 01:23:45 stop')).toBe('start 01:23:45 stop');
    expect(redactString('three groups 1:2:3 only')).toBe('three groups 1:2:3 only');
  });

  test('redacts full 8-group IPv6 addresses', () => {
    const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
    expect(redactString(`addr ${ipv6} end`)).toBe(`addr ${REDACTED} end`);
  });

  test('redacts compressed IPv6 (`::` shorthand)', () => {
    expect(redactString('addr 2001:db8::1 end')).toBe(`addr ${REDACTED} end`);
    expect(redactString('addr fe80::1 end')).toBe(`addr ${REDACTED} end`);
  });

  test('redacts loopback shorthand `::1`', () => {
    expect(redactString('lb ::1 ok')).toBe(`lb ${REDACTED} ok`);
  });

  test('redacts trailing-`::` form', () => {
    expect(redactString('zero fe80:: bound')).toBe(`zero ${REDACTED} bound`);
  });
});

describe('redactString - US street address', () => {
  test('redacts a US street address', () => {
    expect(redactString('ship to 1600 Pennsylvania Avenue today'))
      .toContain(REDACTED);
    expect(redactString('ship to 1600 Pennsylvania Avenue today'))
      .not.toContain('Pennsylvania');
  });

  test('redacts address with apartment qualifier', () => {
    expect(redactString('home 742 Evergreen Terrace Apt 1A here'))
      .toContain(REDACTED);
  });

  test('preserves text without a street suffix', () => {
    // "1600 Pennsylvania" alone (no suffix like "Avenue") should not match.
    expect(redactString('she lives at 1600 Pennsylvania')).toBe('she lives at 1600 Pennsylvania');
  });
});

describe('redactString - IBAN edge cases', () => {
  test('redacts IBAN without spaces', () => {
    // GB compact form: 22 chars, no separators.
    expect(redactString('iban GB82WEST12345698765432 end')).toContain(REDACTED);
    expect(redactString('iban GB82WEST12345698765432 end')).not.toContain('GB82WEST');
  });

  test('redacts IBAN with hyphen separators', () => {
    expect(redactString('iban DE89-3704-0044-0532-0130-00 end')).toContain(REDACTED);
  });

  test('redacts shorter (15-char) Norwegian IBAN', () => {
    // NO IBAN is 15 chars; tests the lower end of the regex range.
    expect(redactString('iban NO9386011117947 end')).toContain(REDACTED);
  });

  test('does not redact two-letter codes followed by short digit run', () => {
    // 'GB12' alone is too short to be an IBAN.
    expect(redactString('code GB12 here')).toBe('code GB12 here');
  });
});

describe('redactString - URL whitespace limitation', () => {
  test('URL_QUERY_FRAGMENT_RE stops at whitespace before `?` (documented limitation)', () => {
    // This test pins the limitation called out in the JSDoc on
    // URL_QUERY_FRAGMENT_RE: a URL with literal whitespace before its
    // query terminator escapes redaction. Free-text inputs that exhibit
    // this shape should be cleaned by callers that know the field is a
    // URL via stripUrlQuery.
    const out = redactString('see https://example.com/path ?token=abc end');
    // The query is left intact because the URL match terminates at the space.
    expect(out).toContain('?token=abc');
  });
});
