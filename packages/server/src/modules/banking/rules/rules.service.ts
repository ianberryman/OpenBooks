import type {
  BankRule,
  BankRuleCondition,
  BankRuleOutcome,
  BankRulePage,
  CreateBankRuleRequest,
  ListBankRulesQuery,
  UpdateBankRuleRequest,
} from '@openbooks/shared-types';
import {
  createBankRuleRequestSchema,
  listBankRulesQuerySchema,
  updateBankRuleRequestSchema,
} from '@openbooks/shared-types';

import { getContext, type RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput, ValidationError } from '../../../errors';
import type { ResolvedLineTag } from '../../dimensions';
import { resolveTagsForNewLine } from '../../dimensions';
import { requirePermission } from '../../permissions';

import {
  ACCOUNT_RESOURCE,
  BANK_ACCOUNT_RESOURCE,
  BANK_RULE_RESOURCE as RESOURCE,
  CONTACT_RESOURCE,
  deleteRuleDimensions,
  insertRule,
  insertRuleDimensions,
  nextPriority,
  orgScope,
  type NewRuleColumns,
  type RuleFilters,
  type RulePatch,
  ruleIdBytes,
  selectAccount,
  selectBankAccount,
  selectContact,
  selectRuleByIdOrThrow,
  selectRuleDimensions,
  selectRuleDimensionsFor,
  selectRuleById,
  selectRulesPage,
  toBankRule,
  updateRuleRow,
} from './rules.repository';

/**
 * Bank rules — a deterministic classification lookup (OB-080; ROADMAP D-44,
 * acceptance E8/E9).
 *
 * A rule matches on a line's description, amount and direction and proposes an
 * account, a contact and dimension tags. It is not a workflow: the outcome has three
 * fields and none of them is a verb, and M6 owns the day a fourth that *does*
 * something is wanted (D-44). This module maintains rules; the evaluator that applies
 * them to a page of lines is `evaluator.ts`, and the match engine that consumes both
 * is OB-079.
 *
 * Three things are uniform across every operation, stated once here:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else. Enforcement is service-layer
 *    only (spec §2.4, §5) — there are no routes yet (OB-084), so this parse is at
 *    present the only parse (spec §12).
 *
 * 2. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has already
 *    confined every read to the context's org, so a cross-org id returns no row and
 *    reaches the same line a nonexistent id reaches — 404, never 403, byte-identical
 *    to a read of something that never existed (E9). This covers the rule itself and
 *    every reference it names: the ledger account, the contact, the bank account, and
 *    the dimension values (through `resolveTagsForNewLine`).
 *
 * 3. **The permission is banking's.** `banking.read` sees rules; `banking.match`
 *    creates and edits them, because a rule authors how a line is matched, which is
 *    what that code governs ("Match and split bank transactions"). `banking.match` is
 *    latent until this service — it takes it live, exactly as OB-078 took
 *    `banking.import` live. There is no `banking.rules` code and inventing one is not
 *    this ticket's to do (the permission matrix is reconciled once, elsewhere).
 *
 * ## A rule change never reaches backwards (E8)
 *
 * There is no "re-run rules over existing lines" operation here, and adding one is
 * out of scope by decision, not omission: a rule acts only when a line is evaluated
 * for proposals (D-44, and the schema's own header). Editing or deactivating a rule
 * touches no posted entry and no existing line — `updateBankRule` writes only the
 * `bank_rules` row and its tag table, never a clearing, a proposal, or a journal.
 * Deactivating is a state change on the rule that simply stops it proposing; it is
 * not a delete, so the record of why a line was once coded a certain way survives.
 */

/**
 * The four predicates the database's `chk_bank_rules_has_condition` counts.
 *
 * `bankRuleConditionSchema`'s refinement rejects a condition where *every* field is
 * absent, but it counts `bankAccountId` among them — so a condition that names only a
 * bank account passes Zod and then violates the CHECK, which lists only these four
 * and not `bank_account_id` (`0006_banking`). A scope with no predicate still matches
 * every line on the account, which is the footgun the CHECK exists to refuse. This
 * mirrors the CHECK one layer up so the refusal is a `validation_failed` at save
 * time rather than a driver error surfacing as a 500. See the report note on the
 * schema/CHECK seam.
 */
function assertMeaningfulCondition(condition: BankRuleCondition): void {
  const hasPredicate =
    (condition.description !== undefined && condition.description !== null) ||
    (condition.direction !== undefined && condition.direction !== null) ||
    (condition.amountMin !== undefined && condition.amountMin !== null) ||
    (condition.amountMax !== undefined && condition.amountMax !== null);

  if (!hasPredicate) {
    throw new ValidationError('A rule must match on something.', [
      {
        path: 'condition',
        message:
          'Add a description, a direction, or an amount bound. A rule scoped to a bank account ' +
          'but with no other condition matches every line on that account.',
      },
    ]);
  }
}

/**
 * Resolves the references a condition names to bytes, 404ing on any that do not exist
 * in the caller's org. Only `bankAccountId` is a reference here; the rest are values.
 */
async function conditionColumns(
  db: TenantDatabase,
  condition: BankRuleCondition,
): Promise<
  Pick<
    NewRuleColumns,
    | 'bankAccountId'
    | 'matchDescription'
    | 'matchDescriptionMode'
    | 'matchDirection'
    | 'matchAmountMin'
    | 'matchAmountMax'
  >
> {
  let bankAccountId: Buffer | null = null;
  if (condition.bankAccountId !== undefined && condition.bankAccountId !== null) {
    bankAccountId = assertFound(tryUuidToBuffer(condition.bankAccountId), BANK_ACCOUNT_RESOURCE);
    assertFound(await selectBankAccount(db, bankAccountId), BANK_ACCOUNT_RESOURCE);
  }

  const description = condition.description ?? null;
  return {
    bankAccountId,
    matchDescription: description === null ? null : description.value,
    matchDescriptionMode: description === null ? null : description.mode,
    matchDirection: condition.direction ?? null,
    matchAmountMin:
      condition.amountMin === undefined || condition.amountMin === null
        ? null
        : BigInt(condition.amountMin),
    matchAmountMax:
      condition.amountMax === undefined || condition.amountMax === null
        ? null
        : BigInt(condition.amountMax),
  };
}

/**
 * Resolves an outcome's account and contact to bytes and its dimension values to
 * tags, 404ing on any cross-org or missing reference (E9).
 *
 * The dimension values go through `resolveTagsForNewLine`, the dimensions module's
 * own resolver for "tags on a thing being created": it 404s an unknown or cross-org
 * value, refuses an archived one, and refuses two values on one axis — the same
 * refusals a posted line's tags get, because a rule that proposed a tag a posting
 * would reject is a rule proposing something unacceptable. It resolves without
 * writing, and returns the `(dimensionId, dimensionValueId)` pairs the tag table's
 * three-column key needs, which is why the tags are never a JSON blob.
 */
async function outcomeColumns(
  db: TenantDatabase,
  outcome: BankRuleOutcome,
): Promise<{
  readonly setAccountId: Buffer;
  readonly setContactId: Buffer | null;
  readonly tags: readonly ResolvedLineTag[];
}> {
  const setAccountId = assertFound(tryUuidToBuffer(outcome.accountId), ACCOUNT_RESOURCE);
  assertFound(await selectAccount(db, setAccountId), ACCOUNT_RESOURCE);

  let setContactId: Buffer | null = null;
  if (outcome.contactId !== undefined && outcome.contactId !== null) {
    setContactId = assertFound(tryUuidToBuffer(outcome.contactId), CONTACT_RESOURCE);
    assertFound(await selectContact(db, setContactId), CONTACT_RESOURCE);
  }

  const tags = await resolveTagsForNewLine(outcome.dimensionValueIds ?? [], db);
  return { setAccountId, setContactId, tags };
}

async function readRule(db: TenantDatabase, id: Buffer): Promise<BankRule> {
  const row = await selectRuleByIdOrThrow(db, id);
  const dims = await selectRuleDimensions(db, id);
  return toBankRule(
    row,
    dims.map((dim) => dim.dimension_value_id),
  );
}

/**
 * Creates a rule. The whole thing is one transaction: the references are resolved and
 * the rule and its tags are written together or not at all, so a rule can never
 * commit with a tag it could not resolve, and a resolution refusal (a 404, an
 * archived value) rolls back before any row exists.
 *
 * The condition and outcome are resolved *before* the priority is taken, so a bad
 * reference is a clean 404 rather than a rule that reserved a priority and then
 * failed. An omitted priority becomes one past the org's current maximum, so a new
 * rule never silently pre-empts an old one (`createBankRuleRequestSchema`).
 */
export async function createBankRule(
  input: CreateBankRuleRequest,
  ctx: RequestContext = getContext('createBankRule()'),
): Promise<BankRule> {
  await requirePermission(ctx, 'banking.match');
  const request = parseInput(createBankRuleRequestSchema, input);
  assertMeaningfulCondition(request.condition);

  return orgScope(ctx).transaction(async (trx) => {
    const condition = await conditionColumns(trx, request.condition);
    const outcome = await outcomeColumns(trx, request.outcome);
    const priority = request.priority ?? (await nextPriority(trx));

    const id = await insertRule(trx, {
      ...condition,
      name: request.name,
      priority,
      setAccountId: outcome.setAccountId,
      setContactId: outcome.setContactId,
    });
    await insertRuleDimensions(trx, id, outcome.tags);

    return readRule(trx, id);
  });
}

export async function getBankRule(
  ruleId: string,
  ctx: RequestContext = getContext('getBankRule()'),
): Promise<BankRule> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const id = assertFound(ruleIdBytes(ruleId), RESOURCE);
  const row = assertFound(await selectRuleById(db, id), RESOURCE);
  const dims = await selectRuleDimensions(db, id);
  return toBankRule(
    row,
    dims.map((dim) => dim.dimension_value_id),
  );
}

/**
 * One page of the org's rules in evaluation order, `(priority, created_at, id)`.
 *
 * A malformed `bankAccountId` filter answers with an empty page rather than a 404,
 * matching `listBankImportMappings`: an id that resolves to nothing filters to
 * nothing, and an empty page keeps a filter's failure mode uniform (E9). The tags are
 * read once for the whole page rather than per rule.
 */
export async function listBankRules(
  query: ListBankRulesQuery,
  ctx: RequestContext = getContext('listBankRules()'),
): Promise<BankRulePage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankRulesQuerySchema, query);

  if (filters.bankAccountId !== undefined && tryUuidToBuffer(filters.bankAccountId) === undefined) {
    return { items: [], nextCursor: null };
  }

  const db = orgScope(ctx);
  const ruleFilters: RuleFilters = {
    ...(filters.isActive === undefined ? {} : { isActive: filters.isActive }),
    ...(filters.bankAccountId === undefined
      ? {}
      : { bankAccountId: tryUuidToBuffer(filters.bankAccountId) }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  };

  const limit = resolvePageLimit(filters.limit);
  const page = await selectRulesPage(db, ruleFilters, limit);
  if (page.rows.length === 0) return { items: [], nextCursor: page.nextCursor };

  const dims = await selectRuleDimensionsFor(
    db,
    page.rows.map((row) => row.id),
  );
  const items = page.rows.map((row) => toBankRule(row, dims.get(row.id.toString('hex')) ?? []));
  return { items, nextCursor: page.nextCursor };
}

/**
 * Updates a rule. `condition` and `outcome` are each replaced whole, never patched,
 * for `updateBankRuleRequestSchema`'s reason: a condition's fields are interdependent
 * (at least one predicate must be present), so a field-at-a-time patch could reach an
 * empty condition. Whichever of the two is supplied is re-resolved and rewritten; the
 * other is left exactly as it was, and its tags with it.
 *
 * Deactivating (`isActive: false`) is an ordinary field here. It refuses nothing and
 * cascades to nothing — it stops the rule proposing and touches no posted entry,
 * which is E8 restated. Nothing here reaches an existing line or a clearing.
 */
export async function updateBankRule(
  ruleId: string,
  input: UpdateBankRuleRequest,
  ctx: RequestContext = getContext('updateBankRule()'),
): Promise<BankRule> {
  await requirePermission(ctx, 'banking.match');
  const request = parseInput(updateBankRuleRequestSchema, input);
  if (request.condition !== undefined) assertMeaningfulCondition(request.condition);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(ruleIdBytes(ruleId), RESOURCE);
    assertFound(await selectRuleById(trx, id), RESOURCE);

    const conditionPatch: RulePatch =
      request.condition === undefined ? {} : await conditionColumns(trx, request.condition);

    let outcomePatch: RulePatch = {};
    if (request.outcome !== undefined) {
      const outcome = await outcomeColumns(trx, request.outcome);
      outcomePatch = { setAccountId: outcome.setAccountId, setContactId: outcome.setContactId };
      // The outcome is replaced whole, so its tags are too: clear the old set and
      // write the new one (possibly empty). Leaving the old tags would make a partial
      // edit of the outcome, which the whole-replacement contract refuses.
      await deleteRuleDimensions(trx, id);
      await insertRuleDimensions(trx, id, outcome.tags);
    }

    const patch: RulePatch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
      ...conditionPatch,
      ...outcomePatch,
    };

    await updateRuleRow(trx, id, patch);
    return readRule(trx, id);
  });
}
