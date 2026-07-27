import type {
  Account,
  AppliedChartTemplate,
  ApplyChartTemplateRequest,
  ChartTemplateSummary,
} from '@openbooks/shared-types';
import { applyChartTemplateRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { uuidToBuffer } from '../../db';
import { ConflictError, InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';
import { nominateControlAccountsIfUnset } from '../settings';
import { createAccount } from './accounts.service';
import { orgScope, selectExistingCodes } from './accounts.repository';
import type { ChartTemplate } from './chart-templates';
import { CHART_TEMPLATES } from './chart-templates';

/**
 * Applying a starter chart of accounts (OB-039, D-23).
 *
 * `chart-templates.ts` holds the charts themselves and the argument for their
 * content; this file is the mechanism, and it has three properties worth stating
 * before the code.
 *
 * **It is opt-in, and nothing calls it implicitly.** D-23 is explicit that a chart
 * arriving uninvited is a chart the user deletes account by account, so no org
 * receives one unless someone asks for this operation by name. That includes org
 * creation: `createOrg` does not reach in here, and wiring it to an opt-in flag at
 * signup is an edit to `modules/orgs/` that this ticket did not own.
 *
 * **It is a copy.** Nothing records which template an org used, and there is no
 * column that could — deliberately, because a stored template id is the beginning of
 * an upgrade path, and D-23 declines to have one. What comes back is a list of
 * ordinary accounts, indistinguishable from hand-created ones a second later.
 *
 * **It writes through `createAccount` and not through a bulk insert.** That is the
 * whole reason the hierarchy rules, the code-uniqueness translation, the permission
 * check and the shared zod schema still apply to a template's contents: there is no
 * second write path, so there is nothing for a template to bypass. A shipped chart
 * is validated by exactly the code that validates a chart someone types in, which is
 * also how a mistake in the template data surfaces as a refusal rather than as rows.
 *
 * The cost is real and it is the right trade. Sixty accounts is a few hundred
 * statements on one connection inside one transaction, where a single
 * multi-row `INSERT` would be one — but that insert would be a second way to write
 * `accounts`, and the reason `openbooks/no-journal-writes` exists one level up is
 * that a second write path skips whatever the first one enforces. This runs once in
 * an org's lifetime, at setup, and it is not on any hot path.
 */

/**
 * The templates on offer, with no reference to any org's data.
 *
 * Gated on `accounts.read` even though the content is a constant and identical for
 * every tenant. The gate is not protecting the list; it is keeping the module's
 * surface uniform, so that "which permission does this need" has the same answer for
 * every operation in `index.ts`'s table and no caller has to learn an exception.
 */
export async function listChartTemplates(
  ctx: RequestContext,
): Promise<readonly ChartTemplateSummary[]> {
  await requirePermission(ctx, 'accounts.read');

  return Object.values(CHART_TEMPLATES).map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    accountCount: template.accounts.length,
  }));
}

/**
 * Copies a template's accounts into the caller's org, all of them or none.
 *
 * ## Applying to an org that already has accounts
 *
 * Permitted, unless a code collides — and then the whole application is refused and
 * every colliding code is named.
 *
 * Refusing any non-empty org was the simpler rule and is the wrong one: an org that
 * created its bank account before finding this operation is exactly the org a
 * starter chart helps, and there is nothing wrong with the request. The real hazard
 * is narrower than "has accounts". It is `uq_accounts_org_code`, and it has teeth: a
 * collision means the org already has *a* `1000` whose type, normal balance, parent
 * and postings this operation knows nothing about.
 *
 * The two alternatives to refusing are both worse. Overwriting would restate
 * accounts that may already carry postings, which is the property `updateAccount`
 * refuses to give up. Skipping the colliding codes would report success while
 * producing a chart that is neither the org's nor the template's — and the accounts
 * it skipped are precisely the ones a subsequent posting is most likely to want,
 * since they are the ones the org already uses. Refusing loses nothing: the caller
 * renames or deletes what collides and asks again, and until they do their chart is
 * exactly what it was.
 *
 * Every collision is reported, not the first. The alternative is a fix-one-and-retry
 * loop whose length the caller cannot see, over an operation that touches sixty rows
 * each time.
 *
 * ## Why the pre-check is not what makes the collision safe
 *
 * Two concurrent applications to the same org both pass the check and then race on
 * the insert. The second gets errno 1062, which `insertAccount` has translated into
 * a `ConflictError` naming the code since OB-018 — so the loser of the race gets a
 * clean 409 rather than a 500, and the transaction below rolls the partial chart
 * back. This is the same shape as `deleteAccount`'s has-postings check: the query is
 * there so the common case produces a good message, and the constraint is what makes
 * the guarantee.
 *
 * ## One transaction
 *
 * A half-applied chart is worse than none — the accounts that landed occupy their
 * codes, so the obvious remedy of re-running is the one thing that now fails. The
 * transaction is opened here rather than per account, and `createAccount`'s own
 * `orgScope(ctx).transaction` joins it ambiently (`src/db/transaction-scope.ts`),
 * which is also why `withIdempotency(spec, () => applyChartTemplate(input, ctx))`
 * composes without this function knowing an outer transaction exists.
 */
export async function applyChartTemplate(
  input: ApplyChartTemplateRequest,
  ctx: RequestContext,
): Promise<AppliedChartTemplate> {
  await requirePermission(ctx, 'accounts.write');
  const request = parseInput(applyChartTemplateRequestSchema, input);

  const template = CHART_TEMPLATES[request.templateId];

  return orgScope(ctx).transaction(async (trx) => {
    const taken = await selectExistingCodes(
      trx,
      template.accounts.map((entry) => entry.code),
    );
    if (taken.length > 0) throw codesAlreadyInUseError(template, taken);

    // Codes to the ids they were just given, so a child resolves its parent without
    // reading anything back. The template's ordering is what makes one pass enough.
    const idsByCode = new Map<string, string>();
    const created: Account[] = [];

    for (const entry of template.accounts) {
      const parentAccountId = resolveParentId(template, entry.parentCode, idsByCode);

      const account = await createAccount(
        {
          code: entry.code,
          name: entry.name,
          type: entry.type,
          normalBalance: entry.normalBalance,
          parentAccountId,
          description: entry.description ?? null,
        },
        ctx,
      );

      idsByCode.set(entry.code, account.id);
      created.push(account);
    }

    await nominateControlAccounts(trx, template, idsByCode);

    return { templateId: template.id, accounts: created };
  });
}

/**
 * Points the org's control accounts at the ones this template just created
 * (OB-066a), unless the org has already nominated its own.
 *
 * This is the path most orgs take, and the reason it exists here is that the
 * alternative is a setup step nobody knows to perform: a template that creates
 * `Accounts receivable` and leaves the setting empty produces an org whose first
 * invoice approval is a `receivable_control_account_not_set`, on a chart that
 * obviously contains the answer.
 *
 * It never overwrites. An org that had already chosen its control accounts and then
 * applied a template would otherwise have its postings silently redirected — which
 * is the failure the nomination exists to remove, arriving from the other
 * direction. The settings module makes that the rule rather than this call site.
 *
 * No permission check of its own: the caller has already been through
 * `accounts.write`, and requiring `orgs.write` in addition would make applying a
 * template need two permissions to describe, so a bookkeeper applying a starter
 * chart would be refused halfway through it.
 */
async function nominateControlAccounts(
  db: TenantDatabase,
  template: ChartTemplate,
  idsByCode: ReadonlyMap<string, string>,
): Promise<void> {
  const { receivable, payable } = template.controlAccountCodes;

  await nominateControlAccountsIfUnset(db, {
    ...(receivable === null ? {} : { receivable: idBytes(template, receivable, idsByCode) }),
    ...(payable === null ? {} : { payable: idBytes(template, payable, idsByCode) }),
  });
}

/**
 * An `InternalError` and not a refusal, on `resolveParentId`'s reasoning: a template
 * naming a control account it does not create is a defect in data this repository
 * ships, and reporting it as the caller's mistake would send someone looking at
 * their request instead of at the file.
 */
function idBytes(
  template: ChartTemplate,
  code: string,
  idsByCode: ReadonlyMap<string, string>,
): Buffer {
  const id = idsByCode.get(code);
  if (id === undefined) {
    throw new InternalError(
      `Chart template ${JSON.stringify(template.id)} names ${JSON.stringify(code)} as a control ` +
        'account, and the template does not create an account with that code.',
    );
  }

  return uuidToBuffer(id);
}

/**
 * An `InternalError` and not a refusal, on the same reasoning as the depth overrun
 * in `hierarchy.ts`: a template naming a parent that is not above it is a defect in
 * data this repository ships, and reporting it as the caller's mistake would send
 * someone looking at their request instead of at the file.
 */
function resolveParentId(
  template: ChartTemplate,
  parentCode: string | null,
  idsByCode: ReadonlyMap<string, string>,
): string | null {
  if (parentCode === null) return null;

  const parentId = idsByCode.get(parentCode);
  if (parentId === undefined) {
    throw new InternalError(
      `Chart template ${JSON.stringify(template.id)} names parent code ` +
        `${JSON.stringify(parentCode)} before defining it. A template's accounts must list ` +
        'every parent ahead of its children.',
    );
  }

  return parentId;
}

/**
 * `ConflictError` and not `PreconditionFailedError`, unlike most refusals in this
 * module.
 *
 * The distinction `accountReferencedError` draws is between a well-formed request
 * the state forbids and a request that is wrong. This one is wrong: it names a
 * template whose codes this org has already used, and the fix is to change the
 * request — pick different accounts, or clear the codes — rather than to wait for
 * the state to change. It is also the same situation `insertAccount`'s 1062
 * translation reports, and one situation should not arrive under two codes depending
 * on whether the pre-check or the constraint caught it.
 *
 * Naming the codes is safe for the reason `translateDuplicateCode` gives: the unique
 * key is `(org_id, code)`, so every code listed belongs to the caller's own org and
 * discloses nothing they cannot already read.
 */
function codesAlreadyInUseError(template: ChartTemplate, taken: readonly string[]): ConflictError {
  const sorted = [...taken].sort();

  return new ConflictError(
    `This organization already uses ${String(sorted.length)} of the account codes in the ` +
      `${JSON.stringify(template.name)} template, so none of it was applied: ` +
      `${sorted.join(', ')}. A template is copied, never merged — an account that already ` +
      'exists is left alone rather than overwritten, and applying the rest would leave a chart ' +
      'that is neither yours nor the template’s. Delete or renumber what collides, or create ' +
      'the remaining accounts individually.',
    { codes: sorted },
  );
}
