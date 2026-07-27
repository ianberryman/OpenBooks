import { beforeEach, describe, expect, it } from 'vitest';

import { newUuid } from '../../src/db';
import { NotFoundError, ValidationError } from '../../src/errors';
import type { GeneralLedger, GeneralLedgerEntry } from '../../src/modules/reports';
import { getGeneralLedger } from '../../src/modules/reports';

import type { Axis, Scene, SceneAccount } from './support';
import {
  createAxis,
  createChart,
  createParty,
  createScene,
  post,
  useReportDatabase,
  withContext,
} from './support';

/**
 * The general ledger's behaviour, stated as examples (OB-044).
 *
 * The properties in `test/properties/general-ledger.test.ts` are what prove the
 * arithmetic — that the pages concatenate to the unpaged answer and that the last
 * running balance is the closing balance (B4), over generated ledgers. What is
 * here is the part a property cannot state: the *order* two entries made on one
 * day come back in, what "the other side" resolves to on a three-way split, and
 * which of the two obvious readings of a filter this report chose.
 */
const db = useReportDatabase();

interface Fixture {
  readonly scene: Scene;
  readonly accounts: ReadonlyMap<string, SceneAccount>;
  readonly department: Axis;
}

function accountId(fixture: Fixture, code: string): string {
  const account = fixture.accounts.get(code);
  if (account === undefined) throw new Error(`Fixture has no account ${code}.`);
  return account.id;
}

async function fixture(): Promise<Fixture> {
  const scene = await createScene(db);
  const accounts = await createChart(scene, [
    { code: '1000', type: 'asset', normalBalance: 'debit' },
    { code: '1100', type: 'asset', normalBalance: 'debit' },
    { code: '2000', type: 'liability', normalBalance: 'credit' },
    { code: '5100', type: 'expense', normalBalance: 'debit' },
    { code: '5200', type: 'expense', normalBalance: 'debit' },
    { code: '5300', type: 'expense', normalBalance: 'debit' },
  ]);
  const department = await createAxis(scene, 'DEPT', ['SALES', 'OPS']);

  return { scene, accounts, department };
}

function ledger(
  fixture: Fixture,
  query: Omit<Parameters<typeof getGeneralLedger>[0], 'accountId'> & { accountId: string },
): Promise<GeneralLedger> {
  return withContext(fixture.scene.ctx, () => getGeneralLedger(query, fixture.scene.ctx));
}

describe('the general ledger lists an account over a range (OB-044)', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it('opens at the brought-forward balance, runs on the entries, and closes on B4', async () => {
    // Two entries before the range, three inside it.
    await post(f.scene, '2026-01-10', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 10_000n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 10_000n },
    ]);
    await post(f.scene, '2026-02-15', [
      { accountId: accountId(f, '1000'), side: 'credit', amount: 2_500n },
      { accountId: accountId(f, '5100'), side: 'debit', amount: 2_500n },
    ]);
    await post(f.scene, '2026-03-05', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 4_000n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 4_000n },
    ]);
    await post(f.scene, '2026-03-20', [
      { accountId: accountId(f, '1000'), side: 'credit', amount: 1_000n },
      { accountId: accountId(f, '5200'), side: 'debit', amount: 1_000n },
    ]);
    await post(f.scene, '2026-04-01', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 500n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 500n },
    ]);

    const report = await ledger(f, {
      accountId: accountId(f, '1000'),
      from: '2026-03-01',
      to: '2026-04-30',
    });

    expect(report.code).toBe('1000');
    expect(report.opening.balance).toBe('7500');
    expect(report.movement.balance).toBe('3500');
    expect(report.closing.balance).toBe('11000');

    expect(report.entries.map((entry) => [entry.date, entry.runningBalance])).toEqual([
      ['2026-03-05', '11500'],
      ['2026-03-20', '10500'],
      ['2026-04-01', '11000'],
    ]);

    // B4 as a reader checks it: the bottom of the running column is the closing
    // figure printed under it.
    expect(report.entries.at(-1)?.runningBalance).toBe(report.closing.balance);
    expect(report.nextCursor).toBeNull();
  });

  it('orders two entries on the same day by the sequence number, not by insertion', async () => {
    // Both on one date, so `entry_date` alone cannot separate them (D-14, D-21).
    const first = await post(f.scene, '2026-05-01', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 100n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 100n },
    ]);
    const second = await post(f.scene, '2026-05-01', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 200n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 200n },
    ]);

    const report = await ledger(f, { accountId: accountId(f, '1000') });

    expect(report.entries.map((entry) => entry.journalId)).toEqual([
      first.journalId,
      second.journalId,
    ]);
    expect(report.entries.map((entry) => entry.runningBalance)).toEqual(['100', '300']);
  });

  it('places a back-dated entry at its own date, behind entries posted before it', async () => {
    await post(f.scene, '2026-06-01', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 100n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 100n },
    ]);
    // Posted second, dated first — the correction shape D-02 makes the only way to
    // fix an entry, and the reason offset paging cannot be used here.
    await post(f.scene, '2026-05-01', [
      { accountId: accountId(f, '1000'), side: 'debit', amount: 50n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 50n },
    ]);

    const report = await ledger(f, { accountId: accountId(f, '1000') });

    expect(report.entries.map((entry) => [entry.date, entry.runningBalance])).toEqual([
      ['2026-05-01', '50'],
      ['2026-06-01', '150'],
    ]);
  });

  it('pages through two lines of one journal that hit the same account', async () => {
    // The case `(entry_date, sequence_number)` cannot separate: one journal, two
    // lines, one account. Without `journal_lines.id` as the third ordering column
    // the cursor would either repeat this journal or skip the rest of it.
    await post(f.scene, '2026-07-01', [
      { accountId: accountId(f, '5100'), side: 'debit', amount: 300n },
      { accountId: accountId(f, '5100'), side: 'debit', amount: 700n },
      { accountId: accountId(f, '1000'), side: 'credit', amount: 1_000n },
    ]);

    const collected = await readEveryPage(f, accountId(f, '5100'), 1);

    expect(collected.map((entry) => [entry.lineNumber, entry.runningBalance])).toEqual([
      [1, '300'],
      [2, '1000'],
    ]);
    expect(new Set(collected.map((entry) => entry.lineId)).size).toBe(2);
  });

  it('names the opposite side of a split, not the sibling lines beside it', async () => {
    // Rent across three departments against one bank credit. Under "every other
    // line", the 5100 row would name 5200 and 5300 as its contra — the reading
    // `general-ledger.ts` rejects.
    await post(f.scene, '2026-08-01', [
      { accountId: accountId(f, '5100'), side: 'debit', amount: 100n },
      { accountId: accountId(f, '5200'), side: 'debit', amount: 200n },
      { accountId: accountId(f, '5300'), side: 'debit', amount: 300n },
      { accountId: accountId(f, '1000'), side: 'credit', amount: 600n },
    ]);

    const expense = await ledger(f, { accountId: accountId(f, '5100') });
    expect(expense.entries[0]?.counterparty.accounts.map((account) => account.code)).toEqual([
      '1000',
    ]);
    expect(expense.entries[0]?.counterparty.accountCount).toBe(1);

    // Read from the other end, the same journal is a split.
    const bank = await ledger(f, { accountId: accountId(f, '1000') });
    expect(bank.entries[0]?.counterparty.accounts.map((account) => account.code)).toEqual([
      '5100',
      '5200',
      '5300',
    ]);
    expect(bank.entries[0]?.counterparty.accountCount).toBe(3);
  });

  it('carries the contact, the memos and the tags on the entry', async () => {
    const contactId = await createParty(f.scene, 'Landlord Ltd');
    const sales = f.department.values.get('SALES');
    if (sales === undefined) throw new Error('Fixture axis is missing SALES.');

    await post(f.scene, '2026-09-01', [
      {
        accountId: accountId(f, '5100'),
        side: 'debit',
        amount: 900n,
        contactId,
        valueIds: [sales],
      },
      { accountId: accountId(f, '1000'), side: 'credit', amount: 900n },
    ]);

    const report = await ledger(f, { accountId: accountId(f, '5100') });
    const entry = report.entries[0];

    expect(entry?.contact).toEqual({ contactId, displayName: 'Landlord Ltd' });
    expect(entry?.tags).toEqual([
      {
        dimensionId: f.department.id,
        dimensionCode: 'DEPT',
        dimensionValueId: sales,
        code: 'SALES',
        name: 'Value SALES',
      },
    ]);
    expect(entry?.debit).toBe('900');
    expect(entry?.credit).toBe('0');
  });

  it('narrows the entries by contact and by dimension, but never the counterparty', async () => {
    const landlord = await createParty(f.scene, 'Landlord Ltd');
    const other = await createParty(f.scene, 'Someone Else');
    const sales = f.department.values.get('SALES');
    const ops = f.department.values.get('OPS');
    if (sales === undefined || ops === undefined) throw new Error('Fixture axis is incomplete.');

    await post(f.scene, '2026-10-01', [
      {
        accountId: accountId(f, '5100'),
        side: 'debit',
        amount: 100n,
        contactId: landlord,
        valueIds: [sales],
      },
      { accountId: accountId(f, '1000'), side: 'credit', amount: 100n },
    ]);
    await post(f.scene, '2026-10-02', [
      {
        accountId: accountId(f, '5100'),
        side: 'debit',
        amount: 200n,
        contactId: other,
        valueIds: [ops],
      },
      { accountId: accountId(f, '1100'), side: 'credit', amount: 200n },
    ]);
    await post(f.scene, '2026-10-03', [
      { accountId: accountId(f, '5100'), side: 'debit', amount: 400n },
      { accountId: accountId(f, '2000'), side: 'credit', amount: 400n },
    ]);

    const byContact = await ledger(f, { accountId: accountId(f, '5100'), contactId: landlord });
    expect(byContact.entries.map((entry) => entry.debit)).toEqual(['100']);
    expect(byContact.movement.balance).toBe('100');
    // The other side of the entry is a fact about the journal, so it survives a
    // filter that had nothing to say about it.
    expect(byContact.entries[0]?.counterparty.accounts.map((a) => a.code)).toEqual(['1000']);

    const byValue = await ledger(f, {
      accountId: accountId(f, '5100'),
      dimensions: [{ dimensionId: f.department.id, valueIds: [ops] }],
    });
    expect(byValue.entries.map((entry) => entry.debit)).toEqual(['200']);

    const untagged = await ledger(f, {
      accountId: accountId(f, '5100'),
      dimensions: [{ dimensionId: f.department.id, includeUnassigned: true }],
    });
    expect(untagged.entries.map((entry) => entry.debit)).toEqual(['400']);

    // B6 at the smallest scale it can be stated: the axis's values plus unassigned
    // are the whole account.
    const unfiltered = await ledger(f, { accountId: accountId(f, '5100') });
    const sliced = [byValue, untagged, await slice(f, sales)].reduce(
      (total, part) => total + BigInt(part.movement.balance),
      0n,
    );
    expect(sliced.toString()).toBe(unfiltered.movement.balance);
  });

  it('is a 404 for an account this org does not own, and for one that never existed', async () => {
    const stranger = await fixture();

    await expect(ledger(f, { accountId: accountId(stranger, '1000') })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(ledger(f, { accountId: newUuid() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a cursor that did not come from this list', async () => {
    await expect(
      ledger(f, { accountId: accountId(f, '1000'), cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      ledger(f, { accountId: accountId(f, '1000'), from: '2026-06-01', to: '2026-05-01' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns an empty page rather than an error when the range holds nothing', async () => {
    const report = await ledger(f, {
      accountId: accountId(f, '5300'),
      from: '2026-01-01',
      to: '2026-01-31',
    });

    expect(report.entries).toEqual([]);
    expect(report.nextCursor).toBeNull();
    expect(report.opening.balance).toBe('0');
    expect(report.closing.balance).toBe('0');
  });
});

function slice(f: Fixture, valueId: string): Promise<GeneralLedger> {
  return ledger(f, {
    accountId: accountId(f, '5100'),
    dimensions: [{ dimensionId: f.department.id, valueIds: [valueId] }],
  });
}

/** Every page of a ledger, concatenated, at the given page size. */
async function readEveryPage(
  f: Fixture,
  account: string,
  limit: number,
): Promise<readonly GeneralLedgerEntry[]> {
  const entries: GeneralLedgerEntry[] = [];
  let cursor: string | undefined;

  do {
    const page: GeneralLedger = await ledger(f, {
      accountId: account,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return entries;
}
