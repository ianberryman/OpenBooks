/**
 * The API half of the B1 stack, as one long-running process Playwright can own.
 *
 * D-26 puts the B1 narrative against the Compose stack, and this script is as close to
 * that as this machine gets: **the `api` and `migrate` Compose services cannot be built
 * here, because Docker Hub pulls hang**, so the two Node roles run from the host against
 * the Compose `mysql` service. What is not compromised is the part D-26 is about —
 * real MySQL 8.4, the real migrations, the real two-user grant split, the real Fastify
 * app. Nothing is stubbed. When the image can be built again, the only change is to
 * swap the two `node --import tsx` spawns below for `docker compose up`.
 *
 * Three things happen here, in order, and the order is the point:
 *
 *   1. `docker compose up -d --wait mysql` — `--wait` blocks on the healthcheck, which
 *      `docker-compose.yml` deliberately probes over TCP rather than the unix socket so
 *      that it does not report healthy while `openbooks_app` still does not exist.
 *   2. Migrations, as `OPENBOOKS_ROLE=migrate`, run to completion. Spec §12 makes them a
 *      discrete pre-deploy job and never a boot step; expressing that here as a separate
 *      process that must exit 0 is the same shape Compose gives it with
 *      `service_completed_successfully`.
 *   3. The API, as `OPENBOOKS_ROLE=api`, **with the migrator credentials deleted from its
 *      environment**. `docker-compose.yml` sets them on the migrate service only, so no
 *      api process ever holds a credential that could alter the schema; a host-run stack
 *      that inherited them from one shell would quietly lose that property.
 *
 * Run by Playwright's `webServer`, so it must stay in the foreground for as long as the
 * API does and must die when Playwright kills it — hence the signal forwarding at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** `packages/e2e/scripts/` → the repository root. */
const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const MIGRATOR_VARS = ['DATABASE_MIGRATOR_USER', 'DATABASE_MIGRATOR_PASSWORD'];

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function runToCompletion(command, args, env) {
  const result = spawnSync(command, [...args], { cwd: repoRoot, env, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`);
  }
}

/**
 * The server entrypoints are TypeScript consumed from source (D-12), and `tsx` is resolved
 * by Node from the root `node_modules` rather than from `PATH`.
 *
 * `node --import tsx` rather than `yarn workspace @openbooks/server dev`, and that is a
 * workaround for a real defect rather than a preference: `tsx` is a devDependency of the
 * *root* and not of `@openbooks/server`, and Yarn 4 exposes only a workspace's own
 * dependencies on `PATH`, so every tsx-based script in that package — `dev`, `migrate`,
 * `codegen`, `spec` — fails with `command not found: tsx`. Reported with OB-055; the fix
 * is one line in `packages/server/package.json`, which this ticket may not edit.
 *
 * @param {string} entrypoint
 */
function serverEntry(entrypoint) {
  return ['--import', 'tsx', path.join('packages', 'server', 'src', 'entrypoints', entrypoint)];
}

const baseEnv = process.env;

runToCompletion('docker', ['compose', 'up', '-d', '--wait', 'mysql'], baseEnv);
runToCompletion('node', [...serverEntry('migrate-cli.ts'), 'up'], {
  ...baseEnv,
  OPENBOOKS_ROLE: 'migrate',
});

/** @type {NodeJS.ProcessEnv} */
const apiEnv = { ...baseEnv, OPENBOOKS_ROLE: 'api' };
for (const variable of MIGRATOR_VARS) delete apiEnv[variable];

const api = spawn('node', serverEntry('main.ts'), {
  cwd: repoRoot,
  env: apiEnv,
  stdio: 'inherit',
});

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    api.kill(signal);
  });
}

api.on('exit', (code, signal) => {
  process.exit(signal === null ? (code ?? 0) : 1);
});
