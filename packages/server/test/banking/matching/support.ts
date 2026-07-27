import { createRequestContext, runInContext, type RequestContext } from '../../../src/context';
import type {
  RuleCandidateLine,
  RuleEvaluator,
  RuleMatch,
} from '../../../src/modules/banking/rule-evaluator';
import type { TestDatabase } from '../../db';
import { SYSTEM_ROLE_UUIDS, newUuid, systemRoleId, uuidToBuffer } from '../../db';

/**
 * Support for the OB-079 match-engine suite.
 *
 * Everything is seeded directly as the **app** user (spec §11: real MySQL, no mocks),
 * so the engine reads its candidates from genuine rows — journals on the bank account,
 * open invoices and bills, prior codings — rather than from a stub. Only the
 * `RuleEvaluator` is a fake, and it is a fake because it is the *injected* seam
 * (OB-080 owns the real one); the fake records how many times it was called, which is
 * how the page's batching is proven (E10).
 */

export interface MatchScene {
  readonly orgId: Buffer;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  readonly periodId: Buffer;
  readonly bankAccountId: Buffer;
  readonly importId: Buffer;
  readonly accounts: {
    readonly bankLedger: Buffer; // the asset account behind the bank account
    readonly coding: Buffer; // an expense account, used as a coding target and contra
    readonly revenue: Buffer;
    readonly expense: Buffer;
    readonly receivable: Buffer;
    readonly payable: Buffer;
  };
  readonly accountUuids: { readonly coding: string };
}

let counter = 0;
const next = (): number => (counter += 1);

export async function buildScene(db: TestDatabase): Promise<MatchScene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });

  const period = await db.factories.fiscalPeriod({
    orgId: org.id,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'open',
  });

  const make = async (code: string, type: 'asset' | 'liability' | 'revenue' | 'expense') => {
    const normalBalance = type === 'asset' || type === 'expense' ? 'debit' : 'credit';
    return db.factories.account({ orgId: org.id, code, type, normalBalance });
  };
  const bankLedger = await make('1010', 'asset');
  const receivable = await make('1100', 'asset');
  const payable = await make('2010', 'liability');
  const revenue = await make('4000', 'revenue');
  const coding = await make('6000', 'expense');
  const expense = await make('6100', 'expense');

  const bankAccountId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_accounts')
    .values({ id: bankAccountId, org_id: org.id, account_id: bankLedger.id, name: 'Current' })
    .execute();

  const importId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: importId,
      org_id: org.id,
      bank_account_id: bankAccountId,
      format: 'ofx',
      filename: 'seed.ofx',
      file_hash: 'seed'.padEnd(64, '0'),
      status: 'complete',
      lines_read: 0,
      lines_duplicate: 0,
      imported_by_user_id: user.id,
    })
    .execute();

  return {
    orgId: org.id,
    userId: user.id,
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
    periodId: period.id,
    bankAccountId,
    importId,
    accounts: {
      bankLedger: bankLedger.id,
      coding: coding.id,
      revenue: revenue.id,
      expense: expense.id,
      receivable: receivable.id,
      payable: payable.id,
    },
    accountUuids: { coding: coding.uuid },
  };
}

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface LineOptions {
  readonly postedDate?: string;
  readonly amount: bigint;
  readonly description?: string;
  readonly counterparty?: string | null;
  readonly bankReference?: string | null;
}

export interface SeededLine {
  readonly id: Buffer;
  readonly uuid: string;
}

/** One statement line, as the bank stated it. */
export async function lineIn(
  db: TestDatabase,
  scene: MatchScene,
  options: LineOptions,
): Promise<SeededLine> {
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id,
      org_id: scene.orgId,
      bank_account_id: scene.bankAccountId,
      import_id: scene.importId,
      posted_date: options.postedDate ?? '2026-03-15',
      description: options.description ?? 'PAYMENT',
      counterparty: options.counterparty ?? null,
      amount_minor: options.amount,
      bank_reference: options.bankReference ?? null,
      fingerprint: (newUuid() + newUuid()).replace(/-/g, ''),
      occurrence_index: 0,
    })
    .execute();
  return { id, uuid };
}

export interface BankJournalOptions {
  readonly amount: bigint; // signed, in the line's frame (positive = into the bank account)
  readonly date?: string;
  readonly memo?: string;
  readonly contraAccountId?: Buffer; // the non-bank side; defaults to the coding account
}

export interface SeededJournal {
  readonly id: Buffer;
  readonly uuid: string;
}

/** A journal posting `amount` to the bank ledger account, balanced against a contra account. */
export async function bankJournalIn(
  db: TestDatabase,
  scene: MatchScene,
  options: BankJournalOptions,
): Promise<SeededJournal> {
  const magnitude = options.amount < 0n ? -options.amount : options.amount;
  const contra = options.contraAccountId ?? scene.accounts.coding;
  const inbound = options.amount > 0n;
  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: options.date ?? '2026-03-15',
    actorId: scene.userId,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    lines: inbound
      ? [
          { accountId: scene.accounts.bankLedger, debitMinor: magnitude },
          { accountId: contra, creditMinor: magnitude },
        ]
      : [
          { accountId: contra, debitMinor: magnitude },
          { accountId: scene.accounts.bankLedger, creditMinor: magnitude },
        ],
  });
  return { id: journal.id, uuid: journal.uuid };
}

export interface DocumentOptions {
  readonly amountMinor: bigint;
  readonly contactName: string;
  readonly issueDate?: string;
  readonly reference?: string | null;
}

export interface SeededDocument {
  readonly id: Buffer;
  readonly uuid: string;
  readonly number: string;
  readonly contactId: Buffer;
  readonly contactName: string;
}

async function contactIn(
  db: TestDatabase,
  scene: MatchScene,
  displayName: string,
): Promise<Buffer> {
  const id = uuidToBuffer(newUuid());
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: scene.orgId, display_name: displayName })
    .execute();
  return id;
}

/** An approved, unallocated invoice — an inbound line settles one of these. */
export async function invoiceIn(
  db: TestDatabase,
  scene: MatchScene,
  options: DocumentOptions,
): Promise<SeededDocument> {
  return documentIn(db, scene, 'invoice', options);
}

/** An approved, unallocated bill — an outbound line settles one of these. */
export async function billIn(
  db: TestDatabase,
  scene: MatchScene,
  options: DocumentOptions,
): Promise<SeededDocument> {
  return documentIn(db, scene, 'bill', options);
}

async function documentIn(
  db: TestDatabase,
  scene: MatchScene,
  kind: 'invoice' | 'bill',
  options: DocumentOptions,
): Promise<SeededDocument> {
  const receivable = kind === 'invoice';
  const contactId = await contactIn(db, scene, options.contactName);
  const issueDate = options.issueDate ?? '2026-03-01';
  const number = next();

  const control = receivable ? scene.accounts.receivable : scene.accounts.payable;
  const other = receivable ? scene.accounts.revenue : scene.accounts.expense;
  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: issueDate,
    actorId: scene.userId,
    source: kind,
    lines: receivable
      ? [
          { accountId: control, debitMinor: options.amountMinor },
          { accountId: other, creditMinor: options.amountMinor },
        ]
      : [
          { accountId: other, debitMinor: options.amountMinor },
          { accountId: control, creditMinor: options.amountMinor },
        ],
  });

  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  const header = {
    id,
    org_id: scene.orgId,
    sequence_number: BigInt(number),
    contact_id: contactId,
    issue_date: issueDate,
    due_date: issueDate,
    tax_mode: 'exclusive' as const,
    reference: options.reference ?? null,
    memo: null,
    journal_id: journal.id,
    void_journal_id: null,
    created_by_user_id: scene.userId,
  };
  const line = {
    org_id: scene.orgId,
    document_id: id,
    line_number: 1,
    description: `${kind} line`,
    quantity_micros: 1_000_000n,
    unit_amount_minor: options.amountMinor,
    account_id: other,
    tax_rate_id: null,
    line_amount_minor: options.amountMinor,
    tax_amount_minor: 0n,
  };
  if (receivable) {
    await db.app
      .insertInto('ar_documents')
      .values({ ...header, document_type: 'invoice' })
      .execute();
    await db.app.insertInto('ar_document_lines').values(line).execute();
  } else {
    await db.app
      .insertInto('ap_documents')
      .values({ ...header, document_type: 'bill' })
      .execute();
    await db.app.insertInto('ap_document_lines').values(line).execute();
  }

  return { id, uuid, number: number.toString(), contactId, contactName: options.contactName };
}

/**
 * An approved credit note against a contact, and the allocation that applies it to an
 * invoice — so a test can drive an invoice's outstanding below its total through the
 * subledger's own mechanism (D-34) rather than by writing a balance.
 */
export async function creditNoteAllocationIn(
  db: TestDatabase,
  scene: MatchScene,
  options: { readonly invoiceId: Buffer; readonly contactId: Buffer; readonly amountMinor: bigint },
): Promise<void> {
  const number = next();
  const journal = await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: '2026-03-05',
    actorId: scene.userId,
    source: 'credit_note',
    lines: [
      { accountId: scene.accounts.revenue, debitMinor: options.amountMinor },
      { accountId: scene.accounts.receivable, creditMinor: options.amountMinor },
    ],
  });
  const creditId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('ar_documents')
    .values({
      id: creditId,
      org_id: scene.orgId,
      document_type: 'credit_note',
      sequence_number: BigInt(number),
      contact_id: options.contactId,
      issue_date: '2026-03-05',
      due_date: null,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      journal_id: journal.id,
      void_journal_id: null,
      created_by_user_id: scene.userId,
    })
    .execute();
  await db.app
    .insertInto('ar_document_lines')
    .values({
      org_id: scene.orgId,
      document_id: creditId,
      line_number: 1,
      description: 'credit note line',
      quantity_micros: 1_000_000n,
      unit_amount_minor: options.amountMinor,
      account_id: scene.accounts.revenue,
      tax_rate_id: null,
      line_amount_minor: options.amountMinor,
      tax_amount_minor: 0n,
    })
    .execute();
  await db.app
    .insertInto('ar_allocations')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: scene.orgId,
      invoice_id: options.invoiceId,
      credit_note_id: creditId,
      amount_minor: options.amountMinor,
      allocated_on: '2026-03-05',
      created_by_user_id: scene.userId,
    })
    .execute();
}

/**
 * A prior `post_entry` clearing: a historical line, a journal that coded it to
 * `codedAccountId`, and the clearing that records the match. This is the org's own
 * coding history the engine reads for `contact_history` proposals.
 */
export async function codingHistoryIn(
  db: TestDatabase,
  scene: MatchScene,
  options: {
    readonly counterparty: string;
    readonly amount: bigint;
    readonly codedAccountId: Buffer;
  },
): Promise<void> {
  const line = await lineIn(db, scene, {
    amount: options.amount,
    description: 'HISTORICAL',
    counterparty: options.counterparty,
    postedDate: '2026-02-01',
  });
  const journal = await bankJournalIn(db, scene, {
    amount: options.amount,
    date: '2026-02-01',
    contraAccountId: options.codedAccountId,
  });
  await db.app
    .insertInto('bank_line_clearings')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: scene.orgId,
      statement_line_id: line.id,
      method: 'post_entry',
      cleared_journal_id: journal.id,
      cleared_amount_minor: options.amount,
      difference_amount_minor: 0n,
      created_by_user_id: scene.userId,
    })
    .execute();
}

/**
 * A fake `RuleEvaluator` that returns the configured match for a line and counts its
 * calls — the witness that the engine evaluates the whole page in one batched call.
 */
export interface FakeEvaluator {
  readonly evaluator: RuleEvaluator;
  readonly calls: () => number;
  readonly lastLineCount: () => number;
}

export function fakeEvaluator(matches: ReadonlyMap<string, RuleMatch>): FakeEvaluator {
  let calls = 0;
  let lastLineCount = 0;
  return {
    evaluator: {
      evaluate: (lines: readonly RuleCandidateLine[]) => {
        calls += 1;
        lastLineCount = lines.length;
        const result = new Map<string, RuleMatch>();
        for (const line of lines) {
          const match = matches.get(line.lineId);
          if (match !== undefined) result.set(line.lineId, match);
        }
        return Promise.resolve(result);
      },
    },
    calls: () => calls,
    lastLineCount: () => lastLineCount,
  };
}

/** An evaluator that never matches — for lines that should draw no rule proposal. */
export const noRules: FakeEvaluator = fakeEvaluator(new Map());
