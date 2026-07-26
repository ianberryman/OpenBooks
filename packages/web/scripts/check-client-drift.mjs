#!/usr/bin/env node
/**
 * The client-side half of the spec drift gate. Fails the build when
 * `src/api/schema.d.ts` no longer matches `openapi.json`.
 *
 * ## Why this exists alongside `yarn spec --check`
 *
 * `yarn spec --check` (`packages/server/src/entrypoints/spec.ts`) proves that
 * `openapi.json` matches the route table — gate A10, spec §12. It says nothing about the
 * generated client, which goes stale in exactly the same way: a route changes, the
 * artifact is regenerated and committed, and `schema.d.ts` still describes the previous
 * shape. The build then passes, because the generated types are internally consistent, and
 * the disagreement surfaces as a runtime 400 in whichever screen touched the changed
 * field. Two gates, chained, cover the whole path:
 *
 *     yarn spec --check                                   # routes → openapi.json
 *     node packages/web/scripts/check-client-drift.mjs    # openapi.json → schema.d.ts
 *
 * **OB-027 runs both, in that order, and owns the root `package.json` script wiring** —
 * this ticket may not edit any `package.json`, which is also why this is a bare `node`
 * script rather than a `codegen:check` npm script. The order matters only for the message:
 * run the other way round, a route change reports as client drift, and the fix then looks
 * like `codegen` when it is `spec`.
 *
 * ## It runs the real command rather than reimplementing it
 *
 * The generator invocation lives in `packages/web/package.json` as the `codegen` script and
 * cannot move here. So this script *calls* it — `yarn run codegen`, the same command a
 * developer runs — instead of restating its arguments, which would give the gate a second
 * definition of the generator that could drift from the first and leave it checking a file
 * nobody produces. `spec.ts` gets this property by having one function behind both modes;
 * this gets it by shelling out.
 *
 * The cost is that the check writes to the working tree and restores it afterwards. If the
 * process is killed between those two steps the file is left regenerated — which is byte
 * for byte what `yarn codegen` would have written, so the tree is never left in a state
 * that is *wrong*, only possibly one commit ahead.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** `packages/web/scripts/` → `packages/web/`. */
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where `codegen` writes. Relative form is used in messages; it is what a reader greps for. */
const CLIENT_RELATIVE = 'src/api/schema.d.ts';
const CLIENT_PATH = path.join(WEB_ROOT, CLIENT_RELATIVE);

/**
 * Runs `@openbooks/web`'s own `codegen` script, from that workspace.
 *
 * `cwd` is the workspace because `openapi-typescript` is one of its devDependencies and is
 * only guaranteed to be on the bin path there, and because the script's `../../openapi.json`
 * is relative to it. Output is captured rather than inherited so a passing run is silent
 * and a failing one still shows the generator's own diagnostics.
 */
function regenerate() {
  const result = spawnSync('yarn', ['run', 'codegen'], { cwd: WEB_ROOT, encoding: 'utf8' });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`\`yarn run codegen\` exited ${String(result.status)}`);
  }
}

/** @returns {Promise<Buffer | undefined>} `undefined` when the generated client is absent. */
async function readCommittedClient() {
  try {
    return await readFile(CLIENT_PATH);
  } catch {
    return undefined;
  }
}

/**
 * @param {Buffer | undefined} committed
 * @returns {Promise<boolean>}
 */
async function regeneratesIdentically(committed) {
  try {
    regenerate();
    // Bytes, not parsed content. `tsc` consumes this file verbatim, and a whitespace-only
    // difference is still a file `yarn codegen` would rewrite — which is what turns a gate
    // into a recurring surprise diff.
    return committed !== undefined && committed.equals(await readFile(CLIENT_PATH));
  } finally {
    // Leave the tree as it was found, so the gate asks a question rather than making an edit.
    if (committed === undefined) {
      await rm(CLIENT_PATH, { force: true });
    } else {
      await writeFile(CLIENT_PATH, committed);
    }
  }
}

async function main() {
  const committed = await readCommittedClient();

  if (await regeneratesIdentically(committed)) {
    process.stdout.write(`${CLIENT_RELATIVE} is up to date\n`);
    return;
  }

  // No diff is printed, for the reason `spec.ts` prints none: the file is 1,700 generated
  // lines, the action is always the one command below, and a truncated diff invites
  // reading the symptom as the problem.
  process.stderr.write(
    (committed === undefined
      ? `packages/web/${CLIENT_RELATIVE} is missing. `
      : `packages/web/${CLIENT_RELATIVE} is stale — openapi.json changed without the typed ` +
        `client being regenerated. `) +
      `The React app consumes the public REST API only (spec §12), and this file is that ` +
      `contract in TypeScript.\n` +
      `Run \`yarn workspace @openbooks/web codegen\` and commit the result.\n`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`check-client-drift: ${detail}\n`);
  process.exitCode = 1;
});
