import { ACCOUNT_CODE_MAX_LENGTH, ACCOUNT_MAX_DEPTH } from '@openbooks/shared-types';
import type { Account } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { runInContext } from '../../src/context';
import { ConflictError, PermissionDeniedError, ValidationError } from '../../src/errors';
import {
  CHART_TEMPLATES,
  applyChartTemplate,
  createAccount,
  getAccount,
  listAccounts,
  listChartTemplates,
} from '../../src/modules/accounts';
import type { ChartTemplate } from '../../src/modules/accounts';
import { getTrialBalance, postJournal } from '../../src/modules/ledger';
import { getControlAccounts, updateControlAccounts } from '../../src/modules/settings';
import { actorIn, useServiceDatabase } from './support';

/**
 * Starter charts of accounts (OB-039, D-23) against real MySQL.
 *
 * The claim these tests have to support is not "the data was copied". It is that a
 * template goes in through the same door a hand-typed account does, so everything
 * `createAccount` enforces is enforced on it too. That has a consequence for how the
 * suite is written: the hierarchy rules are **not** re-asserted by walking the
 * template array and checking that parents precede children. That would be a test of
 * the fixture, and it would pass against an implementation that inserted rows
 * directly and skipped `hierarchy.ts` entirely.
 *
 * So the chart is exercised as a chart. It is posted into, which requires the
 * accounts to exist, to be active, and to be reachable in the org; an account is
 * created under one of the template's parents with the wrong type, which is refused
 * only if those parents are real nodes `resolveAssignableParent` walks; and the whole
 * application is re-run, concurrently and sequentially, to pin the collision path and
 * the transaction boundary.
 *
 * The one suite that reads the template data is the authoring guard at the bottom,
 * and it is deliberately separate. Its subject is the shipped content rather than the
 * mechanism: its job is that a bad edit to `chart-templates.ts` fails in CI instead of
 * in an org.
 */
const db = useServiceDatabase();

const GENERAL = CHART_TEMPLATES.general_small_business;

/** The whole chart, paged through, because `listAccounts` returns one bounded page. */
async function wholeChart(ctx: RequestContext): Promise<readonly Account[]> {
  const items: Account[] = [];
  let cursor: string | undefined;

  do {
    const page = await listAccounts(
      { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
      ctx,
    );
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return items;
}

/**
 * Fails the test rather than substituting a placeholder id. A missing account has to
 * surface here and not as a `not_found` three lines later, which would read like the
 * operation under test refusing something.
 */
function accountFor(chart: readonly Account[], code: string): Account {
  const found = chart.find((account) => account.code === code);
  if (found === undefined) throw new Error(`The applied chart has no account ${code}.`);
  return found;
}

describe('listing the templates on offer', () => {
  it('describes the general chart without disclosing its accounts', async () => {
    const actor = await actorIn(db);

    const templates = await listChartTemplates(actor.ctx);

    expect(templates).toContainEqual({
      id: 'general_small_business',
      name: GENERAL.name,
      description: GENERAL.description,
      accountCount: GENERAL.accounts.length,
    });

    // The summary is an identity plus a count (D-23). A client that could read the
    // accounts would be holding something to diff its chart against later, which is
    // the relationship a copy deliberately does not create.
    for (const template of templates) {
      expect(Object.keys(template).sort()).toEqual(['accountCount', 'description', 'id', 'name']);
    }
  });

  it('is available to a role that can read the chart but not write it', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(listChartTemplates(actor.ctx)).resolves.toHaveLength(
      Object.keys(CHART_TEMPLATES).length,
    );
  });
});

describe('applying a template to a new org', () => {
  it('creates every account, once, and nothing else', async () => {
    const actor = await actorIn(db);

    const applied = await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);

    expect(applied.templateId).toBe('general_small_business');
    expect(applied.accounts).toHaveLength(GENERAL.accounts.length);

    const chart = await wholeChart(actor.ctx);
    expect(chart).toHaveLength(GENERAL.accounts.length);
    expect(new Set(chart.map((account) => account.code)).size).toBe(chart.length);

    // Every account arrives active with a real id — the return value is what a caller
    // uses to keep extending the tree without paging the list back.
    for (const account of applied.accounts) {
      expect(account.isActive).toBe(true);
      await expect(getAccount(account.id, actor.ctx)).resolves.toMatchObject({ id: account.id });
    }
  });

  it('lands the four contra accounts on the side that makes them contra', async () => {
    const actor = await actorIn(db);
    await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);
    const chart = await wholeChart(actor.ctx);

    /**
     * The one thing a starter chart can get wrong invisibly. `0002_ledger` declines
     * to constrain `normal_balance` against `type` precisely so these are
     * expressible, and an inverted contra account does not fail — it reports with the
     * wrong sign, which reads as a data problem months later rather than as a setup
     * problem now.
     */
    expect(accountFor(chart, '1150')).toMatchObject({ type: 'asset', normalBalance: 'credit' });
    expect(accountFor(chart, '1590')).toMatchObject({ type: 'asset', normalBalance: 'credit' });
    expect(accountFor(chart, '3100')).toMatchObject({ type: 'equity', normalBalance: 'debit' });
    expect(accountFor(chart, '4090')).toMatchObject({ type: 'revenue', normalBalance: 'debit' });
  });

  it('builds a real tree, not a flat list wearing parent ids', async () => {
    const actor = await actorIn(db);
    await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);
    const chart = await wholeChart(actor.ctx);

    const currentAssets = accountFor(chart, '1000');
    expect(accountFor(chart, '1010').parentAccountId).toBe(currentAssets.id);
    expect(currentAssets.parentAccountId).toBeNull();

    /**
     * The proof that the template's parents went through `resolveAssignableParent`
     * rather than being written as column values: a liability under an asset parent
     * is refused, which only the hierarchy code knows to do. A row written by a second
     * insert path would carry the same `parent_account_id` and no such rule.
     */
    await expect(
      createAccount(
        {
          code: '9100',
          name: 'Misfiled liability',
          type: 'liability',
          normalBalance: 'credit',
          parentAccountId: currentAssets.id,
        },
        actor.ctx,
      ),
    ).rejects.toMatchObject({ details: { precondition: 'account_parent_type_mismatch' } });
  });

  it('is a chart you can post into, contra accounts included', async () => {
    const actor = await actorIn(db);
    const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
    await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);
    const chart = await wholeChart(actor.ctx);

    // Inside the context scope, not merely holding a context object: the period lock
    // `postJournal` takes reads the context ambiently, so a test that passed `ctx` as
    // an argument alone would exercise a path production never takes.
    const post = async (debit: string, credit: string, amount: bigint): Promise<void> => {
      await runInContext(actor.ctx, async () => {
        await postJournal({
          date: period.startDate,
          memo: 'Applied chart smoke test',
          actorType: 'user',
          actorId: actor.userUuid,
          lines: [
            { accountId: accountFor(chart, debit).id, side: 'debit', amount },
            { accountId: accountFor(chart, credit).id, side: 'credit', amount },
          ],
        });
      });
    };

    // An invoice collected into the bank, and a month of depreciation against the
    // contra asset. The second is the one worth posting: 1590 is an `asset` being
    // credited, so a template that had guessed its normal balance from its type would
    // still accept this journal and would report fixed assets at cost forever.
    await post('1010', '4020', 150000n);
    await post('6030', '1590', 25000n);

    const trialBalance = await getTrialBalance({}, actor.ctx);
    expect(trialBalance.totalDebits).toBe(trialBalance.totalCredits);
    expect(trialBalance.difference).toBe('0');

    const depreciation = trialBalance.rows.find((row) => row.code === '1590');
    expect(depreciation?.credits).toBe('25000');
    expect(depreciation?.normalBalance).toBe('credit');
  });
});

/**
 * D-23 makes a chart template opt-in, and OB-066a makes applying one nominate the
 * control accounts it creates — because the org that takes the template is the org
 * that would otherwise meet `receivable_control_account_not_set` on a chart that
 * obviously contains the answer.
 */
describe('applying a template nominates the control accounts', () => {
  it('points the org at the accounts the template just created', async () => {
    const actor = await actorIn(db);
    const applied = await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);

    const byCode = new Map(applied.accounts.map((account) => [account.code, account.id]));
    const { receivable, payable } = GENERAL.controlAccountCodes;

    expect(await getControlAccounts(actor.ctx)).toEqual({
      receivableControlAccountId: receivable === null ? null : byCode.get(receivable),
      payableControlAccountId: payable === null ? null : byCode.get(payable),
    });
  });

  /**
   * An org that had already chosen its control accounts and then applied a template
   * must not have its postings silently redirected — which is the failure the
   * nomination exists to remove, arriving from the other direction.
   */
  it('leaves an existing nomination alone', async () => {
    const actor = await actorIn(db);
    const mine = await createAccount(
      {
        code: '1101',
        name: 'Trade debtors',
        type: 'asset',
        normalBalance: 'debit',
        parentAccountId: null,
      },
      actor.ctx,
    );
    await updateControlAccounts({ receivableControlAccountId: mine.id }, actor.ctx);

    const applied = await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);
    const byCode = new Map(applied.accounts.map((account) => [account.code, account.id]));

    const settings = await getControlAccounts(actor.ctx);
    // Kept, and the untouched side still filled in from the template.
    expect(settings.receivableControlAccountId).toBe(mine.id);
    expect(settings.payableControlAccountId).toBe(
      byCode.get(GENERAL.controlAccountCodes.payable ?? ''),
    );
  });
});

describe('applying a template to an org that already has accounts', () => {
  it('applies cleanly when nothing collides', async () => {
    const actor = await actorIn(db);
    await createAccount(
      { code: '9000', name: 'Suspense', type: 'asset', normalBalance: 'debit' },
      actor.ctx,
    );

    await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);

    // Refusing every non-empty org would have been the simpler rule and would have
    // excluded exactly the org a starter chart helps — one that created its bank
    // account before it found the operation.
    const chart = await wholeChart(actor.ctx);
    expect(chart).toHaveLength(GENERAL.accounts.length + 1);
  });

  it('refuses on a code collision, names every one of them, and writes nothing', async () => {
    const actor = await actorIn(db);
    const existing = await createAccount(
      { code: '1010', name: 'The bank we already had', type: 'asset', normalBalance: 'debit' },
      actor.ctx,
    );
    await createAccount(
      { code: '4020', name: 'Consulting', type: 'revenue', normalBalance: 'credit' },
      actor.ctx,
    );

    const error: unknown = await applyChartTemplate(
      { templateId: 'general_small_business' },
      actor.ctx,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toEqual({ codes: ['1010', '4020'] });

    // Nothing applied and nothing overwritten: the org's chart is the two accounts it
    // had, still carrying the names it gave them.
    const chart = await wholeChart(actor.ctx);
    expect(chart.map((account) => account.code)).toEqual(['1010', '4020']);
    expect(accountFor(chart, '1010').name).toBe(existing.name);
  });

  it('refuses a second application of the same template', async () => {
    const actor = await actorIn(db);
    await applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx);

    await expect(
      applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx),
    ).rejects.toBeInstanceOf(ConflictError);

    // Re-application is neither a merge nor a no-op — it is refused, so the chart is
    // untouched rather than doubled or half-doubled.
    const chart = await wholeChart(actor.ctx);
    expect(chart).toHaveLength(GENERAL.accounts.length);
  });

  /**
   * Two applications genuinely in flight against one org, on two pooled connections,
   * rather than a sequential simulation of the race. The pre-check cannot make the
   * collision safe by itself: a concurrent application can pass it and then reach the
   * insert. `uq_accounts_org_code` is what closes that window, and `insertAccount`'s
   * errno 1062 translation is what makes the loser a 409 naming a code instead of an
   * opaque 500 — which is the only reason a check-then-act is acceptable here, the
   * same argument `deleteAccount` makes about `ON DELETE RESTRICT`.
   */
  it('lets exactly one of two concurrent applications win', async () => {
    const actor = await actorIn(db);

    const outcomes = await Promise.allSettled([
      applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx),
      applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);

    // `code`, singular, and that is the assertion that makes this a contention test
    // rather than a repeat of the sequential case above. The pre-check reports
    // `codes` (plural, every collision it saw); `insertAccount`'s errno 1062
    // translation reports `code` (the one that collided). Seeing the singular means
    // the loser really did pass the pre-check on its own snapshot and was stopped by
    // `uq_accounts_org_code` at the insert — which is the window the pre-check cannot
    // close and the constraint does.
    expect((rejected[0]?.reason as ConflictError).details).toHaveProperty('code');

    // The loser rolled its partial chart back, so the org holds one copy and not one
    // and a fraction.
    const chart = await wholeChart(actor.ctx);
    expect(chart).toHaveLength(GENERAL.accounts.length);
  });
});

describe('the surface around applying', () => {
  it('requires accounts.write', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(
      applyChartTemplate({ templateId: 'general_small_business' }, actor.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    expect(await wholeChart(actor.ctx)).toEqual([]);
  });

  it('rejects an unknown template as a validation failure, not a miss', async () => {
    const actor = await actorIn(db);

    // The set of templates is fixed at build time and identical for every org, so
    // naming one that does not exist is a malformed request rather than a lookup that
    // missed. There is no cross-org existence here for A7 to protect.
    await expect(
      applyChartTemplate({ templateId: 'no_such_template' } as never, actor.ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

/**
 * The authoring guard on the shipped content.
 *
 * Everything above drives the service. This asserts the data itself is well-formed,
 * so a bad edit to `chart-templates.ts` fails here rather than as a `ConflictError` or
 * an `InternalError` in someone's org. It is the only place the template array is read
 * directly, which is why it is kept apart from the suites that exercise an applied
 * chart.
 */
describe('the shipped template data', () => {
  const templates: readonly ChartTemplate[] = Object.values(CHART_TEMPLATES);

  /**
   * A template that named a control account it does not create would be an
   * `InternalError` at apply time — in somebody's org, on the one operation that is
   * supposed to be the easy path. Checked here, against the data.
   */
  it('names control accounts it creates, of the type each side requires', () => {
    for (const template of templates) {
      const byCode = new Map(template.accounts.map((entry) => [entry.code, entry]));
      const { receivable, payable } = template.controlAccountCodes;

      if (receivable !== null) expect(byCode.get(receivable)?.type).toBe('asset');
      if (payable !== null) expect(byCode.get(payable)?.type).toBe('liability');
    }
  });

  it('registers every template under the id it carries', () => {
    for (const [key, template] of Object.entries(CHART_TEMPLATES)) {
      expect(template.id).toBe(key);
    }
  });

  it('uses unique codes that fit the column and sort in statement order', () => {
    for (const template of templates) {
      const codes = template.accounts.map((entry) => entry.code);
      expect(new Set(codes).size).toBe(codes.length);

      for (const code of codes) {
        expect(code.length).toBeLessThanOrEqual(ACCOUNT_CODE_MAX_LENGTH);
        expect(code).toBe(code.trim());
      }

      // Fixed-width codes are what make the textual ordering the repository uses
      // (`ACCOUNT_KEYSET`) agree with the numeric one a reader expects — otherwise
      // '1100' sorts before '900'.
      expect([...codes].sort()).toEqual(codes);
    }
  });

  it('names every parent before its children, sharing its type, within the depth bound', () => {
    for (const template of templates) {
      const seen = new Map<string, { readonly type: string; readonly depth: number }>();

      for (const entry of template.accounts) {
        if (entry.parentCode === null) {
          seen.set(entry.code, { type: entry.type, depth: 1 });
          continue;
        }

        const parent = seen.get(entry.parentCode);
        expect(parent, `${entry.code} names ${entry.parentCode} before it exists`).toBeDefined();
        expect(parent?.type).toBe(entry.type);

        const depth = (parent?.depth ?? 0) + 1;
        expect(depth).toBeLessThanOrEqual(ACCOUNT_MAX_DEPTH);
        seen.set(entry.code, { type: entry.type, depth });
      }
    }
  });
});
