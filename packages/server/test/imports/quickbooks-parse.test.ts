import { toDecimalString } from '@openbooks/shared-types/money';
import { describe, expect, it } from 'vitest';

import {
  isQuickBooksPayableType,
  isQuickBooksReceivableType,
  mapQuickBooksAccountType,
} from '../../src/modules/imports/quickbooks/mapping';
import {
  parseAccountsCsv,
  parseContactsCsv,
  parseTrialBalanceCsv,
} from '../../src/modules/imports/quickbooks/parse';

/**
 * Pure, no-database tests for the QuickBooks CSV importer's parsing layer
 * (`mapping.ts`, `parse.ts` — Phase 3, the launch gate). No `useTestDatabase()`:
 * these take strings and return data plus issues, which is the whole point of
 * keeping them free of `ctx` and the database (`parse.ts`'s file header).
 */

describe('mapQuickBooksAccountType', () => {
  it('maps every QuickBooks asset type to asset/debit', () => {
    for (const raw of [
      'Bank',
      'Accounts Receivable',
      'Other Current Asset',
      'Fixed Asset',
      'Other Asset',
      'Inventory',
    ]) {
      expect(mapQuickBooksAccountType(raw)).toEqual({ type: 'asset', normalBalance: 'debit' });
    }
  });

  it('maps every QuickBooks liability type to liability/credit', () => {
    for (const raw of [
      'Accounts Payable',
      'Credit Card',
      'Other Current Liability',
      'Long Term Liability',
      'Other Liability',
    ]) {
      expect(mapQuickBooksAccountType(raw)).toEqual({ type: 'liability', normalBalance: 'credit' });
    }
  });

  it('maps Equity to equity/credit', () => {
    expect(mapQuickBooksAccountType('Equity')).toEqual({ type: 'equity', normalBalance: 'credit' });
  });

  it('maps Income and Other Income to revenue/credit', () => {
    expect(mapQuickBooksAccountType('Income')).toEqual({
      type: 'revenue',
      normalBalance: 'credit',
    });
    expect(mapQuickBooksAccountType('Other Income')).toEqual({
      type: 'revenue',
      normalBalance: 'credit',
    });
  });

  it('maps every QuickBooks expense type to expense/debit', () => {
    for (const raw of ['Cost of Goods Sold', 'Expense', 'Other Expense']) {
      expect(mapQuickBooksAccountType(raw)).toEqual({ type: 'expense', normalBalance: 'debit' });
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(mapQuickBooksAccountType('  bank  ')).toEqual({ type: 'asset', normalBalance: 'debit' });
    expect(mapQuickBooksAccountType('ACCOUNTS PAYABLE')).toEqual({
      type: 'liability',
      normalBalance: 'credit',
    });
  });

  it('accepts the five domain type names directly, deriving normalBalance', () => {
    expect(mapQuickBooksAccountType('asset')).toEqual({ type: 'asset', normalBalance: 'debit' });
    expect(mapQuickBooksAccountType('expense')).toEqual({
      type: 'expense',
      normalBalance: 'debit',
    });
    expect(mapQuickBooksAccountType('liability')).toEqual({
      type: 'liability',
      normalBalance: 'credit',
    });
    expect(mapQuickBooksAccountType('equity')).toEqual({ type: 'equity', normalBalance: 'credit' });
    expect(mapQuickBooksAccountType('revenue')).toEqual({
      type: 'revenue',
      normalBalance: 'credit',
    });
  });

  it('returns null for anything unmapped', () => {
    expect(mapQuickBooksAccountType('Not A Real Type')).toBeNull();
    expect(mapQuickBooksAccountType('')).toBeNull();
    expect(mapQuickBooksAccountType('   ')).toBeNull();
  });

  it('identifies the receivable and payable control types, case-insensitively', () => {
    expect(isQuickBooksReceivableType('accounts receivable')).toBe(true);
    expect(isQuickBooksReceivableType('Accounts Payable')).toBe(false);
    expect(isQuickBooksPayableType(' Accounts Payable ')).toBe(true);
    expect(isQuickBooksPayableType('Bank')).toBe(false);
  });
});

describe('parseAccountsCsv', () => {
  it('parses a well-formed row with an explicit Number', () => {
    const csv = 'Name,Type,Number,Description\nOperating bank account,Bank,1010,Main checking\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(issues).toEqual([]);
    expect(accounts).toEqual([
      {
        code: '1010',
        name: 'Operating bank account',
        type: 'asset',
        normalBalance: 'debit',
        qbType: 'Bank',
      },
    ]);
  });

  it('matches header names case-insensitively and in any column order', () => {
    const csv = 'type,name\nExpense,Office supplies\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(issues).toEqual([]);
    expect(accounts).toEqual([
      {
        code: 'OFFICE-SUPPLIES',
        name: 'Office supplies',
        type: 'expense',
        normalBalance: 'debit',
        qbType: 'Expense',
      },
    ]);
  });

  it('synthesizes a deterministic, unique code from Name when Number is blank', () => {
    const csv = 'Name,Type,Number\nOperating bank account,Bank,\nSavings account,Bank,\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(issues).toEqual([]);
    expect(accounts.map((a) => a.code)).toEqual(['OPERATING-BANK-ACCOUNT', 'SAVINGS-ACCOUNT']);
  });

  it('suffixes -2, -3, … on a synthesized-code collision, never -1', () => {
    const csv = 'Name,Type\nCash,Bank\nCash,Bank\nCash,Bank\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(issues).toEqual([]);
    expect(accounts.map((a) => a.code)).toEqual(['CASH', 'CASH-2', 'CASH-3']);
  });

  it('does not let a synthesized code collide with an explicit one appearing earlier', () => {
    const csv = 'Name,Type,Number\nCash,Bank,CASH\nCash,Bank,\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(issues).toEqual([]);
    expect(accounts.map((a) => a.code)).toEqual(['CASH', 'CASH-2']);
  });

  it('keeps a synthesized code at or under the 32-character column width', () => {
    const longName = 'A'.repeat(50);
    const csv = `Name,Type\n${longName},Bank\n`;
    const { accounts } = parseAccountsCsv(csv);

    expect(accounts[0]?.code.length).toBeLessThanOrEqual(32);
  });

  it('reports a missing Name as a row issue, excluding it from accounts', () => {
    const csv = 'Name,Type\n,Bank\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(accounts).toEqual([]);
    expect(issues).toEqual([{ file: 'accounts', row: 1, message: expect.any(String) }]);
  });

  it('reports an unmapped Type as a row issue, excluding it from accounts', () => {
    const csv = 'Name,Type\nMystery account,Not A Type\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(accounts).toEqual([]);
    expect(issues).toEqual([{ file: 'accounts', row: 1, message: expect.any(String) }]);
  });

  it('reports issues at the 1-based row, excluding the header, alongside good rows', () => {
    const csv = 'Name,Type\nGood one,Bank\n,Bank\nGood two,Expense\n';
    const { accounts, issues } = parseAccountsCsv(csv);

    expect(accounts.map((a) => a.name)).toEqual(['Good one', 'Good two']);
    expect(issues).toEqual([{ file: 'accounts', row: 2, message: expect.any(String) }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseAccountsCsv('')).toEqual({ accounts: [], issues: [] });
  });
});

describe('parseContactsCsv', () => {
  it('parses a customers-only file with isCustomer set and isVendor clear', () => {
    const { contacts, issues } = parseContactsCsv(
      'Name,Number,Email\nAcme Co,C001,ap@acme.test\n',
      null,
    );

    expect(issues).toEqual([]);
    expect(contacts).toEqual([
      {
        displayName: 'Acme Co',
        code: 'C001',
        email: 'ap@acme.test',
        isCustomer: true,
        isVendor: false,
      },
    ]);
  });

  it('parses a vendors-only file with isVendor set and isCustomer clear', () => {
    const { contacts, issues } = parseContactsCsv(null, 'Name,Code\nSupplies Inc,V009\n');

    expect(issues).toEqual([]);
    expect(contacts).toEqual([
      { displayName: 'Supplies Inc', code: 'V009', email: null, isCustomer: false, isVendor: true },
    ]);
  });

  it('merges a name present in both lists onto one contact carrying both flags', () => {
    const { contacts, issues } = parseContactsCsv(
      'Name,Email\nAcme Co,billing@acme.test\n',
      'Name\nACME CO\n',
    );

    expect(issues).toEqual([]);
    expect(contacts).toEqual([
      {
        displayName: 'Acme Co',
        code: null,
        email: 'billing@acme.test',
        isCustomer: true,
        isVendor: true,
      },
    ]);
  });

  it('reports a missing Name as an issue against the correct file', () => {
    // A row that carries a cell but no Name — a genuinely blank line is skipped by the
    // tokenizer (a trailing newline is not a row), so this mirrors the accounts case
    // (`'Name,Type\n,Bank\n'`): content present, Name absent.
    const { contacts, issues } = parseContactsCsv('Name,Email\n,bob@acme.test\n', null);

    expect(contacts).toEqual([]);
    expect(issues).toEqual([{ file: 'customers', row: 1, message: expect.any(String) }]);
  });

  it('treats both files absent as no contacts and no issues', () => {
    expect(parseContactsCsv(null, null)).toEqual({ contacts: [], issues: [] });
  });
});

describe('parseTrialBalanceCsv', () => {
  it('reads a debit-only row as side debit', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n1010,150.00,\n');

    expect(issues).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountRef).toBe('1010');
    expect(rows[0]?.side).toBe('debit');
    expect(toDecimalString(rows[0]!.amount)).toBe('150.00');
  });

  it('reads a credit-only row as side credit', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n4000,,99.95\n');

    expect(issues).toEqual([]);
    expect(rows[0]?.side).toBe('credit');
    expect(toDecimalString(rows[0]!.amount)).toBe('99.95');
  });

  it('reports both Debit and Credit filled in as an issue', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n1010,10.00,10.00\n');

    expect(rows).toEqual([]);
    expect(issues).toEqual([{ file: 'trialBalance', row: 1, message: expect.any(String) }]);
  });

  it('reports neither Debit nor Credit filled in as an issue', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n1010,,\n');

    expect(rows).toEqual([]);
    expect(issues).toEqual([{ file: 'trialBalance', row: 1, message: expect.any(String) }]);
  });

  it('reports an unparseable amount as an issue rather than throwing', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n1010,not-a-number,\n');

    expect(rows).toEqual([]);
    expect(issues).toEqual([{ file: 'trialBalance', row: 1, message: expect.any(String) }]);
  });

  it('reports a missing Account as an issue', () => {
    const { rows, issues } = parseTrialBalanceCsv('Account,Debit,Credit\n,10.00,\n');

    expect(rows).toEqual([]);
    expect(issues).toEqual([{ file: 'trialBalance', row: 1, message: expect.any(String) }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseTrialBalanceCsv('')).toEqual({ rows: [], issues: [] });
  });
});
