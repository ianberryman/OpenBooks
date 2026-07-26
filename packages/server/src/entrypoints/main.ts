/**
 * Single production entrypoint. One image, three roles (spec §2.5).
 *
 * The bundled artifact is `dist/server/main.js`; which process it becomes is
 * decided by OPENBOOKS_ROLE at boot. Notably `migrate` is a role rather than a
 * boot step, so migrations run as a discrete job that must exit zero before the
 * API starts (spec §12).
 */
import { resolveRole } from '../config/role';

async function main(): Promise<void> {
  const role = resolveRole();

  switch (role) {
    case 'api': {
      const { startApi } = await import('./api');
      await startApi();
      return;
    }
    case 'worker': {
      const { startWorker } = await import('./worker');
      await startWorker();
      return;
    }
    case 'migrate': {
      const { runMigrations } = await import('./migrate');
      await runMigrations('up');
      return;
    }
  }
}

main().catch((error: unknown) => {
  // Nothing structured is available this early — a failure here means the
  // process never reached logger construction.
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
