import type { BankFeedTransaction } from '@openbooks/plugin-api';
import type { BankFeedSyncResult } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import { bufferToUuid, newUuidBuffer, systemDb } from '../../db';
import { assertFound } from '../../errors';
import type { Logger } from '../../logging';
import type { ParsedStatementRow } from '../banking/parser';
import { fingerprintRows } from '../banking/statements/fingerprint';
import type { NewLineRow } from '../banking/statements/repository';
import { existingFingerprintCounts, insertLinesIgnore } from '../banking/statements/repository';
import { requirePermission } from '../permissions';
import { runAsAutomation } from '../scheduling';

import {
  BANK_FEED_CONNECTION_RESOURCE as RESOURCE,
  connectionIdBytes,
  orgScope,
  selectAllActiveConnectionsAcrossOrgs,
  selectConnectionByIdForUpdate,
  setConnectionCursor,
  setConnectionSyncError,
} from './connections.repository';
import { loadConnectionProvider } from './connections.service';

/**
 * The live-feed ingest (OB-227; ROADMAP D-127, D-128, D-129).
 *
 * A sync pulls transactions off a connected feed and lands them in
 * `bank_statement_lines` through the *same* dedup the CSV/OFX import uses — this file
 * writes no new pipeline, it feeds the existing one. The one adaptation is where the
 * fingerprint's stability comes from: a live feed carries the provider's own stable
 * transaction id (`BankFeedTransaction.externalId`), so `mapTransactionToLine` rides it
 * into `bank_reference` and `computeFingerprint` makes a re-synced overlap collapse on
 * the unique key rather than double-post (D-127). Nothing here ever UPDATEs a statement
 * line — they are append-only (E2); a re-sync inserts only what is genuinely new.
 */

/**
 * A live-feed transaction, mapped to the bank facts the import pipeline reads
 * (`ParsedStatementRow`) — pure, no database. The one decision it encodes is D-127:
 * `bankReference = txn.externalId`, the provider's stable id, is the idempotency anchor
 * that makes the fingerprint identical across re-syncs of the same transaction.
 * `amount` is the signed minor units the feed already reports (`BigInt(txn.amountMinor)`),
 * in the asset frame a statement line's amount already uses (+ = money in, D-13).
 */
export function mapTransactionToLine(txn: BankFeedTransaction): ParsedStatementRow {
  return {
    postedDate: txn.postedDate,
    valueDate: txn.valueDate,
    amount: BigInt(txn.amountMinor),
    description: txn.description,
    counterparty: txn.counterparty,
    bankReference: txn.externalId,
  };
}

/**
 * Pulls one connection's feed forward from its stored cursor and lands the new lines.
 *
 * The connection row is locked `FOR UPDATE` (D-14: `bank_statement_lines` is
 * append-only and cannot itself be locked, so the connection row is the serialization
 * point) — two concurrent syncs of one connection serialize here, and the cursor
 * advances single-writer. The dedup is `persistLines`' exact algorithm
 * (`banking/statements/service.ts`): fingerprint the pulled rows, count how many of each
 * fingerprint the account already holds, insert only the occurrences beyond that count,
 * with `import_id: null` (there is no file — the same NULL a hand-entered line carries).
 * The cursor advances only on success (D-128); a provider failure records an advisory
 * error and leaves the cursor untouched, so the next run resumes from the same point.
 */
export async function syncBankFeed(
  connectionId: string,
  ctx: RequestContext = getContext('syncBankFeed()'),
): Promise<BankFeedSyncResult> {
  await requirePermission(ctx, 'banking.import');

  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);

  try {
    return await db.transaction(async (trx) => {
      const row = assertFound(await selectConnectionByIdForUpdate(trx, bytes), RESOURCE);
      const provider = await loadConnectionProvider(row, ctx);

      const pulled = await provider.fetchTransactions({ cursor: row.sync_cursor });

      const fingerprinted = fingerprintRows(pulled.transactions.map(mapTransactionToLine));
      const distinct = [...new Set(fingerprinted.map((line) => line.fingerprint))];
      const existing = await existingFingerprintCounts(trx, row.bank_account_id, distinct);

      const planned: NewLineRow[] = fingerprinted
        .filter((line) => line.occurrenceIndex >= (existing.get(line.fingerprint) ?? 0))
        .map((line) => ({
          id: newUuidBuffer(),
          bankAccountId: row.bank_account_id,
          // No file backs a feed line — the same NULL `createManualStatementLine` writes.
          importId: null,
          postedDate: line.row.postedDate,
          valueDate: line.row.valueDate,
          description: line.row.description,
          counterparty: line.row.counterparty,
          amountMinor: line.row.amount,
          bankReference: line.row.bankReference,
          fingerprint: line.fingerprint,
          occurrenceIndex: line.occurrenceIndex,
        }));

      await insertLinesIgnore(trx, planned);

      const linesRead = fingerprinted.length;
      // `planned` is what dedup decided was new; the unique key + INSERT IGNORE is the
      // real idempotency guarantee (D-127), so these counts are advisory — the same
      // computation the import preview reports for the identical decision.
      const linesImported = planned.length;

      const syncedAt = new Date();
      await setConnectionCursor(trx, bytes, pulled.cursor, syncedAt);

      return {
        connectionId: bufferToUuid(row.id),
        linesImported,
        linesDuplicate: linesRead - linesImported,
        cursor: pulled.cursor,
        syncedAt: syncedAt.toISOString(),
      };
    });
  } catch (error) {
    // Recorded in its own write so it survives the rolled-back sync transaction (D-128:
    // the cursor did not move, so the next run retries from the same point). Best-effort
    // — a failure to record the error must never mask the original — and a no-op when
    // the id names no row (a 404), which touches nothing.
    try {
      await setConnectionSyncError(db, bytes, describeSyncError(error));
    } catch {
      // The advisory write is not the operation; the original error is what the caller
      // and the sweep's per-connection log must see.
    }
    throw error;
  }
}

export interface BankFeedSyncDeps {
  readonly logger: Logger;
}

/**
 * The D-129 daily sweep: every active connection, across every org, each synced under
 * its own org's automation scope. One connection's failure is logged and does not stop
 * the sweep — the "a bad row must not hold every other org hostage for a day"
 * discipline `runProcessorPoll` states for its own loop.
 */
export async function runBankFeedSync(deps: BankFeedSyncDeps): Promise<void> {
  const connections = await selectAllActiveConnectionsAcrossOrgs(systemDb());

  for (const row of connections) {
    const orgId = bufferToUuid(row.org_id);
    const connectionId = bufferToUuid(row.id);

    try {
      await runAsAutomation(orgId, connectionId, (ctx) => syncBankFeed(connectionId, ctx));
    } catch (error) {
      deps.logger.error(
        { orgId, connectionId, err: error },
        'bank feed sync failed for one connection; continuing with the rest (D-129 daily ' +
          'sweep — the cursor did not advance, so a missed sync self-heals on the next tick).',
      );
    }
  }
}

/** The advisory message stored on a failed sync — a bounded string, never the error object. */
function describeSyncError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
