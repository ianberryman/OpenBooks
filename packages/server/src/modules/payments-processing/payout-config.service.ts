import type { PayoutSyncConfig, UpdatePayoutSyncConfigRequest } from '@openbooks/shared-types';
import { updatePayoutSyncConfigRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer } from '../../db';
import { assertFound, parseInput, PreconditionFailedError, ValidationError } from '../../errors';
import { requirePermission } from '../permissions';

import {
  LEDGER_ACCOUNT_RESOURCE,
  PROCESSOR_CONNECTION_RESOURCE as RESOURCE,
  connectionIdBytes,
  orgScope,
  selectAccountActive,
  selectConnectionById,
  setSyncConfigRow,
} from './connections.repository';
import { replaceAccountMap, selectAccountMap } from './payout-account-map.repository';

/**
 * Configuring a connection's payout sync (OB-237; ROADMAP D-237-1, D-237-2,
 * D-237-6): the mode (`apply_payments` vs `summary_sales`), whether summaries
 * auto-post, and the `reporting_category → GL account` mapping. Read
 * `payout-sync.service.ts` for what the mapping feeds — the summary-journal
 * builder — and `connections.service.ts` for the register discipline this file
 * mirrors: `requirePermission` first, `assertFound` for a miss (A7), and
 * "nominate, don't invent" (D-23) — every mapped account must already exist and
 * be active.
 */

/** The current config: mode, auto-post, and the full category→account mapping. */
export async function getPayoutSyncConfig(
  connectionId: string,
  ctx: RequestContext,
): Promise<PayoutSyncConfig> {
  await requirePermission(ctx, 'processing.read');
  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);
  const connection = assertFound(await selectConnectionById(db, bytes), RESOURCE);
  const entries = await selectAccountMap(db, bytes);

  return {
    connectionId,
    syncMode: connection.sync_mode,
    autoPost: connection.auto_post !== 0,
    entries: entries.map((entry) => ({
      reportingCategory: entry.reportingCategory,
      accountId: bufferToUuid(entry.accountId),
    })),
  };
}

/**
 * Sets the mode, auto-post, and mapping in one transaction (D-237-1/D-237-2/
 * D-237-6). The mapping is replaced wholesale — the screen sends the complete set
 * it shows (the `bank_rules` edit shape). `summary_sales` is refused for a
 * processor whose adapter cannot break a payout down (Square today, Stripe-first
 * per D-237-4) rather than accepting a mode that would silently skip every payout.
 */
export async function updatePayoutSyncConfig(
  connectionId: string,
  input: UpdatePayoutSyncConfigRequest,
  ctx: RequestContext,
): Promise<PayoutSyncConfig> {
  await requirePermission(ctx, 'processing.write');
  const request = parseInput(updatePayoutSyncConfigRequestSchema, input);
  const author = requireConfiguringUser(ctx);

  await orgScope(ctx).transaction(async (trx) => {
    const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);
    const connection = assertFound(await selectConnectionById(trx, bytes), RESOURCE);

    // Stripe-first (D-237-4): only Square lacks a payout-breakdown adapter. `fake`
    // supports it (it is the gate's real implementation, D-102), so it is allowed.
    if (request.syncMode === 'summary_sales' && connection.processor === 'square') {
      throw new PreconditionFailedError(
        'summary_sales_unsupported_processor',
        'Summary-sales payout sync is Stripe-first (D-237-4); a square connection cannot break ' +
          'a payout down into per-category totals yet. Keep this connection in apply_payments mode.',
      );
    }

    // Reject duplicate categories before any write — the wire schema allows a list,
    // and two rows for one category would make the mapping non-deterministic.
    const seen = new Set<string>();
    const entries: {
      reportingCategory: (typeof request.entries)[number]['reportingCategory'];
      accountId: Buffer;
    }[] = [];
    for (const entry of request.entries) {
      if (seen.has(entry.reportingCategory)) {
        throw new ValidationError('A reporting category is mapped more than once.', [
          {
            path: `entries.${entry.reportingCategory}`,
            message: 'Each category maps to one account.',
          },
        ]);
      }
      seen.add(entry.reportingCategory);
      const accountBytes = assertFound(tryUuidToBuffer(entry.accountId), LEDGER_ACCOUNT_RESOURCE);
      await assertActiveAccount(trx, accountBytes);
      entries.push({ reportingCategory: entry.reportingCategory, accountId: accountBytes });
    }

    await setSyncConfigRow(trx, bytes, request.syncMode, request.autoPost);
    await replaceAccountMap(trx, { connectionId: bytes, createdByUserId: author, entries });
  });

  return getPayoutSyncConfig(connectionId, ctx);
}

// ---------------------------------------------------------------------------
// Small resolutions (mirrors connections.service.ts)
// ---------------------------------------------------------------------------

async function assertActiveAccount(db: TenantDatabase, accountId: Buffer): Promise<void> {
  const active = assertFound(await selectAccountActive(db, accountId), LEDGER_ACCOUNT_RESOURCE);
  if (!active) {
    throw new PreconditionFailedError(
      'account_inactive',
      'This account is deactivated, so a payout category cannot be coded to it. ' +
        'Reactivate the account, or map the category to a different one.',
    );
  }
}

function requireConfiguringUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A payout-sync mapping is configured by a user.', [
      {
        path: 'actor',
        message: 'This caller has no user identity, so it cannot configure a mapping.',
      },
    ]);
  }
  return userId;
}
