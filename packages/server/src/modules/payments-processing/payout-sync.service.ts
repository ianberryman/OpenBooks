import type {
  JournalLineInput,
  PayoutBreakdown,
  PayoutBreakdownResult,
} from '@openbooks/plugin-api';
import type { PayoutSync } from '@openbooks/shared-types';
import { add, fromMinorString, toMinorString, ZERO } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import { bufferToUuid, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { assertFound, NotFoundError, ValidationError } from '../../errors';
import { createExternalRef, lookupExternalRef } from '../external-refs';
import { postJournal } from '../ledger';
import { requirePermission } from '../permissions';

import { selectAccountMapAsUuidMap } from './payout-account-map.repository';
import {
  PAYOUT_SYNC_RESOURCE,
  insertPayoutSync,
  markPayoutSyncPosted,
  markPayoutSyncSkipped,
  selectPayoutSyncById,
  selectPayoutSyncByIdForUpdate,
  selectPayoutSyncByExternal,
  selectPayoutSyncsForConnection,
  toPayoutSync,
} from './payout-sync.repository';
import { buildPayoutSummaryJournal } from './summary-journal.builder';
import type { PayoutSummaryAccounts } from './summary-journal.builder';
import {
  PROCESSOR_CONNECTION_RESOURCE as CONNECTION_RESOURCE,
  connectionIdBytes,
  orgScope,
  selectConnectionById,
  selectConnectionByIdForUpdate,
} from './connections.repository';
import { loadConnectionProvider } from './connections.service';

/**
 * Summary-sales payout sync (OB-237; ROADMAP D-237-1…D-237-6). For a connection in
 * `summary_sales` mode, each Stripe payout becomes ONE grossed-up summary journal
 * (Dr Clearing / Dr Fees … Cr Revenue / Cr Sales Tax Payable) — never the net
 * deposit booked as revenue, the commonest Stripe bookkeeping error. Per-charge
 * posting is suppressed in this mode (`webhook.service.ts`'s dispatch, D-237-1),
 * so the payout is the sole posting trigger and revenue is booked exactly once.
 *
 * ## Review-first via a staging row, not a draft (D-237-2)
 *
 * `journal_drafts.createDraft` refuses a non-user author and carries no origin
 * column, so an automation-run sync cannot land a draft. Instead each payout
 * lands a `payout_syncs` row (the `document_captures` staging precedent): a
 * `pending_review` row a human posts via `postPayoutSync`, unless the connection
 * opted into `auto_post`, in which case `syncPayout` posts it directly under the
 * automation actor (the `recordProcessorCharge` precedent — automations post
 * without a draft).
 *
 * ## Idempotency
 *
 * `syncPayout` locks the connection row first (journals cannot be
 * `SELECT … FOR UPDATE`'d, D-14 — the same serialization point the charge path
 * uses), then `payout_syncs.uq (org_id, connection_id, external_payout_id)` is
 * the object-level guard: a webhook and the poll reporting one payout collapse to
 * one row. The posted summary journal is additionally keyed in `external_refs` on
 * the payout object id, so a re-post can never double-land the journal.
 *
 * ## Currency (§13 multi-currency deferred)
 *
 * A non-`usd` payout is recorded `skipped` with a reason rather than posted at a
 * 1:1 rate — the honest lean-v1 edge, never a silent mis-post.
 */

export interface SyncPayoutInput {
  readonly connectionId: string;
  readonly externalPayoutId: string;
}

export interface SyncPayoutResult {
  readonly payoutSyncId: string;
  readonly status: PayoutSync['status'];
  readonly alreadyRecorded: boolean;
}

/**
 * Fetches one payout's breakdown, builds the summary journal, and either posts it
 * (auto-post) or stages it for review (D-237-2). Called from the webhook/poll
 * dispatch when a `summary_sales` connection reports a payout — always inside
 * `runAsAutomation`, so `ctx` carries automation provenance.
 */
export async function syncPayout(
  input: SyncPayoutInput,
  ctx: RequestContext,
): Promise<SyncPayoutResult> {
  const { clearingAccountId, feeAccountId, provider, connection } = await loadConnectionProvider(
    input.connectionId,
    ctx,
  );

  return orgScope(ctx).transaction(async (trx) => {
    const connectionBytes = assertFound(connectionIdBytes(input.connectionId), CONNECTION_RESOURCE);
    // Lock the connection row: the serialization point two concurrent deliveries
    // of one payout both pass through (D-14 — journals can't be locked).
    assertFound(await selectConnectionByIdForUpdate(trx, connectionBytes), CONNECTION_RESOURCE);

    const existing = await selectPayoutSyncByExternal(trx, connectionBytes, input.externalPayoutId);
    if (existing !== undefined) {
      return {
        payoutSyncId: bufferToUuid(existing.id),
        status: existing.status as PayoutSync['status'],
        alreadyRecorded: true,
      };
    }

    // D-237-11: a breakdown fetch that throws (a network fault, an unexpected
    // Stripe 400) is recorded as a *visible* `skipped` row carrying the
    // processor's own message — never a swallowed `processor_events` 'failed' with
    // no UI trace, which is what left today's manual-payout failure invisible. The
    // caller (dispatch) then sees a normal return, so the event marks 'processed'.
    let result: PayoutBreakdownResult;
    try {
      result = await provider.fetchPayoutBreakdown(input.externalPayoutId);
    } catch (error) {
      const id = await insertPayoutSync(trx, {
        connectionId: connectionBytes,
        externalPayoutId: input.externalPayoutId,
        // Amounts and currency are unknown when the fetch itself failed; the
        // skip_reason carries the real information and this row books nothing.
        grossMinor: 0n,
        feeMinor: 0n,
        netMinor: 0n,
        currency: 'usd',
        status: 'skipped',
        breakdown: [],
        skipReason: breakdownFailureReason(error),
        occurredAt: new Date(),
        journalId: null,
        postedByUserId: null,
        postedAt: null,
      });
      return { payoutSyncId: id, status: 'skipped', alreadyRecorded: false };
    }

    // OB-237b correction (D-237-8-rev / D-237-11): a manual payout has no per-payout
    // breakdown in any Stripe API, so the adapter resolves `unsupported`. Record a
    // *visible*, actionable `skipped` row that books nothing — the operator sees why
    // (never a swallowed failure), and the D-85 balance backstop surfaces the clearing
    // residual the unrecognised sales leave. Full support is OB-237c (period recognition).
    if (result.kind === 'unsupported') {
      const id = await insertPayoutSync(trx, {
        connectionId: connectionBytes,
        externalPayoutId: input.externalPayoutId,
        grossMinor: 0n,
        feeMinor: 0n,
        netMinor: 0n,
        currency: 'usd',
        status: 'skipped',
        breakdown: [],
        skipReason: result.reason,
        occurredAt: new Date(),
        journalId: null,
        postedByUserId: null,
        postedAt: null,
      });
      return { payoutSyncId: id, status: 'skipped', alreadyRecorded: false };
    }

    const breakdown = result.breakdown;
    const totals = payoutTotals(breakdown);
    const occurredAt = new Date(breakdown.occurredAt);

    // A non-usd payout: recorded and skipped, never posted at a 1:1 rate (§13).
    if (breakdown.currency.toLowerCase() !== 'usd') {
      const id = await insertPayoutSync(trx, {
        connectionId: connectionBytes,
        externalPayoutId: input.externalPayoutId,
        grossMinor: totals.gross,
        feeMinor: totals.fee,
        netMinor: totals.net,
        currency: breakdown.currency,
        status: 'skipped',
        breakdown: breakdown.categories.map((c) => ({ ...c })),
        skipReason: `unsupported_currency:${breakdown.currency}`,
        occurredAt,
        journalId: null,
        postedByUserId: null,
        postedAt: null,
      });
      return { payoutSyncId: id, status: 'skipped', alreadyRecorded: false };
    }

    const accounts = await resolveSummaryAccounts(
      trx,
      connectionBytes,
      clearingAccountId,
      feeAccountId,
    );
    const built = buildPayoutSummaryJournal(breakdown, accounts);

    if (!built.ok) {
      const id = await insertPayoutSync(trx, {
        connectionId: connectionBytes,
        externalPayoutId: input.externalPayoutId,
        grossMinor: totals.gross,
        feeMinor: totals.fee,
        netMinor: totals.net,
        currency: breakdown.currency,
        status: 'skipped',
        breakdown: breakdown.categories.map((c) => ({ ...c })),
        skipReason: built.reason,
        occurredAt,
        journalId: null,
        postedByUserId: null,
        postedAt: null,
      });
      return { payoutSyncId: id, status: 'skipped', alreadyRecorded: false };
    }

    if (!connection.autoPost) {
      const id = await insertPayoutSync(trx, {
        connectionId: connectionBytes,
        externalPayoutId: input.externalPayoutId,
        grossMinor: totals.gross,
        feeMinor: totals.fee,
        netMinor: totals.net,
        currency: breakdown.currency,
        status: 'pending_review',
        breakdown: breakdown.categories.map((c) => ({ ...c })),
        skipReason: null,
        occurredAt,
        journalId: null,
        postedByUserId: null,
        postedAt: null,
      });
      return { payoutSyncId: id, status: 'pending_review', alreadyRecorded: false };
    }

    // Auto-post: the automation actor posts directly (no user author, D-237-2).
    const journalId = await postSummaryJournal(
      input.connectionId,
      input.externalPayoutId,
      breakdown,
      built.lines,
      ctx,
    );
    const id = await insertPayoutSync(trx, {
      connectionId: connectionBytes,
      externalPayoutId: input.externalPayoutId,
      grossMinor: totals.gross,
      feeMinor: totals.fee,
      netMinor: totals.net,
      currency: breakdown.currency,
      status: 'posted',
      breakdown: breakdown.categories.map((c) => ({ ...c })),
      skipReason: null,
      occurredAt,
      journalId: uuidToBuffer(journalId),
      postedByUserId: null,
      postedAt: new Date(),
    });
    return { payoutSyncId: id, status: 'posted', alreadyRecorded: false };
  });
}

/** The review list for a connection (D-237-2), newest first, optionally by status. */
export async function listPayoutSyncs(
  connectionId: string,
  status: PayoutSync['status'] | undefined,
  ctx: RequestContext,
): Promise<readonly PayoutSync[]> {
  await requirePermission(ctx, 'processing.read');
  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(connectionId), CONNECTION_RESOURCE);
  // A7: a cross-org connection id is a 404 here, not an empty list — an empty list
  // for a stranger's id would be a distinguishable answer (the shape A7 rules out).
  assertFound(await selectConnectionById(db, bytes), CONNECTION_RESOURCE);
  const rows = await selectPayoutSyncsForConnection(db, bytes, status);
  return rows.map(toPayoutSync);
}

export async function getPayoutSync(id: string, ctx: RequestContext): Promise<PayoutSync> {
  await requirePermission(ctx, 'processing.read');
  const bytes = assertFound(tryUuidToBuffer(id), PAYOUT_SYNC_RESOURCE);
  const row = assertFound(await selectPayoutSyncById(orgScope(ctx), bytes), PAYOUT_SYNC_RESOURCE);
  return toPayoutSync(row);
}

/**
 * The human "Post" action (D-237-2): posts a `pending_review` sync's summary
 * journal under the reviewing user's identity. Rebuilds the lines from the stored
 * breakdown and the current account map, so a mapping corrected since the sync
 * landed takes effect. `external_refs` on the payout object id makes a double-post
 * impossible even if two reviewers race.
 */
export async function postPayoutSync(id: string, ctx: RequestContext): Promise<PayoutSync> {
  await requirePermission(ctx, 'processing.write');
  const postedByUserId = requirePostingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const bytes = assertFound(tryUuidToBuffer(id), PAYOUT_SYNC_RESOURCE);
    const row = assertFound(await selectPayoutSyncByIdForUpdate(trx, bytes), PAYOUT_SYNC_RESOURCE);
    const sync = toPayoutSync(row);
    if (sync.status !== 'pending_review') {
      throw new ValidationError('This payout sync is not awaiting review.', [
        {
          path: 'status',
          message: `A payout sync can only be posted from 'pending_review'; this one is '${sync.status}'.`,
        },
      ]);
    }

    const connectionId = sync.connectionId;
    const { clearingAccountId, feeAccountId } = await loadConnectionProvider(connectionId, ctx);
    const accounts = await resolveSummaryAccounts(
      trx,
      row.connection_id,
      clearingAccountId,
      feeAccountId,
    );

    const breakdown = syncToBreakdown(sync);
    const built = buildPayoutSummaryJournal(breakdown, accounts);
    if (!built.ok) {
      throw new ValidationError('This payout cannot be posted with the current mapping.', [
        { path: 'mapping', message: built.reason },
      ]);
    }

    const journalId = await postSummaryJournal(
      connectionId,
      sync.externalPayoutId,
      breakdown,
      built.lines,
      ctx,
    );
    await markPayoutSyncPosted(trx, bytes, uuidToBuffer(journalId), postedByUserId, new Date());
    return toPayoutSync(assertFound(await selectPayoutSyncById(trx, bytes), PAYOUT_SYNC_RESOURCE));
  });
}

/** Declines a `pending_review` sync (D-237-2) — a human deciding not to book this payout. */
export async function skipPayoutSync(
  id: string,
  reason: string,
  ctx: RequestContext,
): Promise<PayoutSync> {
  await requirePermission(ctx, 'processing.write');
  const db = orgScope(ctx);
  const bytes = assertFound(tryUuidToBuffer(id), PAYOUT_SYNC_RESOURCE);
  const row = assertFound(await selectPayoutSyncById(db, bytes), PAYOUT_SYNC_RESOURCE);
  if (row.status !== 'pending_review') {
    throw new ValidationError('This payout sync is not awaiting review.', [
      {
        path: 'status',
        message: `A payout sync can only be skipped from 'pending_review'; this one is '${row.status}'.`,
      },
    ]);
  }
  await markPayoutSyncSkipped(db, bytes, reason.trim() === '' ? 'skipped_by_user' : reason.trim());
  return toPayoutSync(assertFound(await selectPayoutSyncById(db, bytes), PAYOUT_SYNC_RESOURCE));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A failed breakdown fetch → a `skip_reason` (D-237-11), bounded to the column width. */
function breakdownFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `breakdown_failed:${message}`.slice(0, 255);
}

/**
 * Posts the summary journal and keys it in `external_refs` on the payout object
 * id (D-237, entityType `'journal'` — a summary journal is not a payment/invoice
 * settlement). `source:'clearing'` (the refund/fee precedent — this is a
 * clearing-account posting). Actor provenance rides `ctx`, so an auto-post
 * records `actor_type:'automation'` and a human post records the user.
 */
async function postSummaryJournal(
  connectionId: string,
  externalPayoutId: string,
  breakdown: PayoutBreakdown,
  lines: readonly JournalLineInput[],
  ctx: RequestContext,
): Promise<string> {
  const posted = await postJournal(
    {
      date: new Date(breakdown.occurredAt).toISOString().slice(0, 10),
      source: 'clearing',
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      memo: `stripe payout ${externalPayoutId}`,
      lines,
    },
    ctx,
  );

  // Object-level idempotency (D-237): a re-sync/re-post of the same payout finds
  // this ref and cannot double-post. The connection processor is the system tag.
  const existing = await findPayoutRef(connectionId, externalPayoutId, ctx);
  if (existing === undefined) {
    await createExternalRef(
      {
        externalSystem: 'stripe',
        entityType: 'journal',
        externalId: externalPayoutId,
        entityId: posted.journalId,
      },
      ctx,
    );
  }
  return posted.journalId;
}

async function findPayoutRef(
  _connectionId: string,
  externalPayoutId: string,
  ctx: RequestContext,
): Promise<string | undefined> {
  try {
    const ref = await lookupExternalRef(
      { externalSystem: 'stripe', entityType: 'journal', externalId: externalPayoutId },
      ctx,
    );
    return ref.entityId;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** The clearing/fee accounts plus the category→account map the builder resolves through. */
async function resolveSummaryAccounts(
  trx: Parameters<typeof selectAccountMapAsUuidMap>[0],
  connectionBytes: Buffer,
  clearingAccountId: string,
  feeAccountId: string,
): Promise<PayoutSummaryAccounts> {
  const byCategory = await selectAccountMapAsUuidMap(trx, connectionBytes);
  return { clearingAccountId, feeAccountId, byCategory };
}

interface PayoutTotals {
  readonly gross: bigint;
  readonly fee: bigint;
  readonly net: bigint;
}

/** gross = charge + tax; fee = fee; net = the payout net (the clearing plug). */
function payoutTotals(breakdown: PayoutBreakdown): PayoutTotals {
  let gross = ZERO;
  let fee = ZERO;
  for (const category of breakdown.categories) {
    const amount = fromMinorString(category.amountMinor);
    if (category.reportingCategory === 'charge' || category.reportingCategory === 'tax') {
      gross = add(gross, amount);
    } else if (category.reportingCategory === 'fee') {
      fee = add(fee, amount);
    }
  }
  return {
    gross: BigInt(toMinorString(gross)),
    fee: BigInt(toMinorString(fee)),
    net: BigInt(breakdown.netMinor),
  };
}

/** Reconstructs a `PayoutBreakdown` from a stored sync DTO for re-posting on review. */
function syncToBreakdown(sync: PayoutSync): PayoutBreakdown {
  return {
    payoutId: sync.externalPayoutId,
    netMinor: sync.netMinor,
    currency: sync.currency,
    occurredAt: sync.occurredAt,
    categories: sync.breakdown.map((c) => ({ ...c })),
  };
}

/**
 * The user posting a reviewed sync. Mirrors `requireConnectingUser` in
 * `connections.service.ts`: `payout_syncs.posted_by_user_id` records a human
 * decision, so a caller with no user identity cannot post one.
 */
function requirePostingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A payout sync is posted by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot post a payout summary journal for ' +
          'review. Auto-post is the automation path; this is the human one.',
      },
    ]);
  }
  return userId;
}
