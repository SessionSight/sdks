/**
 * Bundles `src/shim.ts` into `bin/sessionsight-mcp.js` — a single
 * Node-runnable file that the plugin's `mcpServers` block points at.
 *
 * The shim has to ship as a self-contained .js because the plugin runs
 * on user machines where our workspace's node_modules aren't present.
 * `bun build --target node` inlines every dependency into one file.
 */
import { mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const ENTRY = join(HERE, 'src/shim.ts');
const OUT = join(HERE, 'bin/sessionsight-mcp.js');

await mkdir(dirname(OUT), { recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: dirname(OUT),
  naming: 'sessionsight-mcp.js',
  target: 'node',
  format: 'esm',
  // Put a Node shebang on the bundle so users can run it directly.
  banner: '#!/usr/bin/env node',
  minify: false,
});

if (!result.success) {
  // eslint-disable-next-line no-console
  console.error('build failed');
  for (const m of result.logs) console.error(m);
  process.exit(1);
}

// Make the bundle executable.
await chmod(OUT, 0o755);
// eslint-disable-next-line no-console
console.log(`built ${OUT}`);
