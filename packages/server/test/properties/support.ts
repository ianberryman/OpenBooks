import type { PostedJournal } from '@openbooks/plugin-api';
import { sql } from 'kysely';

import type { RequestContext } from '../../src/context';
import { postJournal, reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import type { AccountFixture, AccountType, NormalBalance, TestDatabase } from '../db';
import { contextFor, useLedgerDatabase, withContext } from '../ledger/support';

/**
 * Shared machinery for the spec §11 invariant properties (OB-025).
 *
 * The properties run against the real posting service and the real trial balance
 * over real MySQL, because spec §11 rules out mocks and SQLite and because the
 * three invariants that hold *structurally* — one-sided lines, `journal_lines.org_id`
 * matching its parent, and cross-org account references — are guarantees made by
 * `CHECK` constraints and composite foreign keys that exist nowhere else.
 *
 * ## Isolation between fast-check runs
 *
 * Every run materializes its own org. That is not a convenience: the harness resets
 * once per `it`, not once per run, so runs of the same property share a database.
 * A fresh org per run makes them independent anyway, since every invariant here is
 * stated per-org and every query the ledger issues is org-scoped — and it means the
 * later runs of a property assert the invariant while several other orgs' postings
 * sit in the same tables, which is the state production is always in.
 */
export { useLedgerDatabase, withContext };

/**
 * The one open period every generated posting lands in.
 *
 * A single year-long period rather than twelve months because period *arity* is not
 * one of the §11 invariants, and `assertPostable` only asks whether some open period
 * covers the date. Stated here rather than relying on the factory's defaults so the
 * date generator and the fixture cannot drift apart — a generated date outside the
 * period would fail every property with a `precondition_failed` that has nothing to
 * do with the invariant under test.
 */
export const OPEN_PERIOD = {
  year: 2026,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
} as const;

export interface AccountSpec {
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
}

export interface LinePlan {
  readonly accountIndex: number;
  readonly side: 'debit' | 'credit';
  /** Strictly positive minor units. Plain `bigint`: `MinorUnits` is unbranded. */
  readonly amount: bigint;
}

export interface JournalPlan {
  readonly date: string;
  readonly lines: readonly LinePlan[];
}

/**
 * A whole ledger's worth of generated input: the chart of accounts, and the journals
 * to post against it. Lines reference accounts by index so the same plan can be
 * materialized into two different orgs — which is what the posting-order property
 * needs in order to compare two independently built ledgers.
 */
export interface LedgerPlan {
  readonly accounts: readonly AccountSpec[];
  readonly journals: readonly JournalPlan[];
}

export interface Scene {
  readonly ctx: RequestContext;
  /** `BINARY(16)`, for the raw queries that read back what was stored. */
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly accounts: readonly AccountFixture[];
}

/**
 * Account codes are derived from the account's position in the plan, not generated.
 *
 * `uq_accounts_org_code` would reject a duplicate, so generating codes would mean
 * either a uniqueness filter in the arbitrary or a run that fails for a reason
 * unrelated to any invariant. Deriving them also gives the posting-order property a
 * stable key with which to compare one org's trial balance against another's.
 */
export function accountCode(index: number): string {
  return String(1000 + index);
}

export async function createScene(
  harness: TestDatabase,
  specs: readonly AccountSpec[],
): Promise<Scene> {
  const org = await harness.factories.org();
  const user = await harness.factories.user();
  await harness.factories.orgMember({ orgId: org.id, userId: user.id });
  await harness.factories.fiscalPeriod({
    orgId: org.id,
    startDate: OPEN_PERIOD.startDate,
    endDate: OPEN_PERIOD.endDate,
  });

  const accounts = await Promise.all(
    specs.map((spec, index) =>
      harness.factories.account({
        orgId: org.id,
        code: accountCode(index),
        type: spec.type,
        normalBalance: spec.normalBalance,
      }),
    ),
  );

  return {
    ctx: contextFor(org.uuid, OWNER_ROLE_ID, user.uuid),
    orgId: org.id,
    orgUuid: org.uuid,
    accounts,
  };
}

/**
 * Posts the plan's journals through the real service, one at a time in plan order.
 *
 * Sequential rather than concurrent, and order-preserving, because the posting-order
 * property is a statement about a specific order — a `Promise.all` here would make
 * the order it claims to control an artefact of scheduling.
 */
export async function postPlan(
  scene: Scene,
  journals: readonly JournalPlan[],
): Promise<readonly PostedJournal[]> {
  const posted: PostedJournal[] = [];
  for (const journal of journals) {
    posted.push(
      await withContext(scene.ctx, () =>
        postJournal({
          date: journal.date,
          actorType: 'user',
          actorId: scene.ctx.actorId,
          lines: journal.lines.map((line) => ({
            accountId: accountAt(scene, line.accountIndex).uuid,
            side: line.side,
            amount: line.amount,
          })),
        }),
      ),
    );
  }
  return posted;
}

/** Reverses each journal on its own entry date, which is inside the open period. */
export async function reverseAll(
  scene: Scene,
  posted: readonly PostedJournal[],
): Promise<readonly PostedJournal[]> {
  const reversals: PostedJournal[] = [];
  for (const journal of posted) {
    reversals.push(
      await withContext(scene.ctx, () =>
        reverseJournal({
          journalId: journal.journalId,
          date: journal.date,
          actorType: 'user',
          actorId: scene.ctx.actorId,
        }),
      ),
    );
  }
  return reversals;
}

export interface StoredLine {
  readonly journalId: string;
  readonly lineOrgId: string;
  readonly journalOrgId: string;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
}

/**
 * Every stored line in the database, paired with its parent journal's `org_id`.
 *
 * The join is on `journals.id` **alone**, deliberately. Joining on `(id, org_id)` —
 * which is how the production queries join, and how the composite foreign key is
 * declared — would filter a mismatched line out of the result set, so a violation
 * would read as an absence rather than as a failure. The whole point of the property
 * is to look at the pairing, so the query must be able to see a bad one.
 *
 * Unscoped on purpose too: this reads every org's rows, which makes the invariant a
 * statement about the table rather than about one tenant's slice of it.
 */
export async function readStoredLines(harness: TestDatabase): Promise<readonly StoredLine[]> {
  const rows = await harness.app
    .selectFrom('journal_lines')
    .innerJoin('journals', 'journals.id', 'journal_lines.journal_id')
    .select([
      'journal_lines.journal_id as journal_id',
      'journal_lines.org_id as line_org_id',
      'journals.org_id as journal_org_id',
      'journal_lines.debit_minor as debit_minor',
      'journal_lines.credit_minor as credit_minor',
    ])
    .execute();

  return rows.map((row) => ({
    journalId: row.journal_id.toString('hex'),
    lineOrgId: row.line_org_id.toString('hex'),
    journalOrgId: row.journal_org_id.toString('hex'),
    debitMinor: row.debit_minor,
    creditMinor: row.credit_minor,
  }));
}

/** The subset of `readStoredLines` belonging to one org, for the per-org invariants. */
export function linesForOrg(lines: readonly StoredLine[], orgId: Buffer): readonly StoredLine[] {
  const orgHex = orgId.toString('hex');
  return lines.filter((line) => line.lineOrgId === orgHex);
}

/** Per-journal debit and credit totals, summed in `bigint` so nothing rounds. */
export function totalsByJournal(lines: readonly StoredLine[]): Map<string, LedgerTotals> {
  const totals = new Map<string, LedgerTotals>();
  for (const line of lines) {
    const running = totals.get(line.journalId) ?? { debits: 0n, credits: 0n };
    totals.set(line.journalId, {
      debits: running.debits + line.debitMinor,
      credits: running.credits + line.creditMinor,
    });
  }
  return totals;
}

export interface LedgerTotals {
  readonly debits: bigint;
  readonly credits: bigint;
}

export function sumLines(lines: readonly StoredLine[]): LedgerTotals {
  return lines.reduce<LedgerTotals>(
    (running, line) => ({
      debits: running.debits + line.debitMinor,
      credits: running.credits + line.creditMinor,
    }),
    { debits: 0n, credits: 0n },
  );
}

/**
 * Inserts one `journal_lines` row with raw SQL and reports whether MySQL took it.
 *
 * Raw SQL rather than the typed builder for two reasons that point the same way.
 * `openbooks/no-journal-writes` allowlists the posting repository and the fixture
 * factories, and this is neither — it is a probe asserting that a write *fails*, and
 * the rule exists to stop a second *successful* write path, so nothing it protects is
 * weakened here. And the row being attempted is one the factories cannot construct:
 * they derive a line's `org_id` from its journal, which is exactly the value under
 * test. Every call site asserts the outcome, so a row that slips through is a test
 * failure rather than ledger state.
 */
export async function tryInsertLine(
  harness: TestDatabase,
  row: {
    readonly orgId: Buffer;
    readonly journalId: Buffer;
    readonly lineNumber: number;
    readonly accountId: Buffer;
    readonly debitMinor: bigint;
    readonly creditMinor: bigint;
  },
): Promise<{ readonly accepted: true } | { readonly accepted: false; readonly message: string }> {
  try {
    await sql`
      INSERT INTO journal_lines
        (org_id, journal_id, line_number, account_id, debit_minor, credit_minor)
      VALUES
        (${row.orgId}, ${row.journalId}, ${row.lineNumber},
         ${row.accountId}, ${row.debitMinor}, ${row.creditMinor})
    `.execute(harness.app);
    return { accepted: true };
  } catch (error: unknown) {
    return { accepted: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Index access with a real failure instead of `undefined` under `noUncheckedIndexedAccess`. */
export function accountAt(scene: Scene, index: number): AccountFixture {
  const account = scene.accounts[index];
  if (account === undefined) {
    throw new Error(
      `Plan referenced account index ${String(index)} but the scene has ` +
        `${String(scene.accounts.length)}. The generator and the materializer disagree.`,
    );
  }
  return account;
}
