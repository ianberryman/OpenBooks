import type { Kysely } from 'kysely';

import type { DB } from '../../src/db/generated';
import type { IdempotentOperation } from '../../src/modules/idempotency';
import { newUuid, uuidToBuffer } from '../db/uuid';

/**
 * Shared scaffolding for the idempotency suites.
 *
 * ## Why the guarded write inserts an account
 *
 * The statement acceptance criterion A8 makes is about journals — "duplicate
 * idempotency key yields exactly one journal" — and it belongs to OB-026, which owns
 * the posting service. It cannot be made here for a good reason:
 * `openbooks/no-journal-writes` permits `journals` inserts only from the posting
 * repository and the ledger factories, and these files are correctly not on that
 * list. An `accounts` insert is the same shape of claim one layer down — a real,
 * committed, org-scoped row written on the guarded transaction — so "exactly one
 * execution" is asserted against a row the database either has or does not have,
 * rather than against the call counter alone.
 *
 * The counter is still the primary assertion for replay, because "the body did not
 * run again" is a statement about the body and not about its effects.
 */

export interface GuardedWrite {
  /** Pass this to `runIdempotent`. Uses the transaction it is handed, as required. */
  readonly operation: IdempotentOperation;
  /** How many times the body actually ran. */
  readonly executions: () => number;
}

/**
 * A guarded write with an optional hook, called with the 1-based execution number
 * *before* the insert. The hook is how the concurrency suite holds a transaction
 * open at a known point, and how a failure is injected mid-transaction.
 */
export function accountWriter(hook?: (execution: number) => Promise<void> | void): GuardedWrite {
  let executions = 0;

  const operation: IdempotentOperation = async (trx) => {
    executions += 1;
    const execution = executions;
    if (hook !== undefined) await hook(execution);

    const uuid = newUuid();
    // `uq_accounts_org_code` is (org_id, code), so numbering by execution keeps a
    // legitimate second execution from failing on a collision instead of on what
    // the test is about.
    const code = `IDEM-${execution}`;
    await trx
      .insertInto('accounts')
      .values({
        id: uuidToBuffer(uuid),
        code,
        name: `Guarded write ${execution}`,
        type: 'asset',
        normal_balance: 'debit',
      })
      .execute();

    return { accountId: uuid, code };
  };

  return { operation, executions: () => executions };
}

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function claimRows(db: Kysely<DB>, orgId: Buffer) {
  return db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('org_id', '=', orgId)
    .orderBy('created_at')
    .execute();
}

export async function accountCodes(db: Kysely<DB>, orgId: Buffer): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('accounts')
    .select('code')
    .where('org_id', '=', orgId)
    .orderBy('code')
    .execute();
  return rows.map((row) => row.code);
}
