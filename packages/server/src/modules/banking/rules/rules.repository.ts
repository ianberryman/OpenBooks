import type { BankRule, BankRuleCondition, BankRuleMatchMode } from '@openbooks/shared-types';
import { BANKING_RESOURCES } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetColumn, KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  isDuplicateEntryError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../../db';
import { ConflictError, InternalError, ValidationError } from '../../../errors';
import type { ResolvedLineTag } from '../../dimensions';

/**
 * Data access for bank rules and their dimension tags (OB-080; ROADMAP D-44).
 *
 * Everything here goes through `tenantDb`, so `bank_rules.org_id = ?` is on every
 * statement before this file adds a predicate — a cross-org id is a miss rather than
 * a leak (E9/A7), with `assertFound` in the service turning the miss into the one
 * error it is allowed to produce.
 *
 * The two client-facing driver errors are caught here rather than left to reach the
 * transport as opaque 500s: a duplicate name for the org
 * (`uq_bank_rules_org_name`, errno 1062) becomes a `ConflictError`, and a bad cursor
 * on the priority column becomes a `ValidationError`. Everything else is rethrown
 * untouched — this file knows about exactly those two constraints and must not guess.
 */

/** The resource tokens every miss in this module reports (E9). */
export const BANK_RULE_RESOURCE = BANKING_RESOURCES.BANK_RULE;
export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;
export const ACCOUNT_RESOURCE = 'account';
export const CONTACT_RESOURCE = 'contact';

/**
 * A new rule whose omitted priority sorts after every existing one starts here.
 *
 * `createBankRuleRequestSchema` says an omitted priority "defaults to the end of the
 * list, so a new rule cannot silently pre-empt an old one" — `nextPriority` computes
 * `max + 1`, and this is the value the first rule in an org gets, matching the column
 * default in `0006_banking`. Starting at 100 rather than 0 leaves room below for a
 * rule a user deliberately wants to run first.
 */
const APPEND_PRIORITY_BASE = 100;

const RULE_COLUMNS = [
  'id',
  'bank_account_id',
  'name',
  'priority',
  'match_description',
  'match_description_mode',
  'match_direction',
  'match_amount_min_minor',
  'match_amount_max_minor',
  'set_account_id',
  'set_contact_id',
  'is_active',
  'created_at',
  'updated_at',
] as const;

export interface RuleRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer | null;
  readonly name: string;
  readonly priority: number;
  readonly match_description: string | null;
  readonly match_description_mode: BankRuleMatchMode | null;
  readonly match_direction: 'inbound' | 'outbound' | null;
  readonly match_amount_min_minor: bigint | null;
  readonly match_amount_max_minor: bigint | null;
  readonly set_account_id: Buffer;
  readonly set_contact_id: Buffer | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The columns of a rule the condition is built from, minus the id, for the insert. */
export interface NewRuleColumns {
  readonly bankAccountId: Buffer | null;
  readonly name: string;
  readonly priority: number;
  readonly matchDescription: string | null;
  readonly matchDescriptionMode: BankRuleMatchMode | null;
  readonly matchDirection: 'inbound' | 'outbound' | null;
  readonly matchAmountMin: bigint | null;
  readonly matchAmountMax: bigint | null;
  readonly setAccountId: Buffer;
  readonly setContactId: Buffer | null;
}

/** The subset of a rule an update replaces; `undefined` means "leave as it is". */
export interface RulePatch {
  readonly name?: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly bankAccountId?: Buffer | null;
  readonly matchDescription?: string | null;
  readonly matchDescriptionMode?: BankRuleMatchMode | null;
  readonly matchDirection?: 'inbound' | 'outbound' | null;
  readonly matchAmountMin?: bigint | null;
  readonly matchAmountMax?: bigint | null;
  readonly setAccountId?: Buffer;
  readonly setContactId?: Buffer | null;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied rule id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (E9/A7).
 */
export function ruleIdBytes(ruleId: string): Buffer | undefined {
  return tryUuidToBuffer(ruleId);
}

export function newRuleId(): Buffer {
  return newUuidBuffer();
}

/**
 * The bank account, ledger account, or contact if it exists in this org, else
 * `undefined`.
 *
 * A rule references all three, and the service checks each before the insert so an
 * unknown or cross-org reference is a 404 (E9) rather than the foreign key surfacing
 * errno 1452 as an opaque 500. Org-scoped, so another org's row is indistinguishable
 * from a missing one. Dimension values are resolved through `resolveTagsForNewLine`,
 * which does the same for the tag table's three-column key.
 */
export async function selectBankAccount(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly id: Buffer } | undefined> {
  return db.selectFrom('bank_accounts').select('id').where('id', '=', id).executeTakeFirst();
}

export async function selectAccount(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly id: Buffer } | undefined> {
  return db.selectFrom('accounts').select('id').where('id', '=', id).executeTakeFirst();
}

export async function selectContact(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly id: Buffer } | undefined> {
  return db.selectFrom('contacts').select('id').where('id', '=', id).executeTakeFirst();
}

/**
 * The priority a new rule gets when the request omits one: one past the org's
 * current maximum, so it sorts after every existing rule in `(priority, created_at,
 * id)` order and pre-empts none of them (`createBankRuleRequestSchema`).
 *
 * No lock. Two concurrent creates that both read the same maximum land on the same
 * priority, and `(created_at, id)` still totally orders them — both after every
 * existing rule, which is the property the default exists to guarantee. Serializing
 * every create to make the number unique would buy nothing determinism does not
 * already have.
 */
export async function nextPriority(db: TenantDatabase): Promise<number> {
  const row = await db
    .selectFrom('bank_rules')
    .select((eb) => eb.fn.max('priority').as('max'))
    .executeTakeFirst();

  const max = row?.max ?? null;
  return max === null ? APPEND_PRIORITY_BASE : Number(max) + 1;
}

export async function insertRule(db: TenantDatabase, columns: NewRuleColumns): Promise<Buffer> {
  const id = newRuleId();

  try {
    await db
      .insertInto('bank_rules')
      .values({
        id,
        bank_account_id: columns.bankAccountId,
        name: columns.name,
        priority: columns.priority,
        match_description: columns.matchDescription,
        match_description_mode: columns.matchDescriptionMode,
        match_direction: columns.matchDirection,
        match_amount_min_minor: columns.matchAmountMin,
        match_amount_max_minor: columns.matchAmountMax,
        set_account_id: columns.setAccountId,
        set_contact_id: columns.setContactId,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, columns.name);
  }

  return id;
}

export async function updateRuleRow(
  db: TenantDatabase,
  id: Buffer,
  patch: RulePatch,
): Promise<void> {
  try {
    await db
      .updateTable('bank_rules')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
        ...(patch.bankAccountId === undefined ? {} : { bank_account_id: patch.bankAccountId }),
        ...(patch.matchDescription === undefined
          ? {}
          : { match_description: patch.matchDescription }),
        ...(patch.matchDescriptionMode === undefined
          ? {}
          : { match_description_mode: patch.matchDescriptionMode }),
        ...(patch.matchDirection === undefined ? {} : { match_direction: patch.matchDirection }),
        ...(patch.matchAmountMin === undefined
          ? {}
          : { match_amount_min_minor: patch.matchAmountMin }),
        ...(patch.matchAmountMax === undefined
          ? {}
          : { match_amount_max_minor: patch.matchAmountMax }),
        ...(patch.setAccountId === undefined ? {} : { set_account_id: patch.setAccountId }),
        ...(patch.setContactId === undefined ? {} : { set_contact_id: patch.setContactId }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, patch.name ?? '');
  }

  // The affected-row count is deliberately not consulted, for `updatePaymentRow`'s
  // reason: mysql2 does not set `CLIENT_FOUND_ROWS`, so an UPDATE that changes
  // nothing reports zero affected rows exactly like one that matched nothing.
  // Existence is established by the caller's prior `assertFound` read.
}

export async function selectRuleById(db: TenantDatabase, id: Buffer): Promise<RuleRow | undefined> {
  return db.selectFrom('bank_rules').select(RULE_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/**
 * Reads a rule back after a write inside the writing transaction, throwing rather
 * than returning `undefined` — the row was just inserted or updated by this
 * transaction, so its absence is a fault, not a client situation (`readBack` in
 * `posting.service.ts`).
 */
export async function selectRuleByIdOrThrow(db: TenantDatabase, id: Buffer): Promise<RuleRow> {
  const row = await selectRuleById(db, id);
  if (row === undefined) {
    throw new InternalError('The bank rule written by this transaction could not be read back.');
  }
  return row;
}

// ---------------------------------------------------------------------------
// The dimension tags a rule sets (bank_rule_dimensions)
// ---------------------------------------------------------------------------

export interface RuleDimensionRow {
  readonly dimension_id: Buffer;
  readonly dimension_value_id: Buffer;
}

/**
 * Every tag on one rule, ordered by axis so the wire array is deterministic.
 *
 * A rule carries at most one value per axis (`bank_rule_dimensions`' primary key is
 * `(org_id, bank_rule_id, dimension_id)`), so ordering by `dimension_id` totally
 * orders the set — two reads of one rule return its `dimensionValueIds` in the same
 * order, which is what a deterministic outcome (D-44) needs even in a field whose
 * order carries no meaning.
 */
export async function selectRuleDimensions(
  db: TenantDatabase,
  ruleId: Buffer,
): Promise<readonly RuleDimensionRow[]> {
  return db
    .selectFrom('bank_rule_dimensions')
    .select(['dimension_id', 'dimension_value_id'])
    .where('bank_rule_id', '=', ruleId)
    .orderBy('dimension_id')
    .execute();
}

/**
 * The tags of many rules at once, grouped by rule — the evaluator's single read for
 * a page's worth of active rules (E10), rather than one query per rule.
 */
export async function selectRuleDimensionsFor(
  db: TenantDatabase,
  ruleIds: readonly Buffer[],
): Promise<ReadonlyMap<string, readonly Buffer[]>> {
  const grouped = new Map<string, Buffer[]>();
  if (ruleIds.length === 0) return grouped;

  const rows = await db
    .selectFrom('bank_rule_dimensions')
    .select(['bank_rule_id', 'dimension_value_id'])
    .where('bank_rule_id', 'in', ruleIds)
    .orderBy('dimension_id')
    .execute();

  for (const row of rows) {
    const key = row.bank_rule_id.toString('hex');
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [row.dimension_value_id]);
    else list.push(row.dimension_value_id);
  }

  return grouped;
}

export async function insertRuleDimensions(
  db: TenantDatabase,
  ruleId: Buffer,
  tags: readonly ResolvedLineTag[],
): Promise<void> {
  if (tags.length === 0) return;

  await db
    .insertInto('bank_rule_dimensions')
    .values(
      tags.map((tag) => ({
        bank_rule_id: ruleId,
        dimension_id: tag.dimensionId,
        dimension_value_id: tag.dimensionValueId,
      })),
    )
    .execute();
}

/** Removes every tag on a rule, so the outcome's tags can be replaced whole (D-44). */
export async function deleteRuleDimensions(db: TenantDatabase, ruleId: Buffer): Promise<void> {
  await db.deleteFrom('bank_rule_dimensions').where('bank_rule_id', '=', ruleId).execute();
}

// ---------------------------------------------------------------------------
// Listing, in evaluation order
// ---------------------------------------------------------------------------

/**
 * `(priority, created_at, id)` — the evaluation order (D-44), and the only order a
 * rule list is ever read in (`bankRulePageSchema`).
 *
 * `priority` is mutable, which every other keyset in this codebase forbids (D-21).
 * It is accepted here for the reason the contract states: reordering rules while
 * paging them can move a row behind the cursor, and the alternative is a screen that
 * lists rules in an order they are *not* evaluated in — the one thing a rules screen
 * must not do. `created_at` and `id` are written once and make the order total, so
 * the winner is defined even when an org gives every rule the same priority.
 */
const RULE_KEYSET: KeysetOrdering<RuleRow> = [
  smallintKey('bank_rules.priority', (row) => row.priority),
  instantKey('bank_rules.created_at', (row) => row.created_at),
  uuidKey('bank_rules.id', (row) => row.id),
];

export interface RuleFilters {
  readonly isActive?: boolean | undefined;
  readonly bankAccountId?: Buffer | undefined;
  readonly cursor?: string | undefined;
}

export async function selectRulesPage(
  db: TenantDatabase,
  filters: RuleFilters,
  limit: number,
): Promise<KeysetPage<RuleRow>> {
  let query = db.selectFrom('bank_rules').select(RULE_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }
  // A `bankAccountId` filter answers "which rules apply to this account", which
  // includes the org-wide rules (`bank_account_id IS NULL`) the evaluator runs
  // against every account — not only those scoped to it. Filtering `= ?` alone would
  // hide "Tesco is groceries" from an account's rule list while it still coded that
  // account's lines, which is the list disagreeing with the evaluation it exists to
  // mirror.
  if (filters.bankAccountId !== undefined) {
    const accountId = filters.bankAccountId;
    query = query.where((eb) =>
      eb.or([eb('bank_account_id', '=', accountId), eb('bank_account_id', 'is', null)]),
    );
  }

  const rows = await applyKeyset(query, RULE_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, RULE_KEYSET, limit);
}

/**
 * Every active rule in the org, for the evaluator (E10).
 *
 * Ordered here as well as sorted in the evaluator: the SQL order lets the read be an
 * index range on `idx_bank_rules_org_match`, and the evaluator's own sort is what
 * makes the winner independent of scan order regardless (D-44). All active rules,
 * not one account's — a page of statement lines may span accounts, and a rule's own
 * `bank_account_id` scope is applied per line, so loading the whole active set once
 * is both correct and the single read E10 asks for.
 */
export async function selectActiveRules(db: TenantDatabase): Promise<readonly RuleRow[]> {
  return db
    .selectFrom('bank_rules')
    .select(RULE_COLUMNS)
    .where('is_active', '=', 1)
    .orderBy('priority')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

// ---------------------------------------------------------------------------
// Row → wire
// ---------------------------------------------------------------------------

export function toCondition(row: RuleRow): BankRuleCondition {
  return {
    ...(row.match_description !== null && row.match_description_mode !== null
      ? { description: { mode: row.match_description_mode, value: row.match_description } }
      : {}),
    ...(row.match_direction !== null ? { direction: row.match_direction } : {}),
    ...(row.match_amount_min_minor !== null
      ? { amountMin: row.match_amount_min_minor.toString() }
      : {}),
    ...(row.match_amount_max_minor !== null
      ? { amountMax: row.match_amount_max_minor.toString() }
      : {}),
    ...(row.bank_account_id !== null ? { bankAccountId: bufferToUuid(row.bank_account_id) } : {}),
  };
}

export function toBankRule(row: RuleRow, dimensionValueIds: readonly Buffer[]): BankRule {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    priority: row.priority,
    isActive: row.is_active !== 0,
    condition: toCondition(row),
    outcome: {
      accountId: bufferToUuid(row.set_account_id),
      ...(row.set_contact_id !== null ? { contactId: bufferToUuid(row.set_contact_id) } : {}),
      ...(dimensionValueIds.length > 0
        ? { dimensionValueIds: dimensionValueIds.map(bufferToUuid) }
        : {}),
    },
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are lossless renderings of real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Driver-error translation and the priority cursor key
// ---------------------------------------------------------------------------

/**
 * `uq_bank_rules_org_name` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, name)`, so the row this collides with is inside the caller's own org and
 * naming it discloses nothing they cannot already read. Any other driver error is
 * rethrown untouched — this function knows about exactly one constraint.
 */
function translateDuplicateName(error: unknown, name: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `A bank rule named ${JSON.stringify(name)} already exists in this organisation. ` +
      'Names are unique per organisation; rename it, or update the existing rule.',
    { name },
  );
}

/**
 * A `SMALLINT UNSIGNED` cursor key — `bank_rules.priority`.
 *
 * There is no shared helper for a small integer (`counterKey` is for `BIGINT`), and
 * priority is a `number` rather than a `bigint`, so a bound number compares cleanly
 * against the column. A segment outside `0 … 65535` did not come from a row of this
 * table, so it is a malformed cursor rather than a query that returns nothing —
 * `textKey`'s reasoning, applied to the numeric bound.
 */
function smallintKey<Row>(column: string, of: (row: Row) => number): KeysetColumn<Row> {
  const DIGITS = /^(?:0|[1-9][0-9]*)$/;
  const SMALLINT_UNSIGNED_MAX = 65535;
  return {
    column,
    encode: (row) => String(of(row)),
    decode: (segment) => {
      if (!DIGITS.test(segment)) throw malformedCursor();
      const value = Number(segment);
      if (value > SMALLINT_UNSIGNED_MAX) throw malformedCursor();
      return value;
    },
  };
}

function malformedCursor(): ValidationError {
  return new ValidationError('Cursor is not valid.', [
    {
      path: 'cursor',
      message:
        'Send the `nextCursor` from this list’s previous page verbatim, or omit it to start at ' +
        'the beginning.',
    },
  ]);
}
