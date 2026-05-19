/**
 * Pre-publish guard: refuses to publish if the dist directory contains a
 * stale browser IIFE artifact (`sessionsight-feedback.js` or any `iife*`
 * file). Older builds emitted an IIFE that attached the SDK to
 * `globalThis` and embedded the secret API key in the bundle, so a stale
 * artifact lying around at publish time would leak the secret key on
 * every page that loaded the script.
 *
 * Layered with `files: [...]` allowlist + the explicit `rm -rf dist` in
 * the build script for defense in depth.
 */
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

if (!existsSync(distDir)) {
  // No dist yet; build script will create it cleanly.
  process.exit(0);
}

const banned = readdirSync(distDir).filter((name) => {
  if (name === 'sessionsight-feedback.js') return true;
  if (name.startsWith('iife')) return true;
  return false;
});

if (banned.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `[feedback] refusing to publish: stale browser IIFE artifact(s) present in dist/: ${banned.join(', ')}.\n` +
      `Run \`rm -rf dist && bun run build\` to rebuild from a clean slate.`,
  );
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('[feedback] no stale IIFE artifacts in dist/');
