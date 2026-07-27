import { controlAccountsSchema, updateControlAccountsRequestSchema } from '@openbooks/shared-types';
import type { ControlAccounts } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { getControlAccounts, updateControlAccounts } from '../../modules/settings';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/accounting-settings` — the org's control-account nominations (OB-067, for
 * OB-066a; ROADMAP D-23, D-34, D-40).
 *
 * ## A singleton, and the path names the setting rather than what it currently holds
 *
 * There is one of these per org and it is reached without naming the org, exactly as
 * `/v1/accounts` is: every org-scoped path on this surface is implicitly the active
 * org's, and adding `/v1/orgs/{orgId}/…` here would put an org id in a path where
 * spec §4 has spent the whole system keeping it out of parameters.
 *
 * The path is `accounting-settings` and not `control-accounts` because the resource
 * is the org's accounting settings and the two nominations are what it holds today;
 * a later setting has somewhere to go that is not a new endpoint. The operation ids
 * stay `getControlAccounts` and `updateControlAccounts`, matching the service
 * function names as every other operation on this surface does — the path names the
 * resource, the operation names what it reads.
 *
 * ## `PATCH`, and the three-valued field that is the reason
 *
 * `PATCH` and not `PUT`, and here the distinction between *absent* and *`null`* is
 * load-bearing in a way it is not in most patches in this API:
 *
 *  - `{ "receivableControlAccountId": "…" }` sets the receivable side and **leaves
 *    the payable one alone**.
 *  - `{ "payableControlAccountId": null }` **clears** the payable nomination.
 *  - `{}` is refused — supply at least one field to change.
 *
 * Collapsing the two would make "set only the receivable one" inexpressible without
 * restating a value the caller may not have read, which is the lost-update shape
 * every partial update exists to avoid. On the wire the distinction survives because
 * `updateControlAccountsRequestSchema` is `z.uuid().nullable().optional()` on each
 * side — `nullable` and `optional` separately, so the published schema carries both
 * a `null` member and a missing-property reading, and the server can tell them
 * apart. A `PUT` would have had to choose: either refuse a body that omitted a side,
 * or clear it.
 *
 * ## What a change means, which the description has to carry
 *
 * It moves **future** postings and cannot restate a past one — a journal names its
 * accounts by id and the app user holds no `UPDATE` on `journals` (spec §12). The
 * consequence worth telling a client about is that while documents posted to the
 * previous account are still outstanding, what the subledger owes is spread across
 * two accounts and neither alone ties to the aging total. It reconverges as those
 * documents settle. So this is a setup act, not a way to reorganize a chart already
 * in use; for that the answer is a journal moving the balance.
 *
 * The operation is deliberately *not* refused when postings exist. Refusing would
 * strand exactly the org this setting exists for — one that nominated the wrong
 * account and has already approved something — with no way to correct it at all.
 *
 * The write takes `orgs.write` rather than `accounts.write`, which is the service's
 * decision and not this route's: the role that enters documents is not the role that
 * decides the shape of the books.
 */

const TAG = 'accounting-settings';

export function registerSettingsRoutes(app: App): void {
  app.get(
    '/v1/accounting-settings',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getControlAccounts',
        summary: 'The org’s control-account nominations',
        description:
          'Which of the org’s own accounts an approved invoice debits and an approved bill ' +
          'credits. Either may be null — the two sides are separately usable, and an org that ' +
          'only invoices never needs a payables control account. Reading this takes `orgs.read` ' +
          'rather than `accounts.read`: what is being read is a decision the organization made, ' +
          'and it is the field a client needs in order to explain a refused approval.',
        tags: [TAG],
        response: { 200: controlAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<ControlAccounts> => getControlAccounts(getContext()),
  );

  app.patch(
    '/v1/accounting-settings',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateControlAccounts',
        summary: 'Nominate, repoint or clear a control account',
        description:
          'An omitted side is left as it is; an explicit `null` clears it. A nomination must be ' +
          'an active account of the right kind — an asset for receivables, a liability for ' +
          'payables — refused with `receivable_control_account_wrong_type`, ' +
          '`payable_control_account_wrong_type` or `account_inactive`, because a misnominated ' +
          'control account is invisible until a year end and cannot be undone by editing ' +
          'anything. Both nominations land in one transaction. Changing one moves future ' +
          'postings only: journals already posted name the account they were posted to and are ' +
          'never restated, so while documents on the previous account are outstanding the ' +
          'subledger ties to the two accounts together.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: updateControlAccountsRequestSchema,
        response: { 200: controlAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'updateControlAccounts', request: request.body, successStatus: 200 },
        () => updateControlAccounts(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ControlAccounts>(result));
    },
  );
}
