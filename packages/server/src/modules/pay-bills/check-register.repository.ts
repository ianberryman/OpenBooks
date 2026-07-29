import type { TenantDatabase } from '../../db';

/**
 * The check register: the gapless, per-bank-account counter a printed check
 * draws its number from (D-111).
 *
 * Exact twin of `payments.repository.ts`'s `allocateSequenceNumber` — same
 * upsert-to-create, `FOR UPDATE` select, increment — because the argument for
 * gaplessness is identical: `AUTO_INCREMENT` consumes a value on a rollback, and
 * a gap in a numbered series is indistinguishable from a deleted row (D-14). The
 * one difference is the key. `document_sequences` is keyed by document type
 * because a payment's numbering series is a fact about the org; a check's
 * numbering series is a fact about which pad of check stock a bank account
 * draws from, so `check_number_sequences` (`0013_pay_bills`) is keyed
 * `(org_id, bank_account_id)` instead, and `org_id` arrives on every statement
 * here via `tenantDb` before this file adds anything — the upsert and the
 * locking select below key on `bank_account_id` alone.
 *
 * Must run inside the issue service's own transaction, for `allocateSequenceNumber`'s
 * exact reason: a check number consumed by a transaction that then rolls back —
 * because, say, the bill it was paying turned out already settled — must not
 * leave a gap in the register that a bank reconciling against what cleared
 * cannot explain.
 */
export async function allocateCheckNumber(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<bigint> {
  await db
    .insertInto('check_number_sequences')
    .values({ bank_account_id: bankAccountId, next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: db.orgId })
    .execute();

  const row = await db
    .selectFrom('check_number_sequences')
    .select('next_value')
    .where('bank_account_id', '=', bankAccountId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('check_number_sequences')
    .set({ next_value: row.next_value + 1n })
    .where('bank_account_id', '=', bankAccountId)
    .execute();

  return row.next_value;
}
