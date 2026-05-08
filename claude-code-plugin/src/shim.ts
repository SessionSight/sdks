/**
 * SessionSight stdio shim for Claude Code plugins.
 *
 * Acts as a stdio MCP server (toward Claude Code), forwards every request
 * to https://api.sessionsight.com/mcp over Streamable HTTP. On first
 * launch — or whenever the cached token has lapsed — runs the OAuth dance
 * with a transient localhost callback server, opens the user's browser,
 * waits for them to complete consent, and caches the bearer in
 * `~/.config/sessionsight/auth.json`.
 *
 * Why this exists: Claude Code's plugin manifest auto-registers stdio MCP
 * servers (`mcpServers.<name>.command`) but not HTTP ones. Without this
 * shim, users would have to run `claude mcp add --transport http ...` as
 * a separate step after `/plugin install`. The shim lets us collapse the
 * install to one command.
 *
 * Stdout is the JSON-RPC channel for stdio MCP. Logs go to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// ── Logging (stderr only — stdout is the JSON-RPC channel) ───────────

function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[sessionsight-mcp ${ts}] ${args.map(formatArg).join(' ')}\n`);
}
function formatArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// ── Config ────────────────────────────────────────────────────────────

const SERVER_URL = process.env.SESSIONSIGHT_MCP_URL ?? 'https://api.sessionsight.com/mcp';
const AUTH_DIR = process.env.SESSIONSIGHT_AUTH_DIR ?? join(homedir(), '.config', 'sessionsight');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');
// Range we try for the localhost callback port. High enough to avoid
// collision with common dev ports; small enough we don't sweep forever.
const CB_PORT_START = 36801;
const CB_PORT_END = 36850;

// ── Persistent auth state ─────────────────────────────────────────────

interface AuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  // Random per-install identifier carried in OAuth state to bind the
  // callback to this shim instance. Defends against a malicious page
  // hitting our localhost callback with a forged code.
  oauthState?: string;
}

async function readState(): Promise<AuthState> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf8');
    return JSON.parse(raw) as AuthState;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw err;
  }
}

let cachedState: AuthState | null = null;
async function loadState(): Promise<AuthState> {
  if (cachedState) return cachedState;
  cachedState = await readState();
  return cachedState;
}

async function writeState(next: AuthState): Promise<void> {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  // Atomic write: write to a tmpfile then rename.
  const tmp = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, AUTH_FILE);
  cachedState = next;
}

async function patchState(patch: Partial<AuthState>): Promise<void> {
  const current = await loadState();
  await writeState({ ...current, ...patch });
}

// ── OAuthClientProvider implementation ────────────────────────────────

function makeProvider(redirectUrl: string): OAuthClientProvider {
  const clientMetadata: OAuthClientMetadata = {
    client_name: 'SessionSight Claude Code plugin',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    scope: 'openid profile email offline_access',
  };

  return {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() { return clientMetadata; },

    async state() {
      const s = await loadState();
      if (s.oauthState) return s.oauthState;
      const fresh = randomUUID();
      await patchState({ oauthState: fresh });
      return fresh;
    },

    async clientInformation() {
      const s = await loadState();
      return s.clientInformation;
    },

    async saveClientInformation(info) {
      await patchState({ clientInformation: info });
    },

    async tokens() {
      const s = await loadState();
      return s.tokens;
    },

    async saveTokens(tokens) {
      await patchState({ tokens });
    },

    async redirectToAuthorization(authorizationUrl) {
      log('opening browser for OAuth at', authorizationUrl.toString());
      openInBrowser(authorizationUrl.toString());
    },

    async saveCodeVerifier(codeVerifier) {
      await patchState({ codeVerifier });
    },

    async codeVerifier() {
      const s = await loadState();
      if (!s.codeVerifier) {
        throw new Error('No code verifier saved — OAuth state lost between authorize and callback');
      }
      return s.codeVerifier;
    },

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'auth-state') {
      const s = await loadState();
      const next: AuthState = { ...s };
      if (scope === 'all' || scope === 'tokens') delete next.tokens;
      if (scope === 'all' || scope === 'client') delete next.clientInformation;
      if (scope === 'all' || scope === 'verifier') delete next.codeVerifier;
      if (scope === 'all' || scope === 'auth-state') delete next.oauthState;
      await writeState(next);
    },
  } as OAuthClientProvider & { invalidateCredentials: (s: string) => Promise<void> };
}

// ── Browser open (cross-platform) ─────────────────────────────────────

function openInBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url.replace(/&/g, '^&')]; }
  else { cmd = 'xdg-open'; args = [url]; }
  // Detach so the child doesn't keep the shim alive.
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => log('browser open failed:', err));
    child.unref();
  } catch (err) {
    log('browser open threw:', err);
  }
}

// ── Localhost callback server ─────────────────────────────────────────
//
// Listens on a free localhost port, captures `code` (or `error`) from the
// OAuth callback, returns a tiny "you can close this tab" page, then
// closes itself.

interface CallbackResult {
  code?: string;
  error?: string;
  errorDescription?: string;
}

interface CallbackHandle {
  port: number;
  promise: Promise<CallbackResult>;
  close(): void;
}

async function startCallbackServer(expectedState: string): Promise<CallbackHandle> {
  const port = await findFreePort(CB_PORT_START, CB_PORT_END);
  let resolveCb!: (v: CallbackResult) => void;
  const promise = new Promise<CallbackResult>((resolve) => { resolveCb = resolve; });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (u.pathname !== '/cb') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const state = u.searchParams.get('state');
    if (state !== expectedState) {
      log('callback state mismatch — possible CSRF attempt');
      res.statusCode = 400;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(htmlPage('Invalid state', 'The OAuth callback did not match the expected state. Re-run the pair command.'));
      // Don't resolve — let the promise hang and the caller time out.
      return;
    }
    const code = u.searchParams.get('code') ?? undefined;
    const error = u.searchParams.get('error') ?? undefined;
    const errorDescription = u.searchParams.get('error_description') ?? undefined;

    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(htmlPage(
      error ? 'Authorization denied' : 'Authorization complete',
      error
        ? `${error}${errorDescription ? `: ${errorDescription}` : ''}. Close this tab.`
        : 'You can close this tab and return to your editor.',
    ));
    resolveCb({ code, error, errorDescription });
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return {
    port,
    promise,
    close: () => server.close(),
  };
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}h1{font-size:1.25rem}p{color:#555}</style>` +
    `</head><body><h1>${escape(title)}</h1><p>${escape(body)}</p></body></html>`;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function findFreePort(start: number, end: number): Promise<number> {
  for (let p = start; p <= end; p++) {
    if (await tryBind(p)) return p;
  }
  throw new Error(`no free port in [${start}..${end}] for OAuth callback`);
}
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// ── Connect to the upstream HTTP MCP server ───────────────────────────

// How long to wait on the OAuth callback before assuming something went
// wrong upstream. `invalid_client` / `unauthorized_client` from the
// authorize endpoint do NOT redirect to redirect_uri (OAuth spec: an
// unverifiable client_id can't be safely bounced to a caller-supplied
// URL), so they instead land on better-auth's errorURL and our cb
// server hears nothing. Without a timeout the shim would hang forever.
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

async function connectUpstream(allowStaleClientRetry = true): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const expectedState = randomUUID();
  // Pre-set the OAuth state so the provider returns the same value when
  // the SDK calls state() during authorize URL construction.
  await patchState({ oauthState: expectedState });

  const cbServer = await startCallbackServer(expectedState);
  const redirectUrl = `http://127.0.0.1:${cbServer.port}/cb`;
  const provider = makeProvider(redirectUrl);

  const makeTransport = () => new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    authProvider: provider,
  });
  const makeClient = () => new Client(
    { name: 'sessionsight-claude-code-plugin', version: '0.1.0' },
    { capabilities: {} },
  );

  let transport = makeTransport();
  let client = makeClient();

  try {
    await client.connect(transport);
    cbServer.close();
    return { client, transport };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) {
      cbServer.close();
      throw err;
    }
    // SDK opened the browser via redirectToAuthorization. Wait for the
    // callback, but cap it: if the authorize endpoint rejected our
    // cached client_id (e.g. the row was wiped from oauthApplication),
    // no callback will ever fire.
    log('waiting for OAuth callback on', redirectUrl);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cb = await Promise.race<CallbackResult | 'timeout'>([
      cbServer.promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), OAUTH_CALLBACK_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    cbServer.close();

    if (cb === 'timeout') {
      const hadClient = !!(await loadState()).clientInformation;
      if (hadClient && allowStaleClientRetry) {
        log('OAuth callback never arrived and a cached client_id was in use; assuming the registration is stale, clearing and retrying once');
        await patchState({
          clientInformation: undefined,
          tokens: undefined,
          codeVerifier: undefined,
          oauthState: undefined,
        });
        return connectUpstream(false);
      }
      throw new Error(`OAuth flow timed out after ${OAUTH_CALLBACK_TIMEOUT_MS}ms with no callback`);
    }

    if (cb.error) {
      throw new Error(`OAuth declined: ${cb.error}${cb.errorDescription ? ` (${cb.errorDescription})` : ''}`);
    }
    if (!cb.code) throw new Error('OAuth callback returned no code');

    await transport.finishAuth(cb.code);
    // Clear oauthState now that the dance is complete; next pair will
    // pick a fresh one.
    await patchState({ oauthState: undefined });
    // The original transport is in a half-started state (start() succeeded
    // but the initialize message returned 401). The SDK rejects calling
    // connect() twice on the same transport. Build a fresh transport +
    // client; the cached token from the provider is picked up
    // automatically on the next connect.
    transport = makeTransport();
    client = makeClient();
    await client.connect(transport);
    return { client, transport };
  }
}

// ── Stdio bridge ──────────────────────────────────────────────────────
//
// Wire every MCP method we need onto the stdio Server, forwarding to the
// upstream Client. We could fan out programmatically over the SDK's
// schemas, but listing the seven methods explicitly makes the contract
// audit-readable.

async function runBridge(client: Client): Promise<void> {
  const server = new Server(
    { name: 'sessionsight', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) =>
    client.request({ method: 'tools/list', params: req.params }, asResultSchema('tools')));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    client.request({ method: 'tools/call', params: req.params }, asResultSchema('callTool')));

  server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
    client.request({ method: 'prompts/list', params: req.params }, asResultSchema('prompts')));

  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    client.request({ method: 'prompts/get', params: req.params }, asResultSchema('getPrompt')));

  server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
    client.request({ method: 'resources/list', params: req.params }, asResultSchema('resources')));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
    client.request({ method: 'resources/templates/list', params: req.params }, asResultSchema('resourceTemplates')));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    client.request({ method: 'resources/read', params: req.params }, asResultSchema('readResource')));

  await server.connect(new StdioServerTransport());
  log('bridge connected on stdio');
}

// We don't ask the SDK to validate response shapes — the upstream is the
// authoritative MCP server, and forwarding its output verbatim avoids
// brittle cross-version schema mismatches. Use a permissive zod-like
// schema that accepts anything (the SDK's `request` requires a schema
// arg).
function asResultSchema(_label: string) {
  return {
    parse: (x: unknown) => x,
    safeParse: (x: unknown) => ({ success: true as const, data: x }),
  } as unknown as Parameters<Client['request']>[1];
}

// ── Entrypoint ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('starting; upstream=', SERVER_URL, 'auth=', AUTH_FILE);
  const { client } = await connectUpstream();
  log('upstream connected');
  await runBridge(client);
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
