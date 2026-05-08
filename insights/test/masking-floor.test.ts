import { test, expect, describe } from 'bun:test';
import { applyMasking, isPasswordElement, maskEventPlaceholders, rotateScrambleCipher } from '../src/recorder.js';

// Minimal HTMLElement stub. The masking helpers only use:
//   tagName, type (for inputs), hasAttribute(), closest()
// — so we shim those instead of pulling in a full DOM library.
function el(opts: {
  tagName?: string;
  type?: string;
  attrs?: Record<string, string>;
  closest?: (selector: string) => any;
}): any {
  const attrs = opts.attrs ?? {};
  return {
    tagName: opts.tagName ?? 'DIV',
    type: opts.type,
    hasAttribute: (n: string) => n in attrs,
    closest: opts.closest ?? (() => null),
  };
}

describe('isPasswordElement', () => {
  test('returns true for <input type="password">', () => {
    expect(isPasswordElement(el({ tagName: 'INPUT', type: 'password' }))).toBe(true);
  });

  test('returns true for elements with rrweb data-rr-is-password marker', () => {
    expect(
      isPasswordElement(
        el({ tagName: 'INPUT', type: 'text', attrs: { 'data-rr-is-password': 'true' } }),
      ),
    ).toBe(true);
  });

  test('returns false for plain text inputs', () => {
    expect(isPasswordElement(el({ tagName: 'INPUT', type: 'text' }))).toBe(false);
  });

  test('returns false for non-input elements even if their type is "password"', () => {
    // Defensive: a <div type="password"> shouldn't trip the marker.
    expect(isPasswordElement(el({ tagName: 'DIV', type: 'password' }))).toBe(false);
  });

  test('returns false for null', () => {
    expect(isPasswordElement(null)).toBe(false);
  });
});

describe('applyMasking - password floor', () => {
  test('redacts password values regardless of privacyMode', () => {
    const password = el({ tagName: 'INPUT', type: 'password' });
    expect(applyMasking('hunter2', password, 'default')).toBe('[REDACTED]');
    expect(applyMasking('hunter2', password, 'relaxed')).toBe('[REDACTED]');
  });

  test('redacts password values even when wrapped in a data-ss-unmask ancestor', () => {
    // Simulate: <form data-ss-unmask><input type="password"></form>
    const ancestor = { hasAttribute: (n: string) => n === 'data-ss-unmask' };
    const password = el({
      tagName: 'INPUT',
      type: 'password',
      closest: (sel: string) => (sel.includes('data-ss-') ? ancestor : null),
    });
    expect(applyMasking('MyDog$Birthday!2019', password, 'relaxed')).toBe('[REDACTED]');
  });

  test('rrweb data-rr-is-password marker also enforces the floor', () => {
    const password = el({
      tagName: 'INPUT',
      type: 'text',
      attrs: { 'data-rr-is-password': 'true' },
    });
    expect(applyMasking('correct horse battery staple', password, 'relaxed')).toBe('[REDACTED]');
  });

  test('original password length is not leaked by the redaction output', () => {
    const password = el({ tagName: 'INPUT', type: 'password' });
    const short = applyMasking('aZ9!', password, 'default');
    const long = applyMasking('aZ9!bC2#dE3xY7%pQ4&rT8@nM5', password, 'default');
    // Both produce the same fixed [REDACTED] token, so password length cannot be inferred from the captured value.
    expect(short).toBe('[REDACTED]');
    expect(long).toBe('[REDACTED]');
  });
});

describe('applyMasking - scramble cipher properties', () => {
  test('preserves length, whitespace, and punctuation in default privacy mode', () => {
    // Plain element (not a password). Default privacy mode triggers scramble
    // after the redactString PII pass. Use text with no PII patterns.
    const elem = el({ tagName: 'P' });
    const input = 'The quick brown fox jumps over 42 lazy dogs.';
    const out = applyMasking(input, elem, 'default');
    expect(out).not.toBe(input);
    expect(out.length).toBe(input.length);
    // Whitespace and punctuation positions untouched
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (/[\s.,!?]/.test(ch)) expect(out[i]).toBe(ch);
    }
  });

  test('preserves [REDACTED] tokens through the scramble', () => {
    const elem = el({ tagName: 'P' });
    // The redact step turns the email into [REDACTED] before scramble runs;
    // scramble must keep the marker intact so the replay UI can show it.
    const out = applyMasking('Contact john@acme.com today', elem, 'default');
    expect(out).toContain('[REDACTED]');
  });

  test('rotateScrambleCipher changes the scramble for the same input', () => {
    const elem = el({ tagName: 'P' });
    // Long input so the chance of two random derangements producing the
    // same scramble is astronomically small.
    const input = 'Welcome back to the SessionSight dashboard, friend';
    const before = applyMasking(input, elem, 'default');
    rotateScrambleCipher();
    const after = applyMasking(input, elem, 'default');
    expect(after).not.toBe(before);
    // Both still preserve length and the same non-letter/digit positions
    expect(after.length).toBe(input.length);
  });

  test('relaxed mode never scrambles, only redacts PII', () => {
    const elem = el({ tagName: 'P' });
    // No PII in input, so relaxed mode should pass through unchanged.
    const input = 'Welcome back to the dashboard';
    expect(applyMasking(input, elem, 'relaxed')).toBe(input);
  });
});

describe('maskEventPlaceholders - URL stripping', () => {
  test('strips query and fragment from rrweb Meta event hrefs', () => {
    const event: any = {
      type: 4, // META_EVENT_TYPE
      data: { href: 'https://example.com/reset?token=abc123#section' },
      timestamp: 1,
    };
    maskEventPlaceholders(event, 'default');
    expect(event.data.href).toBe('https://example.com/reset');
  });

  test('strips href and action from FullSnapshot DOM tree', () => {
    const event: any = {
      type: 2, // FULL_SNAPSHOT_EVENT_TYPE
      data: {
        node: {
          type: 0,
          childNodes: [
            { type: 2, tagName: 'a', attributes: { href: '/login?return_to=/dashboard&token=xyz' } },
            { type: 2, tagName: 'form', attributes: { action: '/submit?key=secret' } },
          ],
        },
      },
      timestamp: 1,
    };
    maskEventPlaceholders(event, 'default');
    const [a, form] = event.data.node.childNodes;
    expect(a.attributes.href).toBe('/login');
    expect(form.attributes.action).toBe('/submit');
  });

  test('strips href/action on attribute mutations in IncrementalSnapshot', () => {
    const event: any = {
      type: 3, // INCREMENTAL_SNAPSHOT_EVENT_TYPE
      data: {
        source: 0, // MUTATION_SOURCE
        attributes: [
          { id: 1, attributes: { href: 'https://acme.com/auth?session=abc' } },
          { id: 2, attributes: { action: '/api/transfer?amount=100&to=bob' } },
        ],
      },
      timestamp: 1,
    };
    maskEventPlaceholders(event, 'default');
    expect(event.data.attributes[0].attributes.href).toBe('https://acme.com/auth');
    expect(event.data.attributes[1].attributes.action).toBe('/api/transfer');
  });

  test('preserves src attributes (replay needs them to render assets)', () => {
    const event: any = {
      type: 2,
      data: {
        node: {
          type: 0,
          childNodes: [
            { type: 2, tagName: 'img', attributes: { src: 'https://cdn.example.com/img.png?v=42' } },
          ],
        },
      },
      timestamp: 1,
    };
    maskEventPlaceholders(event, 'default');
    expect(event.data.node.childNodes[0].attributes.src).toBe(
      'https://cdn.example.com/img.png?v=42',
    );
  });
});
