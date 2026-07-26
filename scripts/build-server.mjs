#!/usr/bin/env node
/**
 * Production build for the server.
 *
 * Bundles with esbuild rather than emitting per-package `dist` trees. Internal
 * packages (@openbooks/plugin-api, @openbooks/shared-types) are consumed from
 * source everywhere — tests, dev, and here — so there is no dev-vs-prod module
 * resolution split to get wrong.
 *
 * Native and binary-shipping dependencies stay external; everything else is
 * inlined. Type checking is `yarn typecheck`, not this script — esbuild does not
 * typecheck, by design.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(repoRoot, 'dist', 'server');

/**
 * Dependencies that must not be bundled:
 *  - argon2 ships a native addon
 *  - mysql2 resolves dialect files dynamically
 *  - pino and its transports spawn worker threads by resolved path
 */
const external = ['argon2', 'mysql2', 'mysql2/promise', 'pino', 'pino-pretty', 'thread-stream'];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(repoRoot, 'packages/server/src/entrypoints/main.ts')],
  outfile: path.join(outDir, 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false, // Readable stack traces matter more than bytes for a server.
  external,
  logLevel: 'info',
  metafile: true,
  // Node ESM has no `require`; several CJS deps reference it after bundling.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  alias: {
    '@openbooks/plugin-api': path.join(repoRoot, 'packages/plugin-api/src/index.ts'),
    '@openbooks/shared-types': path.join(repoRoot, 'packages/shared-types/src/index.ts'),
  },
});

await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(result.metafile, null, 2));

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
process.stdout.write(`\nBundled server → dist/server/main.js (${(bytes / 1024).toFixed(0)} kB)\n`);
