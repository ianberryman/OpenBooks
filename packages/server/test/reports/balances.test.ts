import { beforeEach, describe, expect, it } from 'vitest';

import { newUuid } from '../../src/db';
import { NotFoundError, ValidationError } from '../../src/errors';
import { createDraft } from '../../src/modules/drafts';
import { getAccountBalances } from '../../src/modules/reports';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';

import type { Axis, Scene, SceneAccount } from './support';
import {
  contextFor,
  createAxis,
  createChart,
  createParty,
  createScene,
  groupFor,
  post,
  rowFor,
  useReportDatabase,
} from './support';

/**
 * The report core's behaviour, stated as examples (OB-041).
 *
 * The properties next door in `test/properties/report-*.test.ts` are what prove
 * the arithmetic — against the trial balance as an oracle, over generated
 * ledgers. What is here is the part a property cannot state: which accounts appear
 * at all, what a filter refuses, and which of the two obvious ways to write a
 * filter this code chose.
 */
const db = useReportDatabase();

interface Fixture {
  readonly scene: Scene;
  readonly accounts: ReadonlyMap<string, SceneAccount>;
  readonly department: Axis;
  readonly project: Axis;
}

/**
 * A chart with a parent that holds postings of its own, one untouched account, and
 * two axes.
 *
 * `5000` is the parent of `5100` and `5200` and is posted to directly, because a
 * parent that is only ever a heading makes the two numbers on a node — its own row
 * and its subtree's subtotal — indistinguishable, and a report that confused them
 * would pass.
 */
async function fixture(): Promise<Fixture> {
  const scene = await createScene(db);

  const accounts = await createChart(scene, [
    { code: '1000', type: 'asset', normalBalance: 'debit' },
    { code: '2000', type: 'liability', normalBalance: 'credit' },
    { code: '5000', type: 'expense', normalBalance: 'debit' },
    { code: '5100', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
    { code: '5200', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
    { code: '9000', type: 'equity', normalBalance: 'credit' },
  ]);

  return {
    scene,
    accounts,
    department: await createAxis(scene, 'DEPT', ['OPS', 'SALES']),
    project: await createAxis(scene, 'PROJ', ['ALPHA']),
  };
}

function accountId(accounts: ReadonlyMap<string, SceneAccount>, code: string): string {
  const account = accounts.get(code);
  if (account === undefined) throw new Error(`Fixture has no account ${code}.`);
  return account.id;
}

describe('the date range', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
    const cash = accountId(f.accounts, '1000');
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-01-15', [
      { accountId: rent, side: 'debit', amount: 10_000n },
      { accountId: cash, side: 'credit', amount: 10_000n },
    ]);
    await post(f.scene, '2026-03-01', [
      { accountId: rent, side: 'debit', amount: 2_500n },
      { accountId: cash, side: 'credit', amount: 2_500n },
    ]);
    await post(f.scene, '2026-06-30', [
      { accountId: rent, side: 'debit', amount: 700n },
      { accountId: cash, side: 'credit', amount: 700n },
    ]);
  });

  it('splits postings into opening, movement and closing at the lower bound', async () => {
    const report = await getAccountBalances({ from: '2026-03-01', to: '2026-03-31' }, f.scene.ctx);
    const group = groupFor(report.groups, null);
    const rent = rowFor(group, '5100');

    // Both bounds are inclusive, so the entry posted on `from` itself is movement
    // and not opening — the boundary an off-by-one would move.
    expect(rent.balance.opening.debits).toBe(10_000n);
    expect(rent.balance.movement.debits).toBe(2_500n);
    expect(rent.balance.closing.debits).toBe(12_500n);
    expect(report.range).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('has no opening balance when the range has no lower bound', async () => {
    const report = await getAccountBalances({ to: '2026-03-31' }, f.scene.ctx);
    const rent = rowFor(groupFor(report.groups, null), '5100');

    expect(rent.balance.opening.debits).toBe(0n);
    expect(rent.balance.movement.debits).toBe(12_500n);
    expect(rent.balance.closing.debits).toBe(12_500n);
  });

  it('includes every posting to date when neither bound is given', async () => {
    const report = await getAccountBalances({}, f.scene.ctx);
    const rent = rowFor(groupFor(report.groups, null), '5100');

    expect(rent.balance.closing.debits).toBe(13_200n);
    expect(report.range).toEqual({ from: null, to: null });
  });

  it('keeps accounts with no postings in the report, at zero', async () => {
    const report = await getAccountBalances({}, f.scene.ctx);
    const group = groupFor(report.groups, null);

    // The trial balance's rule, and for its reason: an account silently omitted
    // hides a chart-of-accounts mistake exactly when someone is looking for one.
    expect(group.rows.map((row) => row.code)).toEqual([
      '1000',
      '2000',
      '5000',
      '5100',
      '5200',
      '9000',
    ]);
    expect(rowFor(group, '9000').balance.closing).toEqual({
      debits: 0n,
      credits: 0n,
      balance: 0n,
    });
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(
      getAccountBalances({ from: '2026-03-31', to: '2026-03-01' }, f.scene.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('leaves drafts out of every report (D-19)', async () => {
    const before = await getAccountBalances({}, f.scene.ctx);

    await createDraft(
      {
        entryDate: '2026-02-01',
        lines: [
          { accountId: accountId(f.accounts, '5200'), side: 'debit', amount: '999999' },
          { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: '999999' },
        ],
      },
      f.scene.ctx,
    );

    // A draft has not happened. If this ever fails it will fail here rather than
    // in a total someone has already filed.
    expect(await getAccountBalances({}, f.scene.ctx)).toEqual(before);
  });
});

describe('the account-type filter', () => {
  it('keeps a subtree whole, because a parent’s type equals its children’s', async () => {
    const f = await fixture();
    await post(f.scene, '2026-02-02', [
      { accountId: accountId(f.accounts, '5000'), side: 'debit', amount: 300n },
      { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: 300n },
    ]);

    const report = await getAccountBalances({ types: ['expense'] }, f.scene.ctx);
    const group = groupFor(report.groups, null);

    expect(group.rows.map((row) => row.code)).toEqual(['5000', '5100', '5200']);
    expect(group.tree).toHaveLength(1);
    expect(group.tree[0]?.row.code).toBe('5000');
    expect(group.tree[0]?.children.map((child) => child.row.code)).toEqual(['5100', '5200']);
  });
});

describe('subtotals over the account tree (B7)', () => {
  it('separates a parent’s own postings from its subtree’s subtotal', async () => {
    const f = await fixture();
    const cash = accountId(f.accounts, '1000');

    await post(f.scene, '2026-02-01', [
      { accountId: accountId(f.accounts, '5000'), side: 'debit', amount: 100n },
      { accountId: cash, side: 'credit', amount: 100n },
    ]);
    await post(f.scene, '2026-02-02', [
      { accountId: accountId(f.accounts, '5100'), side: 'debit', amount: 20n },
      { accountId: cash, side: 'credit', amount: 20n },
    ]);
    await post(f.scene, '2026-02-03', [
      { accountId: accountId(f.accounts, '5200'), side: 'debit', amount: 3n },
      { accountId: cash, side: 'credit', amount: 3n },
    ]);

    const report = await getAccountBalances({}, f.scene.ctx);
    const parent = groupFor(report.groups, null).tree.find((node) => node.row.code === '5000');

    expect(parent?.row.balance.closing.debits).toBe(100n);
    expect(parent?.subtotal.closing.debits).toBe(123n);
  });
});

describe('grouping by a dimension axis', () => {
  let f: Fixture;
  let ops: string;
  let sales: string;

  beforeEach(async () => {
    f = await fixture();
    ops = valueId(f.department, 'OPS');
    sales = valueId(f.department, 'SALES');

    const cash = accountId(f.accounts, '1000');
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-04-01', [
      { accountId: rent, side: 'debit', amount: 600n, valueIds: [ops] },
      { accountId: rent, side: 'debit', amount: 400n, valueIds: [sales] },
      { accountId: rent, side: 'debit', amount: 100n },
      { accountId: cash, side: 'credit', amount: 1_100n },
    ]);
  });

  it('produces a bucket per value and an unassigned bucket, unassigned last', async () => {
    const report = await getAccountBalances({ groupBy: f.department.id }, f.scene.ctx);

    expect(report.groupBy).toBe(f.department.id);
    expect(report.groups.map((group) => group.key?.code ?? null)).toEqual(['OPS', 'SALES', null]);

    expect(rowFor(groupFor(report.groups, ops), '5100').balance.closing.debits).toBe(600n);
    expect(rowFor(groupFor(report.groups, sales), '5100').balance.closing.debits).toBe(400n);
    // The untagged rent line, and the whole of the credit to cash — which nothing
    // tagged either. This is the bucket D-18 says a slice view must not omit.
    expect(rowFor(groupFor(report.groups, null), '5100').balance.closing.debits).toBe(100n);
    expect(rowFor(groupFor(report.groups, null), '1000').balance.closing.credits).toBe(1_100n);
  });

  it('gives every bucket a row for every account', async () => {
    const report = await getAccountBalances({ groupBy: f.department.id }, f.scene.ctx);

    for (const group of report.groups) {
      expect(group.rows.map((row) => row.code)).toEqual([
        '1000',
        '2000',
        '5000',
        '5100',
        '5200',
        '9000',
      ]);
    }
  });

  it('keeps the unassigned bucket even when every line is tagged', async () => {
    const scene = await createScene(db);
    const axis = await createAxis(scene, 'TEAM', ['ONE']);
    const chart = await createChart(scene, [
      { code: '1000', type: 'asset', normalBalance: 'debit' },
      { code: '5000', type: 'expense', normalBalance: 'debit' },
    ]);
    const one = valueId(axis, 'ONE');

    await post(scene, '2026-05-01', [
      { accountId: accountId(chart, '5000'), side: 'debit', amount: 50n, valueIds: [one] },
      { accountId: accountId(chart, '1000'), side: 'credit', amount: 50n, valueIds: [one] },
    ]);

    const report = await getAccountBalances({ groupBy: axis.id }, scene.ctx);

    // Present and empty, rather than absent. A consumer that had to check whether
    // the bucket exists is a consumer that will forget to.
    expect(report.groups.map((group) => group.key?.code ?? null)).toEqual(['ONE', null]);
    expect(groupFor(report.groups, null).totals.closing).toEqual({
      debits: 0n,
      credits: 0n,
      balance: 0n,
    });
  });
});

describe('filters', () => {
  it('narrows to the named dimension values without dropping accounts', async () => {
    const f = await fixture();
    const ops = valueId(f.department, 'OPS');
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-04-01', [
      { accountId: rent, side: 'debit', amount: 600n, valueIds: [ops] },
      { accountId: rent, side: 'debit', amount: 400n, valueIds: [valueId(f.department, 'SALES')] },
      { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: 1_000n },
    ]);

    const report = await getAccountBalances(
      { dimensions: [{ dimensionId: f.department.id, valueIds: [ops] }] },
      f.scene.ctx,
    );
    const group = groupFor(report.groups, null);

    expect(rowFor(group, '5100').balance.closing.debits).toBe(600n);
    // The cash line carries no department, so it is filtered out — and the account
    // stays in the report at zero rather than vanishing from the chart.
    expect(rowFor(group, '1000').balance.closing.credits).toBe(0n);
    expect(group.rows).toHaveLength(6);
  });

  it('filters to the untagged lines when includeUnassigned is set', async () => {
    const f = await fixture();
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-04-01', [
      { accountId: rent, side: 'debit', amount: 600n, valueIds: [valueId(f.department, 'OPS')] },
      { accountId: rent, side: 'debit', amount: 100n },
      { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: 700n },
    ]);

    const report = await getAccountBalances(
      { dimensions: [{ dimensionId: f.department.id, includeUnassigned: true }] },
      f.scene.ctx,
    );

    expect(rowFor(groupFor(report.groups, null), '5100').balance.closing.debits).toBe(100n);
  });

  it('does not multiply a line that carries two axes', async () => {
    const f = await fixture();
    const ops = valueId(f.department, 'OPS');
    const alpha = valueId(f.project, 'ALPHA');
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-04-01', [
      { accountId: rent, side: 'debit', amount: 900n, valueIds: [ops, alpha] },
      { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: 900n },
    ]);

    const report = await getAccountBalances(
      {
        dimensions: [
          { dimensionId: f.department.id, valueIds: [ops] },
          { dimensionId: f.project.id, valueIds: [alpha] },
        ],
      },
      f.scene.ctx,
    );

    // 900 and not 1,800. Two filters are two semi-joins; joining the tag table
    // twice instead would count this line once per axis it carries.
    expect(rowFor(groupFor(report.groups, null), '5100').balance.closing.debits).toBe(900n);
  });

  it('filters by contact', async () => {
    const f = await fixture();
    const supplier = await createParty(f.scene, 'Landlord');
    const rent = accountId(f.accounts, '5100');

    await post(f.scene, '2026-04-01', [
      { accountId: rent, side: 'debit', amount: 400n, contactId: supplier },
      { accountId: rent, side: 'debit', amount: 60n },
      { accountId: accountId(f.accounts, '1000'), side: 'credit', amount: 460n },
    ]);

    const report = await getAccountBalances({ contactId: supplier }, f.scene.ctx);
    expect(rowFor(groupFor(report.groups, null), '5100').balance.closing.debits).toBe(400n);
  });

  it('refuses two filters on the same axis', async () => {
    const f = await fixture();

    await expect(
      getAccountBalances(
        {
          dimensions: [
            { dimensionId: f.department.id, valueIds: [valueId(f.department, 'OPS')] },
            { dimensionId: f.department.id, valueIds: [valueId(f.department, 'SALES')] },
          ],
        },
        f.scene.ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a filter that names neither values nor the unassigned bucket', async () => {
    const f = await fixture();

    await expect(
      getAccountBalances({ dimensions: [{ dimensionId: f.department.id }] }, f.scene.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ids a filter names are resolved, not passed through (A7)', () => {
  it('answers a nonexistent dimension with a 404 rather than a report of zeros', async () => {
    const f = await fixture();

    await expect(getAccountBalances({ groupBy: newUuid() }, f.scene.ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('answers a value belonging to another axis with the same 404', async () => {
    const f = await fixture();

    await expect(
      getAccountBalances(
        {
          dimensions: [{ dimensionId: f.department.id, valueIds: [valueId(f.project, 'ALPHA')] }],
        },
        f.scene.ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers another org’s dimension exactly as it answers a nonexistent one', async () => {
    const mine = await fixture();
    const theirs = await fixture();

    const foreign = await getAccountBalances({ groupBy: theirs.department.id }, mine.scene.ctx)
      .then(() => null)
      .catch((error: unknown) => error);
    const missing = await getAccountBalances({ groupBy: newUuid() }, mine.scene.ctx)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
  });
});

describe('permission', () => {
  it('is readable by a role that holds reports.read and nothing that writes', async () => {
    const f = await fixture();
    const user = await db.factories.user();
    await db.factories.orgMember({
      orgId: f.scene.orgId,
      userId: user.id,
      roleId: systemRoleId('readOnly'),
    });

    const readOnly = contextFor(f.scene.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, user.uuid);
    await expect(getAccountBalances({}, readOnly)).resolves.toBeDefined();
  });
});

function valueId(axis: Axis, code: string): string {
  const id = axis.values.get(code);
  if (id === undefined) throw new Error(`Axis has no value ${code}.`);
  return id;
}
