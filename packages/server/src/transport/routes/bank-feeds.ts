import {
  bankFeedConnectionPageSchema,
  bankFeedConnectionSchema,
  bankFeedLinkSessionSchema,
  bankFeedSyncResultSchema,
  connectBankFeedRequestSchema,
  createBankFeedLinkSessionRequestSchema,
  pageCursorSchema,
} from '@openbooks/shared-types';
import type {
  BankFeedConnection,
  BankFeedConnectionPage,
  BankFeedLinkSession,
  BankFeedSyncResult,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  connectBankFeed,
  createBankFeedLinkSession,
  deactivateBankFeed,
  getBankFeed,
  listBankFeeds,
  syncBankFeed,
} from '../../modules/bank-feeds';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/bank-feeds` — an org's own live-feed connections (OB-227; ROADMAP
 * D-126…D-131).
 *
 * An org wires its own Stripe Financial Connections credential to a bank account
 * (D-46) and a daily job pulls transactions into the existing statement-line → match
 * → reconcile pipeline. These routes open a link session, connect a feed, read the
 * connections back, run a sync on demand, and take a connection out of circulation.
 * Handlers map arguments and hold no logic (spec §2.4): `bank-feeds.service.ts` is
 * everything — the account nomination check, the secrets-provider write (D-101), the
 * one-feed-per-bank-account precondition, and D-83's guarantee that `restrictedKey`
 * never comes back out.
 *
 * The permissions the service enforces and this file only documents (spec §5):
 * `banking.connect` for the three writes that change what a feed is
 * (`connectBankFeed`, `deactivateBankFeed`, `createBankFeedLinkSession`),
 * `banking.import` for `syncBankFeed` (it pulls lines, the same privilege a CSV
 * import takes), and `banking.read` for the two reads.
 *
 * ## Why sync and deactivate are their own routes
 *
 * The shape `deactivateProcessorConnection`/`deactivateAccount` argue for: idempotency
 * matters (a retried deactivate must return the connection unchanged rather than fail
 * on the state it was reaching), and a `PATCH { isActive }` would be a second way to
 * reach the identical transition with no `Idempotency-Key` semantics of its own.
 * `syncBankFeed` returns a `BankFeedSyncResult` rather than the connection because a
 * sync is an action with its own effect (lines imported, lines deduped) to report, and
 * a retried call with the same key replays that one run's result rather than pulling
 * again — `runAutomation`'s own shape one surface over.
 */

const TAG = 'bank-feeds';

const bankFeedParamsSchema = z.strictObject({ bankFeedId: z.uuid() });

/**
 * Local and carrying no `id`: a querystring is emitted as individual `parameters`.
 * `isActive` is a coerced `stringbool` here though the shared schema takes a real
 * boolean, `listBankAccountsWireQuerySchema`'s reason: `'false'` is truthy in every
 * language an integrator might use, so the wire layer is the one place that knows how
 * the value arrived.
 */
const listBankFeedsWireQuerySchema = z.strictObject({
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`). Omitted matches active and ' +
        'inactive connections alike.',
    }),
  limit: pageLimitQuery('bank-feed connections'),
  cursor: pageCursorSchema.optional(),
});

export function registerBankFeedRoutes(app: App): void {
  app.post(
    '/v1/bank-feeds',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'connectBankFeed',
        summary: 'Connect a live bank feed',
        description:
          'Wires a live feed to an existing bank account (D-126). `bankAccountId` names a bank ' +
          'account the org already has — a `404` if it does not — and `externalAccountId` is the ' +
          'linked account chosen from a link session. `restrictedKey` is inbound-only: it is ' +
          'stored through the secrets provider (D-101) and never appears in this response or any ' +
          'later read (D-83). Connecting flips the bank account to this feed source, and there ' +
          'is one live feed per bank account.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: connectBankFeedRequestSchema,
        response: { 201: bankFeedConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'connectBankFeed', request: request.body, successStatus: 201 },
        () => connectBankFeed(request.body, ctx),
      );

      const connection = idempotentBody<BankFeedConnection>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/bank-feeds/${connection.id}`)
        .send(connection);
    },
  );

  app.get(
    '/v1/bank-feeds',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBankFeeds',
        summary: 'List live bank feeds',
        description: 'One page, oldest first by creation (D-21).',
        tags: [TAG],
        querystring: listBankFeedsWireQuerySchema,
        response: { 200: bankFeedConnectionPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankFeedConnectionPage> => {
      const { isActive, limit, cursor } = request.query;
      return listBankFeeds(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bank-feeds/:bankFeedId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBankFeed',
        summary: 'One live bank feed',
        tags: [TAG],
        params: bankFeedParamsSchema,
        response: { 200: bankFeedConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankFeedConnection> =>
      getBankFeed(request.params.bankFeedId, getContext()),
  );

  app.post(
    '/v1/bank-feeds/:bankFeedId/sync',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'syncBankFeed',
        summary: 'Pull the latest transactions from a live bank feed',
        description:
          'Runs a sync now rather than waiting for the daily job (D-128): it pulls from the ' +
          'connection’s cursor and folds the result into the same fingerprint dedup the CSV path ' +
          'uses (D-127), so a re-synced overlap is `linesDuplicate`, never a double-post. Returns ' +
          'the run’s outcome, not the connection; a retried call with the same key replays that ' +
          'one run rather than pulling again.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: bankFeedParamsSchema,
        response: { 200: bankFeedSyncResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { bankFeedId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'syncBankFeed', request: { bankFeedId }, successStatus: 200 },
        () => syncBankFeed(bankFeedId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankFeedSyncResult>(result));
    },
  );

  app.post(
    '/v1/bank-feeds/:bankFeedId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateBankFeed',
        summary: 'Disconnect a live bank feed',
        description:
          'Stops the daily sync from pulling and reverts the bank account to `file`; every line ' +
          'already imported stays exactly as posted. Disconnecting is deactivation, not deletion ' +
          '(D-129). Idempotent: an already-inactive connection is returned unchanged rather than ' +
          'refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: bankFeedParamsSchema,
        response: { 200: bankFeedConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { bankFeedId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deactivateBankFeed', request: { bankFeedId }, successStatus: 200 },
        () => deactivateBankFeed(bankFeedId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankFeedConnection>(result));
    },
  );

  app.post(
    '/v1/bank-feeds/link-sessions',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createBankFeedLinkSession',
        summary: 'Open a provider link session',
        description:
          'Opens a provider link session so the browser can run the credential’s own ' +
          'account-linking flow, and returns the accounts it can already pull — the connect ' +
          'step’s picker (D-131). `restrictedKey` is inbound-only (D-83). For the `fake` feed ' +
          'both the session secret and the accounts are deterministic (D-102).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createBankFeedLinkSessionRequestSchema,
        response: { 200: bankFeedLinkSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createBankFeedLinkSession', request: request.body, successStatus: 200 },
        () => createBankFeedLinkSession(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankFeedLinkSession>(result));
    },
  );
}
