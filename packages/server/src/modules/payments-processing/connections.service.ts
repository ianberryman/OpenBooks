import type { PaymentProcessorProvider, ProcessorKind } from '@openbooks/plugin-api';
import type {
  ConnectProcessorRequest,
  PayLinkResponse,
  ProcessorConnection,
} from '@openbooks/shared-types';
import { connectProcessorRequestSchema } from '@openbooks/shared-types';

import { getConfig } from '../../config';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import {
  bufferToUuid,
  isDuplicateEntryError,
  newUuid,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import { assertFound, parseInput, PreconditionFailedError, ValidationError } from '../../errors';
import { secretsProvider } from '../../providers';
import type { PaymentAdapterDeps } from '../../providers/payment';
import { paymentProcessorFor } from '../../providers/payment';
import { getInvoice } from '../invoices';
import { requirePermission } from '../permissions';

import {
  LEDGER_ACCOUNT_RESOURCE,
  PROCESSOR_CONNECTION_RESOURCE as RESOURCE,
  connectionIdBytes,
  insertConnection,
  orgScope,
  selectAccountActive,
  selectAllConnections,
  selectConnectionById,
  selectConnectionByProcessor,
  setConnectionActiveRow,
  toProcessorConnection,
} from './connections.repository';

/**
 * Payment-processor connections (OB-147; ROADMAP D-82, D-83, D-101, D-103). Read
 * `connections.repository.ts` for the data access and `posting.service.ts` for the
 * D-82/D-104 posting model this module's connections feed. Follows the register
 * `bank-accounts.service.ts` set for the same shape of resource — connect, list,
 * get, deactivate, reactivate — because a processor connection is D-103's
 * extension of D-46's "a bank account is a ledger account plus import metadata"
 * to a processor:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so an
 *    unauthorized caller learns nothing about the shape of an API it cannot use.
 * 2. **A miss is `assertFound`**, never a hand-written throw — `tenantDb` has
 *    already confined every read to the context's org, so a cross-org id and a
 *    nonexistent one reach the same 404 (A7).
 * 3. **Nominate, don't invent (D-23).** `clearingAccountId`/`feeAccountId` name
 *    ledger accounts the org already has; this module never creates one.
 * 4. **A secret is never held in memory longer than the one `put`/`get` call that
 *    needs it, and never returned.** `toProcessorConnection` — the only mapper
 *    this file uses — has no `secretKey`/`webhookSecret` field to forget to omit
 *    (D-83): the wire schema does not declare one.
 */

/**
 * Connects a processor to two existing ledger accounts (D-82, D-103).
 *
 * `uq_processor_connections_org_processor` makes one connection per processor
 * per org unconditional at the schema level — reconnecting a deactivated
 * processor is `reactivateProcessorConnection`, never a second `connectProcessor`,
 * because a second row would mean two clearing accounts racing to explain one
 * processor's payouts (D-82). The pre-check below turns that into
 * `processor_already_connected` before the insert; the unique key is the real
 * guarantee if it ever races, the same shape `createExternalRef`'s pre-check/
 * insert-catch pair gives its own unique keys.
 *
 * Secrets are written through the secrets provider (D-101) before the row that
 * names them, and the row keeps only the handles `put` returned — never the
 * values (D-83). Both writes join this transaction (`secrets-store.ts` joins the
 * ambient one for the same reason `tenantDb` does), so a rollback of the insert
 * — the duplicate-processor race, or a later statement failing — cannot leave an
 * orphaned secret with no connection naming it.
 */
export async function connectProcessor(
  input: ConnectProcessorRequest,
  ctx: RequestContext,
): Promise<ProcessorConnection> {
  await requirePermission(ctx, 'processing.write');
  const request = parseInput(connectProcessorRequestSchema, input);
  const author = requireConnectingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const clearingAccountId = assertFound(
      tryUuidToBuffer(request.clearingAccountId),
      LEDGER_ACCOUNT_RESOURCE,
    );
    await assertActiveAccount(trx, clearingAccountId);

    const feeAccountId = assertFound(
      tryUuidToBuffer(request.feeAccountId),
      LEDGER_ACCOUNT_RESOURCE,
    );
    await assertActiveAccount(trx, feeAccountId);

    if ((await selectConnectionByProcessor(trx, request.processor)) !== undefined) {
      throw processorAlreadyConnected(request.processor);
    }

    const connectionId = newUuid();
    const id = uuidToBuffer(connectionId);
    // Two names because the two credentials rotate independently — a webhook
    // signing secret changing should never touch the API key's own handle.
    const secretRef = `${ctx.orgId}/processor/${connectionId}/secret`;
    const webhookSecretRef = `${ctx.orgId}/processor/${connectionId}/webhook`;

    await secretsProvider().put(secretRef, request.secretKey);
    await secretsProvider().put(webhookSecretRef, request.webhookSecret);

    try {
      await insertConnection(trx, {
        id,
        processor: request.processor,
        clearingAccountId,
        feeAccountId,
        publishableKey: request.publishableKey ?? null,
        secretRef,
        webhookSecretRef,
        externalAccountId: request.externalAccountId ?? null,
        createdByUserId: author,
      });
    } catch (error) {
      // The pre-check above is not the guarantee — `uq_processor_connections_org_processor`
      // is — so the losing side of a race between two `connectProcessor` calls for the
      // same processor lands here rather than on an opaque duplicate-key 500, the same
      // shape `createExternalRef`'s pre-check/insert-catch pair gives its own unique key.
      if (isDuplicateEntryError(error)) throw processorAlreadyConnected(request.processor);
      throw error;
    }

    return toProcessorConnection(assertFound(await selectConnectionById(trx, id), RESOURCE));
  });
}

export async function listProcessorConnections(
  ctx: RequestContext,
): Promise<readonly ProcessorConnection[]> {
  await requirePermission(ctx, 'processing.read');
  const rows = await selectAllConnections(orgScope(ctx));
  return rows.map(toProcessorConnection);
}

export async function getProcessorConnection(
  id: string,
  ctx: RequestContext,
): Promise<ProcessorConnection> {
  await requirePermission(ctx, 'processing.read');
  const bytes = assertFound(connectionIdBytes(id), RESOURCE);
  const row = assertFound(await selectConnectionById(orgScope(ctx), bytes), RESOURCE);
  return toProcessorConnection(row);
}

/**
 * Takes a connection out of circulation.
 *
 * Unlike `deactivateBankAccount`, there is no open-session guard: a processor
 * connection has no in-flight resource a deactivation could strand — the webhook
 * and the poll simply stop writing new payments through an inactive connection
 * (`ProcessorConnection.isActive`'s own doc) and every payment already recorded
 * stays exactly as posted. Idempotent, the way `deactivateBankAccount` is: an
 * already-inactive connection is returned unchanged rather than refused.
 */
export async function deactivateProcessorConnection(
  id: string,
  ctx: RequestContext,
): Promise<ProcessorConnection> {
  await requirePermission(ctx, 'processing.write');

  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(id), RESOURCE);
  assertFound(await selectConnectionById(db, bytes), RESOURCE);

  await setConnectionActiveRow(db, bytes, false);
  return toProcessorConnection(assertFound(await selectConnectionById(db, bytes), RESOURCE));
}

/**
 * The counterpart to `deactivateProcessorConnection`, and the only way back in
 * (D-103) — never a second `connectProcessor`, which
 * `uq_processor_connections_org_processor` would refuse.
 */
export async function reactivateProcessorConnection(
  id: string,
  ctx: RequestContext,
): Promise<ProcessorConnection> {
  await requirePermission(ctx, 'processing.write');

  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(id), RESOURCE);
  assertFound(await selectConnectionById(db, bytes), RESOURCE);

  await setConnectionActiveRow(db, bytes, true);
  return toProcessorConnection(assertFound(await selectConnectionById(db, bytes), RESOURCE));
}

/**
 * The single connection the pay-link route (OB-150) charges an invoice through.
 *
 * `uq_processor_connections_org_processor` bounds an org to at most one row per
 * processor, so "more than one active" only arises once a second processor is
 * connected — this picks the most recently created of them so a newly-connected
 * processor wins over one added earlier, the same tie-break `selectAllConnections`'s
 * oldest-first order makes available for free (the last element of an active
 * filter over that order is the most recent).
 *
 * `null` when the org has connected nothing active: `public-pay-link.ts` turns
 * that into `no_processor_connected` rather than reaching for a connection that
 * is not there.
 */
// TODO(v1): org designates a default processor, rather than this most-recently-connected guess.
export async function resolveActiveConnectionForOrg(
  ctx: RequestContext,
): Promise<ProcessorConnection | null> {
  await requirePermission(ctx, 'processing.read');

  const rows = await selectAllConnections(orgScope(ctx));
  const active = rows.filter((row) => row.is_active !== 0);
  const mostRecent = active[active.length - 1];
  return mostRecent === undefined ? null : toProcessorConnection(mostRecent);
}

export interface CreateCheckoutLinkInput {
  readonly connectionId: string;
  readonly invoiceId: string;
  readonly returnUrl: string;
}

/**
 * Opens a hosted-checkout session for one invoice (D-83) — the pay-link the
 * hosted invoice page's "Pay now" button opens (OB-150 wires the route; this is
 * the service call it makes).
 *
 * `amountMinor` is the invoice's own gross total, read the same way any other
 * caller reads an invoice — `getInvoice` — rather than recomputed here, so a
 * checkout amount can never drift from what the invoice itself totals (D-35's
 * "line amounts are read, never recomputed" one level up). The invoice id travels
 * in `metadata` so the resulting webhook event carries it back as **certain**
 * identity (D-83) — not a guess, unlike the inferred bank-feed match.
 */
export async function createCheckoutLink(
  input: CreateCheckoutLinkInput,
  ctx: RequestContext,
): Promise<PayLinkResponse> {
  const { connection, provider } = await loadConnectionProvider(input.connectionId, ctx);
  if (!connection.isActive) throw connectionInactive(connection.processor);

  const invoice = await getInvoice(input.invoiceId, ctx);

  const link = await provider.createCheckoutLink({
    invoiceId: input.invoiceId,
    amountMinor: invoice.totals.gross,
    // No per-org currency exists yet (spec §13 defers multi-currency; `money.ts`
    // assumes one global currency for v1) — `usd` is the only value this system
    // can honestly report until that lands.
    currency: 'usd',
    returnUrl: input.returnUrl,
    metadata: { invoiceId: input.invoiceId },
  });

  return { url: link.url };
}

/**
 * Everything the webhook/poll stream needs off a stored connection: the
 * decrypted `PaymentProcessorProvider` and the two account ids `posting.service.ts`
 * posts against. Exported for that stream (OB-148) rather than folded into
 * `posting.service.ts`, because building a provider from a connection row is
 * this module's concern (it owns `processor_connections` and the secrets
 * handles) and posting a journal from a normalized event is `posting.service.ts`'s.
 */
export async function loadConnectionProvider(
  connectionId: string,
  ctx: RequestContext,
): Promise<{
  readonly connection: ProcessorConnection;
  readonly clearingAccountId: string;
  readonly feeAccountId: string;
  readonly provider: PaymentProcessorProvider;
}> {
  await requirePermission(ctx, 'processing.read');

  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);
  const row = assertFound(await selectConnectionById(db, bytes), RESOURCE);

  const [secretKey, webhookSecret] = await Promise.all([
    secretsProvider().get(row.secret_ref),
    secretsProvider().get(row.webhook_secret_ref),
  ]);

  const config = getConfig();
  const deps: PaymentAdapterDeps = {
    secretKey,
    webhookSecret,
    publishableKey: row.publishable_key,
    externalAccountId: row.external_account_id,
    ...(config.appBaseUrl === undefined ? {} : { appBaseUrl: config.appBaseUrl }),
  };

  return {
    connection: toProcessorConnection(row),
    clearingAccountId: bufferToUuid(row.clearing_account_id),
    feeAccountId: bufferToUuid(row.fee_account_id),
    provider: paymentProcessorFor(row.processor, deps),
  };
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

/**
 * Validates a nominated ledger account exists in this org and is active
 * (D-23). Mirrors `resolveControlAccount`'s re-read in
 * `settings/control-accounts.ts`: `account_inactive` is the same token that
 * file and the tax service already use for the identical fact, so a client does
 * not learn a second name for "this account cannot be posted to" depending on
 * which service noticed.
 */
async function assertActiveAccount(db: TenantDatabase, accountId: Buffer): Promise<void> {
  const active = assertFound(await selectAccountActive(db, accountId), LEDGER_ACCOUNT_RESOURCE);
  if (!active) {
    throw new PreconditionFailedError(
      'account_inactive',
      'This account is deactivated, so a processor cannot clear or post fees into it. ' +
        'Reactivate the account, or nominate a different one.',
    );
  }
}

function processorAlreadyConnected(processor: ProcessorKind): PreconditionFailedError {
  return new PreconditionFailedError(
    'processor_already_connected',
    `This organization already has a ${processor} connection. One connection per processor ` +
      'per org is a schema-level constraint (D-103) — connecting a second one would mean two ' +
      "clearing accounts racing to explain one processor's payouts. Deactivate the existing " +
      'connection and reactivate it rather than connecting again.',
  );
}

function connectionInactive(processor: ProcessorKind): PreconditionFailedError {
  return new PreconditionFailedError(
    'processor_connection_inactive',
    `This ${processor} connection has been deactivated, so it cannot open a new checkout ` +
      'session. Reactivate it first, or pay through a different connected processor.',
  );
}

/**
 * The user a connection is made by. `processor_connections.created_by_user_id`
 * is `NOT NULL` and references `users`, so a caller with no user identity — an
 * automation acting outside a member session — has nothing to record as the
 * human D-83's "handed straight from the connect screen" assumes. Mirrors
 * `requireClearingUser` in `clearing.service.ts` for the identical reason.
 */
function requireConnectingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A processor connection is made by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot connect a processor. Every credential ' +
          'handed to the secrets provider on this path is a decision somebody made, and this is ' +
          'where it is recorded.',
      },
    ]);
  }
  return userId;
}
