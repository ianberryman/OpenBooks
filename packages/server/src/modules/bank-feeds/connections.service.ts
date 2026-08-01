import type { BankFeedProvider } from '@openbooks/plugin-api';
import type {
  BankFeedConnection,
  BankFeedConnectionPage,
  BankFeedLinkSession,
} from '@openbooks/shared-types';
import {
  connectBankFeedRequestSchema,
  createBankFeedLinkSessionRequestSchema,
  listBankFeedsQuerySchema,
} from '@openbooks/shared-types';

import { getConfig } from '../../config';
import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import {
  isDuplicateEntryError,
  newUuid,
  resolvePageLimit,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import { PreconditionFailedError, ValidationError, assertFound, parseInput } from '../../errors';
import { secretsProvider } from '../../providers';
import { bankFeedProviderFor } from '../../providers/bankfeed';
import { requirePermission } from '../permissions';

import {
  BANK_ACCOUNT_RESOURCE,
  BANK_FEED_CONNECTION_RESOURCE as RESOURCE,
  type ConnectionRow,
  connectionIdBytes,
  insertConnection,
  listConnections,
  orgScope,
  selectBankAccountExists,
  selectConnectionByBankAccount,
  selectConnectionById,
  setBankAccountFeedSource,
  setConnectionActive,
  toBankFeedConnection,
} from './connections.repository';

/**
 * Live bank-feed connections (OB-227; ROADMAP D-126…D-131). Read
 * `connections.repository.ts` for the data access and `feed-sync.service.ts` for the
 * D-127/D-128 ingest these connections feed. This is the `payments-processing/connections.service.ts`
 * set — connect, list, get, deactivate, plus a link session — applied to a live feed,
 * because a bank-feed connection is D-46's "a bank account is a ledger account plus
 * import metadata" carried one step further into a live pull:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so an
 *    unauthorized caller learns nothing about the shape of an API it cannot use.
 * 2. **A miss is `assertFound`**, never a hand-written throw — `tenantDb` has already
 *    confined every read to the context's org, so a cross-org id and a nonexistent one
 *    reach the same 404 (A7).
 * 3. **The restricted key is inbound-only (D-83/D-131).** It is handed to the secrets
 *    provider (D-101) and the row keeps only the handle; `toBankFeedConnection` has no
 *    field for it, so a response cannot carry it.
 */

/**
 * Connects a live feed to an existing bank account (D-126). One feed per account is a
 * schema-level constraint (`uq_bank_feed_connections_org_bank_account`): the pre-check
 * below turns a second connect into the readable `bank_feed_already_connected`
 * precondition, and the unique key is the real guarantee if it ever races — the
 * pre-check/insert-catch pair `connectProcessor` gives its own unique key.
 *
 * The restricted key is written through the secrets provider (D-101) before the row
 * that names it, and the row keeps only the handle `put` returned, never the value
 * (D-83). Both writes join this transaction (`secrets-store.ts` joins the ambient one
 * for the same reason `tenantDb` does), so a rollback of the insert cannot leave an
 * orphaned secret with no connection naming it. Connecting also flips the bank
 * account's `feed_source` to this connection's source, so the account and its feed
 * agree in one atomic step.
 */
export async function connectBankFeed(
  input: unknown,
  ctx: RequestContext = getContext('connectBankFeed()'),
): Promise<BankFeedConnection> {
  await requirePermission(ctx, 'banking.connect');
  const request = parseInput(connectBankFeedRequestSchema, input);
  const author = requireConnectingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const bankAccountId = assertFound(
      tryUuidToBuffer(request.bankAccountId),
      BANK_ACCOUNT_RESOURCE,
    );
    if (!(await selectBankAccountExists(trx, bankAccountId))) {
      // Route a nonexistent bank account through the same 404 a cross-org one produces (A7).
      assertFound(undefined, BANK_ACCOUNT_RESOURCE);
    }

    if ((await selectConnectionByBankAccount(trx, bankAccountId)) !== undefined) {
      throw bankFeedAlreadyConnected();
    }

    const connectionId = newUuid();
    const id = uuidToBuffer(connectionId);
    const secretRef = `${ctx.orgId}/bank-feed/${connectionId}/restricted-key`;

    await secretsProvider().put(secretRef, request.restrictedKey);

    try {
      await insertConnection(trx, {
        id,
        bankAccountId,
        feedSource: request.feedSource,
        // v1 is bring-your-own only (D-131): the org supplies its own Stripe restricted
        // key and Stripe bills the org directly. `managed` is the deferred model.
        credentialSource: 'bring_your_own',
        secretRef,
        externalAccountId: request.externalAccountId,
        institution: request.institution ?? null,
        createdByUserId: author,
      });
    } catch (error) {
      // The pre-check above is not the guarantee — the unique key is — so the losing
      // side of a race between two connects for the same bank account lands here rather
      // than on an opaque duplicate-key 500.
      if (isDuplicateEntryError(error)) throw bankFeedAlreadyConnected();
      throw error;
    }

    await setBankAccountFeedSource(trx, bankAccountId, request.feedSource);

    return toBankFeedConnection(assertFound(await selectConnectionById(trx, id), RESOURCE));
  });
}

export async function listBankFeeds(
  query: unknown,
  ctx: RequestContext = getContext('listBankFeeds()'),
): Promise<BankFeedConnectionPage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankFeedsQuerySchema, query);

  const db = orgScope(ctx);
  const limit = resolvePageLimit(filters.limit);
  const page = await listConnections(
    db,
    {
      ...(filters.isActive === undefined ? {} : { isActive: filters.isActive }),
      ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    },
    limit,
  );

  return { items: page.rows.map(toBankFeedConnection), nextCursor: page.nextCursor };
}

export async function getBankFeed(
  connectionId: string,
  ctx: RequestContext = getContext('getBankFeed()'),
): Promise<BankFeedConnection> {
  await requirePermission(ctx, 'banking.read');
  const db = orgScope(ctx);
  const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);
  return toBankFeedConnection(assertFound(await selectConnectionById(db, bytes), RESOURCE));
}

/**
 * Disconnects a feed. Soft deactivate, never a hard delete (D-16): the daily sync stops
 * pulling and every line already imported stays exactly as it was, and the bank account
 * reverts to `file` import (D-126). No open-session guard is needed — a feed connection
 * has no in-flight resource a deactivation could strand, exactly as
 * `deactivateProcessorConnection` reasons for its own row.
 */
export async function deactivateBankFeed(
  connectionId: string,
  ctx: RequestContext = getContext('deactivateBankFeed()'),
): Promise<BankFeedConnection> {
  await requirePermission(ctx, 'banking.connect');

  return orgScope(ctx).transaction(async (trx) => {
    const bytes = assertFound(connectionIdBytes(connectionId), RESOURCE);
    const row = assertFound(await selectConnectionById(trx, bytes), RESOURCE);

    await setConnectionActive(trx, bytes, false);
    await setBankAccountFeedSource(trx, row.bank_account_id, 'file');

    return toBankFeedConnection(assertFound(await selectConnectionById(trx, bytes), RESOURCE));
  });
}

/**
 * Opens the provider's own account-linking flow and returns the accounts the credential
 * can already pull — the connect step's picker (D-131). The restricted key here is
 * inbound-only and never persisted by this call: it builds a throwaway provider to ask
 * "what can this credential see," and nothing about the credential is stored until a
 * subsequent `connectBankFeed`. `externalAccountId` is empty because there is no chosen
 * account yet — that is exactly what this call surfaces.
 */
export async function createBankFeedLinkSession(
  input: unknown,
  ctx: RequestContext = getContext('createBankFeedLinkSession()'),
): Promise<BankFeedLinkSession> {
  await requirePermission(ctx, 'banking.connect');
  const request = parseInput(createBankFeedLinkSessionRequestSchema, input);

  const config = getConfig();
  const provider = bankFeedProviderFor(request.feedSource, {
    restrictedKey: request.restrictedKey,
    externalAccountId: '',
    ...(config.appBaseUrl === undefined ? {} : { appBaseUrl: config.appBaseUrl }),
  });

  const linkedAccounts = await provider.listLinkedAccounts();

  // A deterministic secret for the `fake` feed and every provider whose linking flow is
  // a manual-sandbox path (D-102): the browser step is proven by hand, so the value
  // only has to be stable, not a real session token. Stripe FC replaces this with its
  // Financial Connections session secret when that adapter's session call lands.
  return {
    clientSecret: `${request.feedSource}-link-session`,
    linkedAccounts: [...linkedAccounts],
  };
}

/**
 * Everything the sync stream needs off a stored connection: the decrypted
 * `BankFeedProvider`, resolved from the row's own restricted key. Internal to this
 * module — `feed-sync.service.ts` is its only caller — because building a provider from
 * a connection row is this module's concern (it owns `bank_feed_connections` and the
 * secret handles), exactly as `loadConnectionProvider` is for `payments-processing`.
 */
export async function loadConnectionProvider(
  row: ConnectionRow,
  _ctx: RequestContext,
): Promise<BankFeedProvider> {
  const restrictedKey = await secretsProvider().get(row.secret_ref);

  const config = getConfig();
  return bankFeedProviderFor(row.feed_source, {
    restrictedKey,
    externalAccountId: row.external_account_id,
    ...(config.appBaseUrl === undefined ? {} : { appBaseUrl: config.appBaseUrl }),
  });
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

function bankFeedAlreadyConnected(): PreconditionFailedError {
  return new PreconditionFailedError(
    'bank_feed_already_connected',
    'This bank account already has a live feed connection. One feed per bank account is a ' +
      'schema-level constraint (D-126) — a second would mean two credentials racing to explain ' +
      'the same account. Disconnect the existing feed before connecting another.',
  );
}

/**
 * The user a connection is made by. `bank_feed_connections.created_by_user_id` is
 * `NOT NULL` and references `users`, so a caller with no user identity — an automation
 * acting outside a member session — has nothing to record as the human D-131's
 * "the org's admin sets it up" assumes. Mirrors `requireConnectingUser` in
 * `payments-processing/connections.service.ts` for the identical reason.
 */
function requireConnectingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A bank-feed connection is made by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot connect a bank feed. Every credential ' +
          'handed to the secrets provider on this path is a decision somebody made, and this is ' +
          'where it is recorded.',
      },
    ]);
  }
  return userId;
}
