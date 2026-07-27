import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../errors';

import type { CsvOptions } from './options';
import { parseCsvStatement } from './parse';

/**
 * The CSV parser, in isolation (OB-076; ROADMAP D-41/D-42, acceptance E1).
 *
 * Pure and DB-free by design — the parser touches no database (`../parser.ts`), so
 * this suite is the fast one and every case here is a claim about bytes-and-mapping
 * in, bank facts out. The two that carry the milestone:
 *
 *  - the same digits are a different month under `dmy` and `mdy`, and the order is
 *    the mapping's to state, never the parser's to guess (D-42)
 *  - the sign comes out right under every convention, including the credit-column
 *    trap where a credit is money *in* (E4)
 */

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

type ColumnOverrides = Partial<CsvOptions['columns']>;

/** A signed, single-amount, headerless mapping — `date, amount, description`. */
function definition(
  overrides: Partial<Omit<CsvOptions, 'columns'>> & { columns?: ColumnOverrides } = {},
): CsvOptions {
  const { columns, ...rest } = overrides;
  return {
    hasHeaderRow: false,
    delimiter: ',',
    dateOrder: 'ymd',
    amountConvention: 'signed',
    ...rest,
    columns: {
      postedDate: 0,
      description: 2,
      amount: 1,
      debit: null,
      credit: null,
      valueDate: null,
      counterparty: null,
      bankReference: null,
      ...columns,
    },
  };
}

describe('date order — stated, never guessed', () => {
  it('reads ymd', () => {
    const { rows } = parseCsvStatement(bytes('2026/01/02,10.00,Coffee'), definition());
    expect(rows[0]?.postedDate).toBe('2026-01-02');
  });

  it('reads the ambiguous 01/02/2026 as 1 February under dmy', () => {
    const { rows } = parseCsvStatement(
      bytes('01/02/2026,10.00,Coffee'),
      definition({ dateOrder: 'dmy' }),
    );
    expect(rows[0]?.postedDate).toBe('2026-02-01');
  });

  it('reads the same 01/02/2026 as 2 January under mdy', () => {
    const { rows } = parseCsvStatement(
      bytes('01/02/2026,10.00,Coffee'),
      definition({ dateOrder: 'mdy' }),
    );
    expect(rows[0]?.postedDate).toBe('2026-01-02');
  });

  it('accepts a dash separator', () => {
    const { rows } = parseCsvStatement(bytes('2026-03-09,10.00,Coffee'), definition());
    expect(rows[0]?.postedDate).toBe('2026-03-09');
  });
});

describe('amount conventions and sign', () => {
  it('signed: negative stays out, a thousands separator is stripped', () => {
    const { rows } = parseCsvStatement(
      bytes('2026-01-02,-4.50,Fee\n2026-01-03,"1,234.50",Deposit'),
      definition(),
    );
    expect(rows[0]?.amount).toBe(-450n);
    expect(rows[1]?.amount).toBe(123450n);
  });

  it('signed: a parenthesised amount is negative', () => {
    const { rows } = parseCsvStatement(bytes('2026-01-02,(4.50),Fee'), definition());
    expect(rows[0]?.amount).toBe(-450n);
  });

  it('signed_reversed: a positive purchase becomes money out', () => {
    const { rows } = parseCsvStatement(
      bytes('2026-01-02,4.50,Purchase'),
      definition({ amountConvention: 'signed_reversed' }),
    );
    expect(rows[0]?.amount).toBe(-450n);
  });

  it('debit_credit_columns: the credit column is money in, the debit column is money out', () => {
    const opts = definition({
      amountConvention: 'debit_credit_columns',
      columns: { postedDate: 0, debit: 1, credit: 2, amount: null, description: 3 },
    });
    const { rows } = parseCsvStatement(
      bytes('2026-01-02,,4.50,Deposit\n2026-01-03,4.50,,Withdrawal'),
      opts,
    );
    // Credit filled → money in → positive; debit filled → money out → negative.
    expect(rows[0]?.amount).toBe(450n);
    expect(rows[1]?.amount).toBe(-450n);
  });

  it('debit_credit_columns: a bank that fills the unused column with 0.00 still reads right', () => {
    const opts = definition({
      amountConvention: 'debit_credit_columns',
      columns: { postedDate: 0, debit: 1, credit: 2, amount: null, description: 3 },
    });
    const { rows } = parseCsvStatement(bytes('2026-01-02,0.00,4.50,Deposit'), opts);
    expect(rows[0]?.amount).toBe(450n);
  });
});

describe('quoting (RFC 4180)', () => {
  it('keeps a comma and a newline inside a quoted field', () => {
    const { rows } = parseCsvStatement(
      bytes('2026-01-02,10.00,"Coffee, large\nwith milk"'),
      definition(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Coffee, large\nwith milk');
    expect(rows[0]?.amount).toBe(1000n);
  });

  it('reads a doubled quote as one literal quote', () => {
    const { rows } = parseCsvStatement(bytes('2026-01-02,10.00,"She said ""hi"""'), definition());
    expect(rows[0]?.description).toBe('She said "hi"');
  });
});

describe('header row', () => {
  it('drops the first record when hasHeaderRow is set', () => {
    const csv = 'Date,Amount,Narrative\n2026-01-02,10.00,Coffee';
    const { rows } = parseCsvStatement(bytes(csv), definition({ hasHeaderRow: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.postedDate).toBe('2026-01-02');
  });

  it('keeps the first record when it is not set', () => {
    const csv = '2026-01-01,5.00,Opening\n2026-01-02,10.00,Coffee';
    const { rows } = parseCsvStatement(bytes(csv), definition());
    expect(rows).toHaveLength(2);
  });
});

describe('optional columns', () => {
  it('maps value date, counterparty and bank reference; empty cells are null', () => {
    const opts = definition({
      columns: {
        postedDate: 0,
        amount: 1,
        description: 2,
        valueDate: 3,
        counterparty: 4,
        bankReference: 5,
      },
    });
    const { rows } = parseCsvStatement(
      bytes('2026-01-02,10.00,Coffee,2026-01-03,Blue Bottle,FIT-9\n2026-01-04,5.00,Tea,,,'),
      opts,
    );
    expect(rows[0]).toMatchObject({
      valueDate: '2026-01-03',
      counterparty: 'Blue Bottle',
      bankReference: 'FIT-9',
    });
    expect(rows[1]).toMatchObject({ valueDate: null, counterparty: null, bankReference: null });
  });
});

describe('no partial parse — a bad row is a refusal naming it', () => {
  it('rejects a date that is not valid under the stated order', () => {
    expect(() =>
      parseCsvStatement(bytes('31/02/2026,10.00,Fee'), definition({ dateOrder: 'dmy' })),
    ).toThrow(ValidationError);
  });

  it('rejects an amount that is not a number', () => {
    expect(() => parseCsvStatement(bytes('2026-01-02,abc,Fee'), definition())).toThrow(
      ValidationError,
    );
  });

  it('rejects a row too short for its mapping', () => {
    expect(() => parseCsvStatement(bytes('2026-01-02,10.00'), definition())).toThrow(
      ValidationError,
    );
  });
});

describe('what the parser does not do', () => {
  it('returns two rows for two byte-identical transactions (dedupe is OB-078)', () => {
    const line = '2026-01-02,4.50,Coffee';
    const { rows } = parseCsvStatement(bytes(`${line}\n${line}`), definition());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(rows[1]);
  });

  it('states no closing balance and no external account id (a bare CSV has neither)', () => {
    const statement = parseCsvStatement(bytes('2026-01-02,10.00,Coffee'), definition());
    expect(statement.closingBalance).toBeNull();
    expect(statement.externalAccountId).toBeNull();
  });

  it('ignores a trailing newline rather than reading a phantom row', () => {
    const { rows } = parseCsvStatement(bytes('2026-01-02,10.00,Coffee\n'), definition());
    expect(rows).toHaveLength(1);
  });

  it('strips a UTF-8 BOM so the first date still parses', () => {
    const { rows } = parseCsvStatement(bytes('﻿2026-01-02,10.00,Coffee'), definition());
    expect(rows[0]?.postedDate).toBe('2026-01-02');
  });
});
