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
import { statSync } from 'node:fs';
import path from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(repoRoot, 'dist', 'server');

/**
 * Dependencies that must not be bundled:
 *  - argon2 ships a native addon
 *  - mysql2 resolves dialect files dynamically
 *  - pino and its transports spawn worker threads by resolved path
 *  - @fastify/swagger-ui ships static assets (its Swagger UI bundle) that it
 *    locates relative to its own `__dirname`; bundled, that path points into
 *    dist/server where the assets do not exist. Loaded from node_modules it
 *    resolves them itself. The prod-deps stage installs it, so it is present.
 */
const external = [
  'argon2',
  'mysql2',
  'mysql2/promise',
  'pino',
  'pino-pretty',
  'thread-stream',
  '@fastify/swagger-ui',
];

/** Internal workspace packages, consumed from source. */
const INTERNAL_PACKAGES = {
  '@openbooks/plugin-api': path.join(repoRoot, 'packages/plugin-api/src'),
  '@openbooks/shared-types': path.join(repoRoot, 'packages/shared-types/src'),
};

/**
 * Resolves internal packages, bare specifier and subpath alike.
 *
 * A plugin rather than esbuild's `alias` option, because `alias` matches by exact
 * module name and then *also* rewrites subpaths through the same mapping. With
 * `'@openbooks/shared-types'` aliased to `…/src/index.ts`, the import
 * `@openbooks/shared-types/money` was rewritten to `…/src/index.ts/money` and
 * failed with "not a directory". So the alias did not merely miss subpaths, it
 * broke them — while `tsconfig.base.json` declares `@openbooks/shared-types/*`,
 * meaning such an import typechecked and then could not be bundled. Measured, not
 * assumed.
 */
function internalPackageResolver() {
  return {
    name: 'openbooks-internal-packages',
    /** @param {import('esbuild').PluginBuild} build */
    setup(build) {
      for (const [name, sourceDir] of Object.entries(INTERNAL_PACKAGES)) {
        const escaped = name.replace(/[/\-@]/g, (c) => `\\${c}`);
        build.onResolve({ filter: new RegExp(`^${escaped}(/.*)?$`) }, (args) => {
          const subpath = args.path.slice(name.length).replace(/^\//, '');
          const resolved = resolveSourceFile(sourceDir, subpath);
          if (!resolved) {
            return {
              errors: [{ text: `Cannot resolve '${args.path}' under ${sourceDir}` }],
            };
          }
          return { path: resolved };
        });
      }
    },
  };
}

/**
 * Tries the candidate as a file, then with `.ts`, then as a directory index.
 *
 * The file check is `isFile()`, not `existsSync()`. A bare `existsSync` is true for
 * a directory, so `@openbooks/shared-types/money` resolved to the *directory*
 * `src/money` and esbuild failed with "is a directory" rather than falling through
 * to `src/money/index.ts`. Caught by probing the resolver directly instead of
 * trusting that a passing `yarn build` covered it — the real entrypoint happens to
 * use only bare specifiers, so the build was green while subpaths were broken.
 */
function resolveSourceFile(sourceDir, subpath) {
  const base = subpath === '' ? path.join(sourceDir, 'index.ts') : path.join(sourceDir, subpath);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not present; try the next shape.
    }
  }
  return undefined;
}

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
  // Node ESM has neither `require` nor the `__filename`/`__dirname` globals, yet
  // several bundled CJS deps reference them after bundling — @fastify/swagger-ui
  // reads `__dirname` to locate its static assets and throws a ReferenceError at
  // plugin registration otherwise. Shim all three from `import.meta.url`.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __nodeDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __nodeDirname(__filename);',
    ].join('\n'),
  },
  plugins: [internalPackageResolver()],
});

await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(result.metafile, null, 2));

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
process.stdout.write(`\nBundled server → dist/server/main.js (${(bytes / 1024).toFixed(0)} kB)\n`);
