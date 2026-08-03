import type { QuickBooksImportRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import { ConflictError, PreconditionFailedError } from '../../src/errors';
import { createAccount, listAccounts } from '../../src/modules/accounts';
import { listContacts } from '../../src/modules/contacts';
import {
  importQuickBooks,
  previewQuickBooksImport,
} from '../../src/modules/imports/quickbooks/service';
import { getTrialBalance } from '../../src/modules/ledger';
import { getControlAccounts } from '../../src/modules/settings';
import { actorIn, useServiceDatabase } from '../accounts/support';

/**
 * The QuickBooks CSV migration importer end to end (Phase 3, the launch gate),
 * against real MySQL. The pure parsing rules are covered in
 * `quickbooks-parse.test.ts`; this proves the service composes them with
 * `createAccount`, `createContact`, and `postJournal` correctly — a preview that
 * writes nothing, a commit that is genuinely all-or-nothing, and an opening
 * journal that lands as a real, balanced posting a report can read back.
 */

const db = useServiceDatabase();

const ACCOUNTS_CSV =
  'Name,Type,Number\n' +
  'Operating bank account,Bank,1010\n' +
  'Trade debtors,Accounts Receivable,1200\n' +
  'Trade creditors,Accounts Payable,2010\n' +
  'Owner equity,Equity,3000\n' +
  'Consulting revenue,Income,4000\n' +
  'Office expense,Expense,6000\n';

const CUSTOMERS_CSV =
  'Name,Number,Email\nAcme Co,C001,ap@acme.test\nShared Party,,shared@test.example\n';
const VENDORS_CSV = 'Name,Number\nSupplies Inc,V009\nShared Party,\n';

/** Balances exactly: 800.00 + 200.00 debit against 500.00 + 500.00 credit. */
const BALANCED_TB_CSV =
  'Account,Debit,Credit\n1010,800.00,\n1200,200.00,\n2010,,500.00\n4000,,500.00\n';

const UNBALANCED_TB_CSV = 'Account,Debit,Credit\n1010,800.00,\n2010,,500.00\n';

const UNMATCHED_TB_CSV = 'Account,Debit,Credit\n1010,800.00,\n9999,,800.00\n';

function baseRequest(overrides: Partial<QuickBooksImportRequest> = {}): QuickBooksImportRequest {
  return {
    asOfDate: '2026-01-15',
    accounts: ACCOUNTS_CSV,
    customers: CUSTOMERS_CSV,
    vendors: VENDORS_CSV,
    ...overrides,
  };
}

describe('previewQuickBooksImport', () => {
  it('reports the accounts and contacts it would create, and writes nothing', async () => {
    const actor = await actorIn(db);

    const preview = await runInContext(actor.ctx, () =>
      previewQuickBooksImport(baseRequest({ trialBalance: BALANCED_TB_CSV }), actor.ctx),
    );

    expect(preview.accounts.toCreate).toBe(6);
    expect(preview.accounts.conflicts).toEqual([]);
    expect(preview.accounts.drafts.map((a) => a.code).sort()).toEqual(
      ['1010', '1200', '2010', '3000', '4000', '6000'].sort(),
    );

    // Acme Co (customer) and Supplies Inc (vendor) each once; Shared Party merges
    // into one contact carrying both flags.
    expect(preview.contacts.customers).toBe(2);
    expect(preview.contacts.vendors).toBe(2);
    expect(preview.contacts.drafts).toHaveLength(3);
    const shared = preview.contacts.drafts.find((c) => c.displayName === 'Shared Party');
    expect(shared).toMatchObject({ isCustomer: true, isVendor: true });

    expect(preview.openingBalance).toMatchObject({
      balanced: true,
      totalDebits: '100000',
      totalCredits: '100000',
      lineCount: 4,
      unmatchedAccounts: [],
    });
    expect(preview.issues).toEqual([]);

    // Nothing was written.
    expect(await listAccounts({}, actor.ctx)).toMatchObject({ items: [] });
    expect(await listContacts({}, actor.ctx)).toMatchObject({ items: [] });
  });

  it('reports existing codes as conflicts without refusing the preview', async () => {
    const actor = await actorIn(db);
    await createAccount(
      { code: '1010', name: 'Already here', type: 'asset', normalBalance: 'debit' },
      actor.ctx,
    );

    const preview = await runInContext(actor.ctx, () =>
      previewQuickBooksImport(baseRequest(), actor.ctx),
    );

    expect(preview.accounts.conflicts).toEqual(['1010']);
  });

  it('flags an unbalanced trial balance without refusing the preview', async () => {
    const actor = await actorIn(db);

    const preview = await runInContext(actor.ctx, () =>
      previewQuickBooksImport(baseRequest({ trialBalance: UNBALANCED_TB_CSV }), actor.ctx),
    );

    expect(preview.openingBalance?.balanced).toBe(false);
    expect(preview.openingBalance?.totalDebits).toBe('80000');
    expect(preview.openingBalance?.totalCredits).toBe('50000');
  });

  it('flags a trial-balance line naming an account the chart does not contain', async () => {
    const actor = await actorIn(db);

    const preview = await runInContext(actor.ctx, () =>
      previewQuickBooksImport(baseRequest({ trialBalance: UNMATCHED_TB_CSV }), actor.ctx),
    );

    expect(preview.openingBalance?.unmatchedAccounts).toEqual(['9999']);
  });

  it('has no opening balance when no trial balance was sent', async () => {
    const actor = await actorIn(db);

    const preview = await runInContext(actor.ctx, () =>
      previewQuickBooksImport(baseRequest(), actor.ctx),
    );

    expect(preview.openingBalance).toBeNull();
  });
});

describe('importQuickBooks', () => {
  it('creates accounts and contacts, posts a balanced journal, sets control accounts', async () => {
    const actor = await actorIn(db);

    const result = await runInContext(actor.ctx, () =>
      importQuickBooks(baseRequest({ trialBalance: BALANCED_TB_CSV }), actor.ctx),
    );

    expect(result.accountsCreated).toBe(6);
    expect(result.customersCreated).toBe(2);
    expect(result.vendorsCreated).toBe(2);
    expect(result.openingJournalId).not.toBeNull();

    const accounts = await listAccounts({ limit: 50 }, actor.ctx);
    expect(accounts.items).toHaveLength(6);

    const contacts = await listContacts({ limit: 50 }, actor.ctx);
    expect(contacts.items).toHaveLength(3);
    const shared = contacts.items.find((c) => c.displayName === 'Shared Party');
    expect(shared).toMatchObject({ isCustomer: true, isVendor: true });

    // The opening journal reflects the trial balance's own figures.
    const trialBalance = await getTrialBalance({}, actor.ctx);
    expect(trialBalance.totalDebits).toBe(trialBalance.totalCredits);
    expect(trialBalance.difference).toBe('0');
    const bank = trialBalance.rows.find((row) => row.code === '1010');
    expect(bank?.debits).toBe('80000');
    const revenue = trialBalance.rows.find((row) => row.code === '4000');
    expect(revenue?.credits).toBe('50000');

    // The account whose QuickBooks type was Accounts Receivable / Accounts
    // Payable is nominated as the org's control account for that side.
    const receivable = accounts.items.find((a) => a.code === '1200');
    const payable = accounts.items.find((a) => a.code === '2010');
    expect(await getControlAccounts(actor.ctx)).toEqual({
      receivableControlAccountId: receivable?.id ?? null,
      payableControlAccountId: payable?.id ?? null,
      inventoryShrinkageAccountId: null,
    });
  });

  it('creates the chart and contacts with no trial balance sent, posting no journal', async () => {
    const actor = await actorIn(db);

    const result = await runInContext(actor.ctx, () => importQuickBooks(baseRequest(), actor.ctx));

    expect(result.accountsCreated).toBe(6);
    expect(result.openingJournalId).toBeNull();
    expect((await getTrialBalance({}, actor.ctx)).rows.every((row) => row.debits === '0')).toBe(
      true,
    );
  });

  it('refuses an unbalanced trial balance and writes nothing', async () => {
    const actor = await actorIn(db);

    await expect(
      runInContext(actor.ctx, () =>
        importQuickBooks(baseRequest({ trialBalance: UNBALANCED_TB_CSV }), actor.ctx),
      ),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ precondition: 'opening_balance_unbalanced' }) as unknown,
    });

    expect((await listAccounts({}, actor.ctx)).items).toEqual([]);
  });

  it('refuses a trial-balance line naming an unknown account and writes nothing', async () => {
    const actor = await actorIn(db);

    const error: unknown = await runInContext(actor.ctx, () =>
      importQuickBooks(baseRequest({ trialBalance: UNMATCHED_TB_CSV }), actor.ctx),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect((error as PreconditionFailedError).details).toMatchObject({
      precondition: 'opening_balance_unknown_account',
    });
    expect((await listAccounts({}, actor.ctx)).items).toEqual([]);
  });

  it('refuses on an account code collision and writes nothing else', async () => {
    const actor = await actorIn(db);
    await createAccount(
      { code: '1010', name: 'Already here', type: 'asset', normalBalance: 'debit' },
      actor.ctx,
    );

    await expect(
      runInContext(actor.ctx, () => importQuickBooks(baseRequest(), actor.ctx)),
    ).rejects.toBeInstanceOf(ConflictError);

    // The one pre-existing account is untouched, and nothing else landed.
    const accounts = await listAccounts({}, actor.ctx);
    expect(accounts.items.map((a) => a.code)).toEqual(['1010']);
    expect((await listContacts({}, actor.ctx)).items).toEqual([]);
  });
});
