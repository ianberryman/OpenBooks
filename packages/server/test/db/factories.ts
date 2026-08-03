/**
 * Test fixtures for the ledger.
 *
 * `openbooks/no-journal-writes` keeps `journals` / `journal_lines` inserts inside
 * the posting repository, because a second write path skips balance validation,
 * the period lock, and actor provenance (spec §2.1, §2.2). This file is the one
 * legitimate exception: fixtures for the trial balance, immutability, and property
 * suites need ledger rows, and a factory routed through the posting service could
 * not construct the invalid states those suites exist to reject.
 *
 * The exemption lives in `eslint.config.js`'s `allow` option rather than as a
 * file-scoped disable, so every exception to that rule is visible in one place.
 *
 * The validations the rule protects are re-implemented below and throw before the
 * insert, so a factory still cannot produce an unbalanced, one-sided, or
 * provenance-inconsistent journal by accident.
 */
import type { Insertable, Kysely, Selectable } from 'kysely';

import type { DB } from '../../src/db/generated';
import { newUuid, uuidToBuffer } from './uuid';

/**
 * Typed factories for the M1 entities.
 *
 * Every factory produces a row that satisfies the schema with no arguments at
 * all, creating whatever parents it needs, and accepts overrides for anything a
 * test actually cares about. The point is that a test states only its subject:
 * a period-locking test should not have to invent an org, a user, and two
 * accounts to get there.
 *
 * Column types follow `src/db/generated.ts` exactly, including the two the
 * generator gets wrong by default and `scripts/codegen.mjs` overrides: `BIGINT`
 * is `bigint` (money is minor units, spec §12) and `DATE` is `string` (a calendar
 * date has no timezone). Passing a `number` for money or a `Date` for
 * `entry_date` will not typecheck, deliberately.
 */

/** The reserved system role IDs seeded by `0001_tenancy`. */
export const SYSTEM_ROLE_UUIDS = {
  owner: '00000000-0000-4000-8000-000000000001',
  bookkeeper: '00000000-0000-4000-8000-000000000002',
  apOnly: '00000000-0000-4000-8000-000000000003',
  arOnly: '00000000-0000-4000-8000-000000000004',
  readOnly: '00000000-0000-4000-8000-000000000005',
  approver: '00000000-0000-4000-8000-000000000006',
  accountant: '00000000-0000-4000-8000-000000000007',
} as const;

export type SystemRoleName = keyof typeof SYSTEM_ROLE_UUIDS;

export function systemRoleId(role: SystemRoleName = 'owner'): Buffer {
  return uuidToBuffer(SYSTEM_ROLE_UUIDS[role]);
}

/**
 * Not a real Argon2 hash — computing one per fixture user would dominate the
 * suite's runtime for no assertion. Anything testing authentication must create
 * its users through the auth service (OB-015), not here.
 */
const PLACEHOLDER_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$dGVzdGZpeHR1cmVzYWx0$dGVzdGZpeHR1cmVub3RhcmVhbGhhc2g';

export interface OrgFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly name: string;
  readonly slug: string;
}

export interface UserFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly email: string;
  readonly displayName: string;
}

export interface OrgMemberFixture {
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly roleId: Buffer;
}

export interface AccountFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly orgId: Buffer;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
}

export interface FiscalPeriodFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly orgId: Buffer;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodStatus;
}

export interface JournalLineFixture {
  readonly orgId: Buffer;
  readonly journalId: Buffer;
  readonly lineNumber: number;
  readonly accountId: Buffer;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
}

export interface JournalFixture {
  readonly id: Buffer;
  readonly uuid: string;
  readonly orgId: Buffer;
  readonly periodId: Buffer;
  readonly entryDate: string;
  readonly actorType: ActorType;
  readonly actorId: Buffer;
  readonly lines: readonly JournalLineFixture[];
}

/** Org, a member user, an open period, and a debit/credit account pair. */
export interface LedgerFixture {
  readonly org: OrgFixture;
  readonly user: UserFixture;
  readonly period: FiscalPeriodFixture;
  readonly debitAccount: AccountFixture;
  readonly creditAccount: AccountFixture;
}

export type AccountType = DB['accounts']['type'];
export type NormalBalance = DB['accounts']['normal_balance'];
export type ActorType = DB['journals']['actor_type'];
export type InvocationMode = NonNullable<DB['journals']['invocation_mode']>;
export type PeriodStatus = Selectable<DB['fiscal_periods']>['status'];

export interface OrgInput {
  readonly id?: Buffer;
  readonly name?: string;
  readonly slug?: string;
}

export interface UserInput {
  readonly id?: Buffer;
  readonly email?: string;
  readonly displayName?: string;
  readonly passwordHash?: string;
  readonly isActive?: boolean;
}

export interface OrgMemberInput {
  readonly orgId?: Buffer;
  readonly userId?: Buffer;
  readonly roleId?: Buffer;
  readonly role?: SystemRoleName;
}

export interface AccountInput {
  readonly id?: Buffer;
  readonly orgId?: Buffer;
  readonly code?: string;
  readonly name?: string;
  readonly type?: AccountType;
  readonly normalBalance?: NormalBalance;
  readonly isActive?: boolean;
}

export interface FiscalPeriodInput {
  readonly id?: Buffer;
  readonly orgId?: Buffer;
  readonly name?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly status?: PeriodStatus;
  readonly closedAt?: Date;
  readonly closedByUserId?: Buffer;
}

export interface JournalLineInput {
  readonly accountId: Buffer;
  readonly debitMinor?: bigint;
  readonly creditMinor?: bigint;
  readonly memo?: string;
  readonly lineNumber?: number;
}

export interface JournalInput {
  readonly id?: Buffer;
  readonly orgId?: Buffer;
  readonly periodId?: Buffer;
  readonly entryDate?: string;
  readonly memo?: string;
  readonly reference?: string;
  readonly source?: string;
  readonly actorType?: ActorType;
  readonly actorId?: Buffer;
  readonly invocationMode?: InvocationMode;
  readonly reversesJournalId?: Buffer;
  /** Overrides sequence allocation. Only useful for testing the uniqueness key. */
  readonly sequenceNumber?: bigint;
  readonly lines?: readonly JournalLineInput[];
  /** Amount on each side of the default two-line entry. Ignored if `lines` is given. */
  readonly amountMinor?: bigint;
}

export interface ControlAccountsInput {
  readonly orgId: Buffer;
  readonly receivableId?: Buffer;
  readonly payableId?: Buffer;
  /** The inventory-shrinkage account a stock adjustment posts against (OB-224, D-INV-6). */
  readonly inventoryShrinkageId?: Buffer;
}

export interface Factories {
  org(input?: OrgInput): Promise<OrgFixture>;
  user(input?: UserInput): Promise<UserFixture>;
  orgMember(input?: OrgMemberInput): Promise<OrgMemberFixture>;
  account(input?: AccountInput): Promise<AccountFixture>;
  fiscalPeriod(input?: FiscalPeriodInput): Promise<FiscalPeriodFixture>;
  journal(input?: JournalInput): Promise<JournalFixture>;
  ledger(): Promise<LedgerFixture>;
  /**
   * Nominates the org's control accounts (OB-066a), which every approval in the
   * subledger now needs.
   *
   * A fixture rather than a call to `updateControlAccounts` because a scene should
   * not have to hold `orgs.write` to be able to approve an invoice — the
   * permission tests are about the operation under test, and a setup step that
   * needed a second permission would couple them.
   */
  controlAccounts(input: ControlAccountsInput): Promise<void>;
}

/**
 * Distinguishes rows within a process. Not shared across worker processes, which
 * is fine: each test file gets its own database state.
 */
let sequence = 0;
const nextSequence = (): number => (sequence += 1);

export function createFactories(db: Kysely<DB>): Factories {
  /**
   * Allocates the next `journals.sequence_number` for an org.
   *
   * Uses the real `journal_sequences` counter with the same `FOR UPDATE` claim the
   * posting repository does, rather than counting existing rows. Fixtures that
   * allocated differently from production would leave the gapless-and-monotonic
   * property untested precisely where it is most likely to break — under the
   * concurrent posting that OB-026 exercises.
   *
   * Runs as the **app** user, which is what the factories are constructed with —
   * and that is the stronger position, not a compromise. `FOR UPDATE` here only
   * works because `journal_sequences` is in 0999_app_grants' mutable allowlist,
   * so the fixture exercises the same grant the posting repository depends on.
   * Allocating as the migrator would have hidden a missing grant until production.
   */
  async function allocateSequenceNumber(orgId: Buffer): Promise<bigint> {
    return db.transaction().execute(async (trx) => {
      await trx
        .insertInto('journal_sequences')
        .values({ org_id: orgId, next_value: 1n })
        .onDuplicateKeyUpdate({ org_id: orgId })
        .execute();

      const row = await trx
        .selectFrom('journal_sequences')
        .select('next_value')
        .where('org_id', '=', orgId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('journal_sequences')
        .set({ next_value: row.next_value + 1n })
        .where('org_id', '=', orgId)
        .execute();

      return row.next_value;
    });
  }

  async function org(input: OrgInput = {}): Promise<OrgFixture> {
    const uuid = newUuid();
    const seq = nextSequence();
    const fixture: OrgFixture = {
      id: input.id ?? uuidToBuffer(uuid),
      uuid,
      name: input.name ?? `Test Org ${seq}`,
      slug: input.slug ?? `test-org-${seq}`,
    };

    await db
      .insertInto('orgs')
      .values({ id: fixture.id, name: fixture.name, slug: fixture.slug })
      .execute();

    return fixture;
  }

  async function user(input: UserInput = {}): Promise<UserFixture> {
    const uuid = newUuid();
    const seq = nextSequence();
    const fixture: UserFixture = {
      id: input.id ?? uuidToBuffer(uuid),
      uuid,
      email: input.email ?? `user-${seq}@openbooks.test`,
      displayName: input.displayName ?? `Test User ${seq}`,
    };

    await db
      .insertInto('users')
      .values({
        id: fixture.id,
        email: fixture.email,
        display_name: fixture.displayName,
        password_hash: input.passwordHash ?? PLACEHOLDER_PASSWORD_HASH,
        is_active: (input.isActive ?? true) ? 1 : 0,
      })
      .execute();

    return fixture;
  }

  async function orgMember(input: OrgMemberInput = {}): Promise<OrgMemberFixture> {
    const fixture: OrgMemberFixture = {
      orgId: input.orgId ?? (await org()).id,
      userId: input.userId ?? (await user()).id,
      roleId: input.roleId ?? systemRoleId(input.role ?? 'owner'),
    };

    await db
      .insertInto('org_members')
      .values({ org_id: fixture.orgId, user_id: fixture.userId, role_id: fixture.roleId })
      .execute();

    return fixture;
  }

  async function account(input: AccountInput = {}): Promise<AccountFixture> {
    const uuid = newUuid();
    const seq = nextSequence();
    const type = input.type ?? 'asset';
    const fixture: AccountFixture = {
      id: input.id ?? uuidToBuffer(uuid),
      uuid,
      orgId: input.orgId ?? (await org()).id,
      // Deliberately not derived from `type`: contra accounts are real (spec-wise,
      // accumulated depreciation is an asset with a credit normal balance), which
      // is why 0002_ledger stores normal_balance rather than deriving it.
      normalBalance: input.normalBalance ?? defaultNormalBalance(type),
      code: input.code ?? String(1000 + seq),
      name: input.name ?? `Test Account ${seq}`,
      type,
    };

    await db
      .insertInto('accounts')
      .values({
        id: fixture.id,
        org_id: fixture.orgId,
        code: fixture.code,
        name: fixture.name,
        type: fixture.type,
        normal_balance: fixture.normalBalance,
        is_active: (input.isActive ?? true) ? 1 : 0,
      })
      .execute();

    return fixture;
  }

  async function fiscalPeriod(input: FiscalPeriodInput = {}): Promise<FiscalPeriodFixture> {
    const uuid = newUuid();
    const seq = nextSequence();
    const status = input.status ?? 'open';
    const fixture: FiscalPeriodFixture = {
      id: input.id ?? uuidToBuffer(uuid),
      uuid,
      orgId: input.orgId ?? (await org()).id,
      name: input.name ?? `FY Period ${seq}`,
      startDate: input.startDate ?? '2026-01-01',
      endDate: input.endDate ?? '2026-12-31',
      status,
    };

    // chk_fiscal_periods_closed_consistency: closed_at is set exactly when the
    // period is closed. Defaulting it keeps `{ status: 'closed' }` a one-liner for
    // the A4 tests instead of a constraint violation.
    const closedAt = status === 'closed' ? (input.closedAt ?? new Date()) : null;

    await db
      .insertInto('fiscal_periods')
      .values({
        id: fixture.id,
        org_id: fixture.orgId,
        name: fixture.name,
        start_date: fixture.startDate,
        end_date: fixture.endDate,
        status: fixture.status,
        closed_at: closedAt,
        closed_by_user_id: input.closedByUserId ?? null,
      })
      .execute();

    return fixture;
  }

  async function ledger(): Promise<LedgerFixture> {
    const orgFixture = await org();
    const userFixture = await user();
    await orgMember({ orgId: orgFixture.id, userId: userFixture.id });

    const [period, debitAccount, creditAccount] = await Promise.all([
      fiscalPeriod({ orgId: orgFixture.id }),
      account({ orgId: orgFixture.id, type: 'expense', normalBalance: 'debit' }),
      account({ orgId: orgFixture.id, type: 'liability', normalBalance: 'credit' }),
    ]);

    return { org: orgFixture, user: userFixture, period, debitAccount, creditAccount };
  }

  async function journal(input: JournalInput = {}): Promise<JournalFixture> {
    const context = await resolveJournalContext(input);
    const lines = normalizeLines(input.lines ?? context.defaultLines);
    assertBalanced(lines);

    const actorType = input.actorType ?? 'user';
    if (actorType !== 'agent' && input.invocationMode !== undefined) {
      throw new Error(
        `invocation_mode is only permitted for actor_type 'agent' (got '${actorType}') — ` +
          'chk_journals_invocation_mode.',
      );
    }
    // Spec §6 makes invocation_mode the record of whether a posting needed review,
    // and chk_journals_invocation_mode requires it exactly for agents. Derived, so a
    // caller asking for an agent journal cannot accidentally produce a rejected row.
    const invocationMode = actorType === 'agent' ? (input.invocationMode ?? 'interactive') : null;

    const uuid = newUuid();
    const id = input.id ?? uuidToBuffer(uuid);
    const entryDate = input.entryDate ?? context.entryDate;
    const actorId = input.actorId ?? context.actorId;

    const sequenceNumber = input.sequenceNumber ?? (await allocateSequenceNumber(context.orgId));

    const journalRow: Insertable<DB['journals']> = {
      id,
      org_id: context.orgId,
      sequence_number: sequenceNumber,
      period_id: context.periodId,
      entry_date: entryDate,
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      source: input.source ?? 'manual',
      actor_type: actorType,
      actor_id: actorId,
      invocation_mode: invocationMode,
      reverses_journal_id: input.reversesJournalId ?? null,
    };

    await db.insertInto('journals').values(journalRow).execute();

    const lineFixtures: JournalLineFixture[] = lines.map((line, index) => ({
      orgId: context.orgId,
      journalId: id,
      lineNumber: line.lineNumber ?? index + 1,
      accountId: line.accountId,
      debitMinor: line.debitMinor ?? 0n,
      creditMinor: line.creditMinor ?? 0n,
    }));

    await db
      .insertInto('journal_lines')
      .values(
        lineFixtures.map((line) => ({
          org_id: line.orgId,
          journal_id: line.journalId,
          line_number: line.lineNumber,
          account_id: line.accountId,
          debit_minor: line.debitMinor,
          credit_minor: line.creditMinor,
        })),
      )
      .execute();

    return {
      id,
      uuid,
      orgId: context.orgId,
      periodId: context.periodId,
      entryDate,
      actorType,
      actorId,
      lines: lineFixtures,
    };
  }

  interface JournalContext {
    readonly orgId: Buffer;
    readonly periodId: Buffer;
    readonly entryDate: string;
    readonly actorId: Buffer;
    readonly defaultLines: readonly JournalLineInput[];
  }

  async function resolveJournalContext(input: JournalInput): Promise<JournalContext> {
    // Nothing supplied: build the whole ledger, so `factories.journal()` is a
    // single call in the many tests that only care that *a* posting exists.
    if (input.orgId === undefined) {
      const fixture = await ledger();
      return {
        orgId: fixture.org.id,
        periodId: fixture.period.id,
        entryDate: fixture.period.startDate,
        actorId: fixture.user.id,
        defaultLines: defaultLines(fixture, input.amountMinor),
      };
    }

    const orgId = input.orgId;
    const periodId = input.periodId ?? (await fiscalPeriod({ orgId })).id;
    // The schema does not require entry_date to fall inside its period, but
    // OB-019's assertPostable does, so the default is read off the period rather
    // than assumed — a fixture that is only valid until someone adds that check is
    // not a useful fixture.
    const entryDate = input.entryDate ?? (await periodStartDate(periodId));

    const actorId = input.actorId ?? (await user()).id;
    const needsLines = input.lines === undefined;
    const pair = needsLines
      ? await Promise.all([
          account({ orgId, type: 'expense', normalBalance: 'debit' }),
          account({ orgId, type: 'liability', normalBalance: 'credit' }),
        ])
      : undefined;

    return {
      orgId,
      periodId,
      entryDate,
      actorId,
      defaultLines:
        pair === undefined
          ? []
          : [
              { accountId: pair[0].id, debitMinor: input.amountMinor ?? 100_00n },
              { accountId: pair[1].id, creditMinor: input.amountMinor ?? 100_00n },
            ],
    };
  }

  async function periodStartDate(periodId: Buffer): Promise<string> {
    const row = await db
      .selectFrom('fiscal_periods')
      .select('start_date')
      .where('id', '=', periodId)
      .executeTakeFirst();

    if (row === undefined) {
      throw new Error('No fiscal period with the given id; pass periodId of a period that exists.');
    }
    return row.start_date;
  }

  /**
   * Runs as the **app** user like every other factory here, so a missing UPDATE
   * grant on `org_accounting_settings` surfaces in the suite rather than in
   * production. The upsert is the one the settings repository performs, for the
   * same reason `allocateSequenceNumber` uses the real counter: a fixture that
   * wrote differently from production would leave the production path untested at
   * exactly the point it is used.
   */
  async function controlAccounts(input: ControlAccountsInput): Promise<void> {
    const columns = {
      ...(input.receivableId === undefined
        ? {}
        : { receivable_control_account_id: input.receivableId }),
      ...(input.payableId === undefined ? {} : { payable_control_account_id: input.payableId }),
      ...(input.inventoryShrinkageId === undefined
        ? {}
        : { inventory_shrinkage_account_id: input.inventoryShrinkageId }),
    };

    await db
      .insertInto('org_accounting_settings')
      .values({ org_id: input.orgId, ...columns })
      .onDuplicateKeyUpdate(Object.keys(columns).length === 0 ? { org_id: input.orgId } : columns)
      .execute();
  }

  return { org, user, orgMember, account, fiscalPeriod, journal, ledger, controlAccounts };
}

function defaultLines(
  fixture: LedgerFixture,
  amountMinor: bigint | undefined,
): readonly JournalLineInput[] {
  const amount = amountMinor ?? 100_00n;
  return [
    { accountId: fixture.debitAccount.id, debitMinor: amount },
    { accountId: fixture.creditAccount.id, creditMinor: amount },
  ];
}

function normalizeLines(lines: readonly JournalLineInput[]): readonly JournalLineInput[] {
  if (lines.length < 2) {
    throw new Error(
      `A journal needs at least two lines, got ${lines.length}. A single-line entry cannot ` +
        'balance (spec §11).',
    );
  }
  return lines;
}

/**
 * The invariants the schema states and the ones it cannot.
 *
 * `chk_journal_lines_one_sided` catches the per-line half in the database. Balance
 * across lines is not expressible as a MySQL constraint, so it is checked here —
 * a factory that could emit an unbalanced journal would silently poison every
 * trial-balance assertion built on it (spec §11, gate A2).
 */
function assertBalanced(lines: readonly JournalLineInput[]): void {
  let debits = 0n;
  let credits = 0n;

  for (const [index, line] of lines.entries()) {
    const debit = line.debitMinor ?? 0n;
    const credit = line.creditMinor ?? 0n;
    const oneSided = (debit > 0n && credit === 0n) || (debit === 0n && credit > 0n);
    if (!oneSided) {
      throw new Error(
        `Line ${index + 1} has debit ${debit} and credit ${credit}: exactly one side must be ` +
          'positive and the other zero (chk_journal_lines_one_sided).',
      );
    }
    debits += debit;
    credits += credit;
  }

  if (debits !== credits) {
    throw new Error(
      `Unbalanced journal: debits ${debits} != credits ${credits} (minor units). Build the ` +
        'lines so they balance, or assert rejection against the posting service rather than ' +
        'the factory.',
    );
  }
}

function defaultNormalBalance(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/**
 * Backdates a posted journal's `created_at`.
 *
 * The posting instant is `now()` and cannot be chosen through the posting service,
 * so a test that asserts audit-trail or event ordering needs to set it directly.
 * Writing `journals` is permitted here and only here on the test side: the posting
 * repository, the migrations, and these factories are the `openbooks/no-journal-writes`
 * allowlist, precisely so a test controlling a fixture's timeline does not have to
 * evade the rule that keeps every real write on one path.
 */
export async function backdateJournal(db: Kysely<DB>, journalId: string, at: Date): Promise<void> {
  await db
    .updateTable('journals')
    .set({ created_at: at })
    .where('id', '=', uuidToBuffer(journalId))
    .execute();
}
