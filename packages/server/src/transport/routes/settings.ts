import {
  controlAccountsSchema,
  depreciationAccountsSchema,
  discountAccountsSchema,
  updateControlAccountsRequestSchema,
  updateDepreciationAccountsRequestSchema,
  updateDiscountAccountsRequestSchema,
} from '@openbooks/shared-types';
import type {
  ControlAccounts,
  DepreciationAccounts,
  DiscountAccounts,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  getControlAccounts,
  getDepreciationAccounts,
  getDiscountAccounts,
  updateControlAccounts,
  updateDepreciationAccounts,
  updateDiscountAccounts,
} from '../../modules/settings';
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
 *
 * ## `/v1/settings/discount-accounts` (OB-139, Cash application; D-106, D-107)
 *
 * The early-pay discount nominations, added below as their own path rather than as
 * two more fields on `/v1/accounting-settings` because the ticket that adds them
 * names the path this way; both still live in the one `org_accounting_settings` row
 * `discount-accounts.ts` shares with the control accounts, and both take
 * `orgs.read`/`orgs.write` for exactly this file's reasoning applied twice over
 * (D-107: no new catalog key). `PATCH`, not `PUT`, mirroring `updateControlAccounts`
 * above rather than the literal verb the ticket named: `updateDiscountAccountsRequestSchema`
 * carries the identical absent-vs-`null` three-valued shape — an omitted side is left
 * alone, an explicit `null` clears it, `{}` is refused — and a `PUT` cannot express
 * "change only one side" without forcing a client to restate a value it may not have
 * read, the lost-update shape this file's own header argues against. Neither is
 * refused while a discount already posted to the previous account is outstanding, for
 * the same reason a control-account repoint is not: refusing would strand exactly the
 * org that nominated the wrong account and has already confirmed something.
 *
 * ## `/v1/settings/depreciation-accounts` (OB-167, initiative L; D-115)
 *
 * The org's default depreciation accounts, added below as their own path for the same
 * reason `discount-accounts.ts` got one rather than two more fields on
 * `/v1/accounting-settings`: both nominations live in the one `org_accounting_settings`
 * row `depreciation-accounts.ts` shares with the control and discount accounts, and
 * `depreciation-accounts.ts`'s own header is explicit that this is the same *kind* of
 * setting — mirroring `discount-accounts.ts` verbatim, down to `PATCH`'s absent-vs-`null`
 * three-valued shape (an omitted side is left alone, an explicit `null` clears it, `{}`
 * is refused) and to not refusing while an asset already depends on the previous
 * nomination. The one thing that differs is what the setting is *for*: it is
 * consulted only as a fallback, when a fixed asset's own registration or edit leaves an
 * account unset (`fixed-assets.service.ts`), unlike the control accounts every document
 * uses unconditionally.
 */

const TAG = 'accounting-settings';
const DISCOUNT_TAG = 'discount-accounts';
const DEPRECIATION_TAG = 'depreciation-accounts';

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

  app.get(
    '/v1/settings/discount-accounts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDiscountAccounts',
        summary: 'The org’s early-pay discount-account nominations',
        description:
          'The account an early-pay discount debits when this org gives one to a customer, and ' +
          'the account it credits when a vendor gives one to this org. Either may be null — ' +
          'the two sides are separately usable. Reading this takes `orgs.read` rather than ' +
          '`accounts.read`, mirroring `getControlAccounts`: what is being read is a decision ' +
          'the organization made.',
        tags: [DISCOUNT_TAG],
        response: { 200: discountAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<DiscountAccounts> => getDiscountAccounts(getContext()),
  );

  app.patch(
    '/v1/settings/discount-accounts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDiscountAccounts',
        summary: 'Nominate, repoint or clear a discount account',
        description:
          'An omitted side is left as it is; an explicit `null` clears it. A nomination must ' +
          'be an active account of the right kind — an expense account for the given side, a ' +
          'revenue account for the received side — refused with ' +
          '`discount_given_account_wrong_type`, `discount_received_account_wrong_type` or ' +
          '`account_inactive`. Both nominations land in one transaction. Changing one moves ' +
          'future discounts only: a discount already posted names the account it posted to and ' +
          'is never restated.',
        tags: [DISCOUNT_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: updateDiscountAccountsRequestSchema,
        response: { 200: discountAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'updateDiscountAccounts', request: request.body, successStatus: 200 },
        () => updateDiscountAccounts(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DiscountAccounts>(result));
    },
  );

  app.get(
    '/v1/settings/depreciation-accounts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDepreciationAccounts',
        summary: 'The org’s default depreciation-account nominations',
        description:
          'The account each posted depreciation period debits by default, and the account it ' +
          'credits, consulted only when a fixed asset does not nominate its own at registration ' +
          '(D-115). Either may be null — the two sides are separately usable. Reading this takes ' +
          '`orgs.read` rather than `fixed_assets.read`, mirroring `getDiscountAccounts`: what is ' +
          'being read is a decision the organization made.',
        tags: [DEPRECIATION_TAG],
        response: { 200: depreciationAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<DepreciationAccounts> => getDepreciationAccounts(getContext()),
  );

  app.patch(
    '/v1/settings/depreciation-accounts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDepreciationAccounts',
        summary: 'Nominate, repoint or clear a default depreciation account',
        description:
          'An omitted side is left as it is; an explicit `null` clears it. A nomination must be ' +
          'an active account of the right kind — an expense account for the debited side, an ' +
          'asset account for the credited side — refused with ' +
          '`depreciation_expense_account_wrong_type`, ' +
          '`accumulated_depreciation_account_wrong_type` or `account_inactive`. Both nominations ' +
          'land in one transaction. Changing a default reaches only assets registered after the ' +
          'change: an asset already registered stored the concrete account it resolved at ' +
          'registration, not "the default", so there is no way to ask whether an existing asset ' +
          'depends on the previous nomination and, mirroring `updateDiscountAccounts`, this is ' +
          'not refused while one might.',
        tags: [DEPRECIATION_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: updateDepreciationAccountsRequestSchema,
        response: { 200: depreciationAccountsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'updateDepreciationAccounts', request: request.body, successStatus: 200 },
        () => updateDepreciationAccounts(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DepreciationAccounts>(result));
    },
  );
}
