/**
 * Emits `openapi.json` — and, with `--check`, is the drift gate itself.
 *
 * Spec §12: the spec is published as a CI artifact on every merge and drift is a
 * build failure (A10). Two modes, one generator, so the file CI compares against
 * cannot have been produced by a different code path than the file a developer
 * regenerates:
 *
 *     yarn spec            # write the artifact
 *     yarn spec --check    # exit 1 if the committed artifact is stale
 *
 * `--check` is an argument rather than a second npm script because this ticket may
 * not edit `package.json`. OB-027 invokes `yarn spec --check` in CI; it is the
 * whole gate.
 *
 * Run through `tsx`, never bundled: `main.ts` does not reach this file, so the
 * `import.meta.url` path resolution below is safe here in a way it would not be
 * inside `dist/server/main.js` (see the note at the bottom of `migrate.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Config } from '../config';
import { loadConfig } from '../config';
import { buildApp, generateOpenApiDocument } from '../transport';

/**
 * `packages/server/src/entrypoints/` → repo root. The artifact is committed at the
 * root because it is a product of the whole repo, not of one package, and because
 * OB-024 and CI both read it from there.
 */
const ARTIFACT_PATH = fileURLToPath(new URL('../../../../openapi.json', import.meta.url));

/**
 * The document is a pure function of the route table, so emitting it must not
 * require a database password, a session secret, or an AWS region. CI runs this on
 * a checkout with no environment at all.
 *
 * Placeholder values through the real `loadConfig` rather than a hand-written
 * `Config` literal: the literal would be a second definition of the config shape
 * that drifts the moment a field is added, and would not be frozen. Nothing here
 * is used to reach anything — `buildApp` reads `session.secret` (cookie signing,
 * never exercised), `session.cookieSecure`, and `logLevel`.
 */
function documentOnlyConfig(): Config {
  return loadConfig({
    OPENBOOKS_ROLE: 'api',
    LOG_LEVEL: 'silent',
    DATABASE_HOST: 'openapi-generation-does-not-connect',
    DATABASE_USER: 'unused',
    DATABASE_PASSWORD: 'unused',
    DATABASE_NAME: 'unused',
    SESSION_SECRET: 'openapi-generation-does-not-sign-cookies',
    STORAGE_LOCAL_PATH: '/nonexistent',
    EMAIL_FROM_ADDRESS: 'unused@example.invalid',
    // The self-host secrets default is `local` (D-101), whose only requirement is
    // this app key; a placeholder because nothing here encrypts a secret.
    SECRETS_ENCRYPTION_KEY: 'openapi-generation-does-not-encrypt-secrets',
  });
}

async function renderDocument(): Promise<string> {
  const app = await buildApp({ config: documentOnlyConfig() });
  try {
    return await generateOpenApiDocument(app);
  } finally {
    // The instance never listened, but `app.ready()` ran plugin registration; not
    // closing it leaves swagger-ui's file handles open and the process hanging.
    await app.close();
  }
}

async function readArtifact(): Promise<string | undefined> {
  try {
    return await readFile(ARTIFACT_PATH, 'utf8');
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const generated = await renderDocument();

  if (!process.argv.includes('--check')) {
    await writeFile(ARTIFACT_PATH, generated, 'utf8');
    process.stdout.write(`wrote ${ARTIFACT_PATH}\n`);
    return;
  }

  const committed = await readArtifact();
  if (committed === generated) {
    process.stdout.write('openapi.json is up to date\n');
    return;
  }

  // No diff is printed. The document is thousands of lines and the useful action
  // is always the same one command, whereas a truncated diff invites reading it as
  // the problem rather than as a symptom.
  process.stderr.write(
    (committed === undefined
      ? 'openapi.json is missing. The published API surface has no committed artifact '
      : 'openapi.json is stale. The published API surface changed without the artifact ' +
        'being regenerated ') + '(spec §12, A10). Run `yarn spec` and commit the result.\n',
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`spec: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
