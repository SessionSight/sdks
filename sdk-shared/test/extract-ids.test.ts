import { test, expect, describe } from 'bun:test';
import { extractIdsFromRequest } from '../src/index.js';

/**
 * `extractIdsFromRequest` is the framework-agnostic bridge between an inbound
 * HTTP request and the `ss_vid` / `ss_sid` cookies the insights SDK writes on
 * the client. It duck-types across Node-style, Fetch-style, pre-parsed, and
 * raw-string request shapes so the server SDKs can auto-populate visitor and
 * session ids without knowing the host's framework.
 */

describe('extractIdsFromRequest', () => {
  test('pulls ids from pre-parsed cookies map (Express + cookie-parser, Next.js)', () => {
    const req = { cookies: { ss_vid: 'v1', ss_sid: 's1', other: 'x' } };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'v1', sessionId: 's1' });
  });

  test('falls through to headers when cookies map is empty', () => {
    const req = {
      cookies: {},
      headers: { cookie: 'ss_vid=vh; ss_sid=sh' },
    };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'vh', sessionId: 'sh' });
  });

  test('reads Node-style req.headers.cookie string', () => {
    const req = { headers: { cookie: 'foo=bar; ss_vid=abc; ss_sid=xyz' } };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'abc', sessionId: 'xyz' });
  });

  test('reads Fetch-style Headers via .get(name)', () => {
    const req = {
      headers: {
        get: (name: string) => (name === 'cookie' ? 'ss_vid=fetch-v; ss_sid=fetch-s' : null),
      },
    };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'fetch-v', sessionId: 'fetch-s' });
  });

  test('prefers Fetch-style headers.get when both get() and .cookie string exist', () => {
    // Some frameworks (e.g., Next.js App Router) expose both shapes; prefer .get()
    // since .cookie may be the legacy Node IncomingMessage string which could lag.
    const req = {
      headers: {
        get: (name: string) => (name === 'cookie' ? 'ss_vid=fresh' : null),
        cookie: 'ss_vid=stale',
      },
    };
    expect(extractIdsFromRequest(req).visitorId).toBe('fresh');
  });

  test('accepts a raw cookie header string directly', () => {
    expect(extractIdsFromRequest('ss_vid=raw-v; ss_sid=raw-s')).toEqual({
      visitorId: 'raw-v',
      sessionId: 'raw-s',
    });
  });

  test('url-decodes cookie values', () => {
    const encoded = encodeURIComponent('has space+special=char');
    const req = { headers: { cookie: `ss_sid=${encoded}` } };
    expect(extractIdsFromRequest(req).sessionId).toBe('has space+special=char');
  });

  test('returns nulls when the request has no cookies', () => {
    expect(extractIdsFromRequest({})).toEqual({ visitorId: null, sessionId: null });
    expect(extractIdsFromRequest({ headers: {} })).toEqual({ visitorId: null, sessionId: null });
    expect(extractIdsFromRequest(null)).toEqual({ visitorId: null, sessionId: null });
    expect(extractIdsFromRequest(undefined)).toEqual({ visitorId: null, sessionId: null });
    expect(extractIdsFromRequest('')).toEqual({ visitorId: null, sessionId: null });
  });

  test('returns nulls on a non-object, non-string input', () => {
    expect(extractIdsFromRequest(42)).toEqual({ visitorId: null, sessionId: null });
    expect(extractIdsFromRequest(true)).toEqual({ visitorId: null, sessionId: null });
  });

  test('ignores unrelated cookies', () => {
    const req = { headers: { cookie: 'session=abc; csrf=xyz; tracking=1' } };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: null, sessionId: null });
  });

  test('handles partial presence (only visitor)', () => {
    expect(extractIdsFromRequest('ss_vid=only-v')).toEqual({ visitorId: 'only-v', sessionId: null });
  });

  test('handles partial presence (only session)', () => {
    expect(extractIdsFromRequest('ss_sid=only-s')).toEqual({ visitorId: null, sessionId: 'only-s' });
  });

  test('does not throw when headers.get throws', () => {
    const req = {
      headers: {
        get: () => { throw new Error('boom'); },
        cookie: 'ss_vid=fallback',
      },
    };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'fallback', sessionId: null });
  });

  // ── Framework-specific shapes ──────────────────────────────────────

  test('SvelteKit: cookies object with .get(name) method', () => {
    // SvelteKit's event.cookies is not a plain map; it exposes a .get() method.
    const store: Record<string, string> = { ss_vid: 'v-sk', ss_sid: 's-sk' };
    const req = {
      cookies: {
        get: (name: string) => store[name] ?? null,
        set: () => {},
        delete: () => {},
      },
    };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'v-sk', sessionId: 's-sk' });
  });

  test('SvelteKit: falls through to headers if cookies.get returns nothing', () => {
    const req = {
      cookies: {
        get: (_name: string) => null,
        set: () => {},
      },
      headers: { cookie: 'ss_vid=fallback-v' },
    };
    expect(extractIdsFromRequest(req)).toEqual({ visitorId: 'fallback-v', sessionId: null });
  });

  test('Koa: ctx.cookies.get(name) method style', () => {
    const store: Record<string, string> = { ss_vid: 'v-koa', ss_sid: 's-koa' };
    const ctx = {
      cookies: { get: (name: string) => store[name] },
    };
    expect(extractIdsFromRequest(ctx)).toEqual({ visitorId: 'v-koa', sessionId: 's-koa' });
  });

  test('Nuxt 3 / h3: event.node.req.headers.cookie', () => {
    const event = {
      node: {
        req: {
          headers: { cookie: 'ss_vid=v-nuxt; ss_sid=s-nuxt' },
        },
      },
    };
    expect(extractIdsFromRequest(event)).toEqual({ visitorId: 'v-nuxt', sessionId: 's-nuxt' });
  });

  test('Nuxt 3: prefers top-level headers over nested if both exist', () => {
    // If the outer `headers` already has cookies, we should not dig into
    // node.req.headers (the outer shape is more likely to reflect framework
    // post-processing).
    const event = {
      headers: { cookie: 'ss_vid=outer' },
      node: {
        req: { headers: { cookie: 'ss_vid=inner' } },
      },
    };
    expect(extractIdsFromRequest(event).visitorId).toBe('outer');
  });

  test('Next.js App Router: native Request with Fetch-style Headers', () => {
    // Simulates: `export async function POST(req: Request)`
    const req = new Request('https://example.com/api', {
      headers: { cookie: 'ss_vid=v-next-app; ss_sid=s-next-app' },
    });
    expect(extractIdsFromRequest(req)).toEqual({
      visitorId: 'v-next-app',
      sessionId: 's-next-app',
    });
  });

  test('Next.js Pages Router: req.cookies plain map', () => {
    const req = {
      cookies: { ss_vid: 'v-pages', ss_sid: 's-pages' },
      headers: { cookie: 'ss_vid=v-pages; ss_sid=s-pages' },
    };
    expect(extractIdsFromRequest(req)).toEqual({
      visitorId: 'v-pages',
      sessionId: 's-pages',
    });
  });

  test('Hono: c.req.raw is native Request', () => {
    const raw = new Request('https://example.com/api', {
      headers: { cookie: 'ss_vid=v-hono; ss_sid=s-hono' },
    });
    expect(extractIdsFromRequest(raw)).toEqual({
      visitorId: 'v-hono',
      sessionId: 's-hono',
    });
  });
});
