import type { LogRecord, LogSinkProvider } from '@openbooks/plugin-api';

import { newUuidBuffer, runDetached, systemDb, tryUuidToBuffer } from '../../db';

/**
 * The self-host `LogSinkProvider` selected by `LOG_SINK=db` (OB-255, D-255-1): a
 * batched insert into the `logs` table (`migrations/0026_logs.ts`), off the request
 * path via `createLogSinkStream`.
 *
 * ## Detached from any ambient transaction
 *
 * `runDetached` (D-255-2) is what keeps a log write from ever joining a caller's
 * open transaction. Without it, a line emitted from inside `postJournal`'s
 * transaction would insert into `logs` on the *same* connection, and a rollback of
 * the posting would take the log row with it — the opposite of what an operational
 * log is for, and exactly the phantom-write failure `transaction-scope.ts`'s
 * `runDetached` exists to rule out for background work. `logs` also never appears
 * inside a request's unit of work on purpose: it is telemetry, not a business fact.
 *
 * ## Best-effort by contract, not by accident
 *
 * `LogSinkProvider.write` must not throw into its caller (the batching
 * destination's `flush` already guards against that, but this provider is
 * documented as best-effort in its own right — `plugin-api/src/providers.ts`). A
 * database outage is exactly the moment an operator needs the failure to be
 * visible somewhere, so it is written to stderr as one line rather than swallowed
 * silently or routed back through the logger, which feeds this same sink and would
 * recurse.
 */
export function createDbLogSink(): LogSinkProvider {
  return {
    async write(batch: readonly LogRecord[]): Promise<void> {
      if (batch.length === 0) return;

      try {
        await runDetached(() =>
          systemDb()
            .insertInto('logs')
            .values(
              batch.map((record) => ({
                id: newUuidBuffer(),
                logged_at: new Date(record.at),
                level: record.level,
                role: record.role,
                message: record.message,
                org_id: record.orgId === null ? null : (tryUuidToBuffer(record.orgId) ?? null),
                fields: JSON.stringify(record.fields),
              })),
            )
            .execute(),
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ msg: 'db log sink write failed', error: String(error) })}\n`,
        );
      }
    },
  };
}
