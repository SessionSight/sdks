import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { SplitTestingClient } from '../src/client.js';
import type { SplitTestConfigResponse } from '../src/types.js';

// Storage map injected by test/setup.ts preload
const storage: Map<string, string> = (globalThis as any).__testStorage;

beforeEach(() => {
  storage.clear();
  // Reset cookie store each test. `document.cookie` is stubbed in setup.ts
  // but as a plain object field; we control it directly here.
  (globalThis.document as any).cookie = '';
});

function installCookieStore(initial: string = ''): void {
  let store = initial;
  Object.defineProperty(globalThis, 'document', {
    value: {
      createElement: () => ({ id: '', textContent: '', remove() {} }),
      head: { appendChild() {} },
      get cookie() { return store; },
      set cookie(v: string) {
        const pair = v.split(';')[0]!.trim();
        const [name] = pair.split('=');
        const existing = store.split('; ').filter(Boolean).filter(c => !c.startsWith(`${name}=`));
        existing.push(pair);
        store = existing.join('; ');
      },
    },
    writable: true,
    configurable: true,
  });
}

const fakeConfig: SplitTestConfigResponse = {
  tests: [
    {
      key: 't1',
      id: 'id1',
      type: 'text',
      status: 'running',
      hashSeed: 's',
      trafficAllocation: 100,
      variations: [
        { key: 'a', weight: 50, value: 'A' },
        { key: 'b', weight: 50, value: 'B' },
      ],
    },
  ],
  ttl: 300,
};

describe('SplitTesting browser: reads ss_sid from cookie on exposure flush', () => {
  test('attaches sessionId from ss_sid cookie when flushing exposures', async () => {
    installCookieStore('ss_sid=sess-browser-123');

    const fetchMock = mock(async () => new Response(JSON.stringify(fakeConfig), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const beaconCalls: Array<{ url: string; body: any }> = [];
    globalThis.navigator = {
      sendBeacon: (url: string, blob: Blob) => {
        // Read the blob synchronously through its internal data for assertion
        // bun implements Blob.text() so we use that, but sendBeacon must be
        // synchronous, so we stash the blob and parse later.
        (blob as any)._capturedUrl = url;
        beaconCalls.push({ url, body: blob });
        return true;
      },
    } as any;

    const client = new SplitTestingClient({
      publicApiKey: 'pk',
      propertyId: 'p',
      apiUrl: 'https://api.test',
      visitorId: 'vis',
    });
    await client.init();

    // Trigger an exposure by reading a test
    client.get('t1', 'default');

    // Flush pending exposures synchronously
    (client as any).flushExposures();

    expect(beaconCalls.length).toBe(1);
    const body = JSON.parse(await (beaconCalls[0]!.body as Blob).text());
    // Under the session-as-identity model the exposure record carries
    // sessionId per-exposure (captured at trackExposure time from the cookie).
    expect(body.exposures.length).toBe(1);
    expect(body.exposures[0].sessionId).toBe('sess-browser-123');
    expect(body.propertyId).toBe('p');
    expect(body.exposures[0].visitorId).toBeUndefined();
  });

  test('drops exposure when ss_sid cookie is absent (no-session state)', async () => {
    installCookieStore(''); // no cookie

    const fetchMock = mock(async () => new Response(JSON.stringify(fakeConfig), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const beaconCalls: Array<{ body: Blob }> = [];
    globalThis.navigator = {
      sendBeacon: (_url: string, blob: Blob) => { beaconCalls.push({ body: blob }); return true; },
    } as any;

    const client = new SplitTestingClient({
      publicApiKey: 'pk',
      propertyId: 'p',
      apiUrl: 'https://api.test',
      visitorId: 'vis',
    });
    await client.init();
    client.get('t1', 'default');
    (client as any).flushExposures();

    // No cookie means no session to key the exposure to; the SDK skips the
    // audit write rather than sending a sessionless record.
    expect(beaconCalls.length).toBe(0);
  });
});

describe('SplitTesting server: forRequest binds cookies from the request', () => {
  test('bound flush uses sessionId from the request', async () => {
    installCookieStore('ss_sid=initial-sess'); // allow tracking so exposure gets queued

    const fetchMock = mock(async () => new Response(JSON.stringify(fakeConfig), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    const beaconCalls: Array<{ body: Blob }> = [];
    globalThis.navigator = {
      sendBeacon: (_url: string, blob: Blob) => { beaconCalls.push({ body: blob }); return true; },
    } as any;

    const client = new SplitTestingClient({
      publicApiKey: 'pk',
      propertyId: 'p',
      apiUrl: 'https://api.test',
      visitorId: 'initial-vis',
    });
    await client.init();
    client.get('t1', 'default'); // pending exposure with initial sessionId

    const req = { headers: { cookie: 'ss_vid=req-vis; ss_sid=req-sess' } };
    client.forRequest(req).flush();

    const body = JSON.parse(await beaconCalls[0]!.body.text());
    expect(body.exposures[0].sessionId).toBe('req-sess');
    expect(body.exposures[0].visitorId).toBeUndefined();
  });
});
