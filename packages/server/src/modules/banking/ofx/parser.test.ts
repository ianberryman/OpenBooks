import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../errors';

import { parseOfx } from './parser';

/**
 * The OFX/QFX parser (OB-077; ROADMAP D-41, D-42, E1).
 *
 * No database and no context — the parser is pure bytes-to-facts. The properties that
 * matter are arithmetic and textual: an exact signed `bigint` for every amount, an
 * exact ISO date, and the SGML-vs-XML tolerance that lets one tokeniser read both
 * dialects. Amounts are asserted as exact `bigint`s because the whole point of the
 * money path is that `-4.55` is `-455n` and never `454.999…`.
 */

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A real OFX 1.x document: SGML header block, unclosed leaf tags, aggregate closes. */
const OFX_1X = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20240201120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>0123456789
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240101
<DTEND>20240131
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115
<TRNAMT>-4.50
<FITID>202401150001
<NAME>COFFEE SHOP
<MEMO>Card purchase &amp; tip
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240116
<DTAVAIL>20240117
<TRNAMT>1234.00
<FITID>202401160002
<NAME>ACME PAYROLL
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>1229.50
<DTASOF>20240131
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

/** A real OFX 2.x document: XML declaration, `<?OFX?>` PI, every tag closed. */
const OFX_2X = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>1</TRNUID>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <BANKID>021000021</BANKID>
          <ACCTID>0123456789</ACCTID>
          <ACCTTYPE>CHECKING</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20240101000000</DTSTART>
          <DTEND>20240131000000</DTEND>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20240115120000.000[-5:EST]</DTPOSTED>
            <TRNAMT>-4.50</TRNAMT>
            <FITID>202401150001</FITID>
            <NAME>COFFEE SHOP</NAME>
            <MEMO>Card purchase</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>-15.75</BALAMT>
          <DTASOF>20240131000000</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

describe('OFX 1.x SGML', () => {
  it('reads unclosed leaf tags and the header block', () => {
    const statement = parseOfx(encode(OFX_1X));

    expect(statement.rows).toHaveLength(2);
    expect(statement.externalAccountId).toBe('0123456789');
    expect(statement.closingBalance).toBe(122950n);

    const [debit, credit] = statement.rows;
    expect(debit).toEqual({
      postedDate: '2024-01-15',
      valueDate: null,
      amount: -450n,
      description: 'Card purchase & tip',
      counterparty: 'COFFEE SHOP',
      bankReference: '202401150001',
    });
    expect(credit).toEqual({
      postedDate: '2024-01-16',
      valueDate: '2024-01-17',
      amount: 123400n,
      // No MEMO on this row, so the narrative falls back to NAME (D-42).
      description: 'ACME PAYROLL',
      counterparty: 'ACME PAYROLL',
      bankReference: '202401160002',
    });
  });
});

describe('OFX 2.x XML', () => {
  it('reads a closed-tag document with a processing instruction and a negative balance', () => {
    const statement = parseOfx(encode(OFX_2X));

    expect(statement.rows).toHaveLength(1);
    expect(statement.externalAccountId).toBe('0123456789');
    expect(statement.closingBalance).toBe(-1575n);
    expect(statement.rows[0]).toEqual({
      // The time and timezone after the 8th digit are dropped: a posted date is a date.
      postedDate: '2024-01-15',
      valueDate: null,
      amount: -450n,
      description: 'Card purchase',
      counterparty: 'COFFEE SHOP',
      bankReference: '202401150001',
    });
  });
});

describe('QFX', () => {
  it('ignores Intuit proprietary INTU.* tags', () => {
    const qfx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20240201
<LANGUAGE>ENG
<INTU.BID>2430
<INTU.USERID>someone
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>9988776655
<ACCTTYPE>SAVINGS
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240110
<TRNAMT>-20.00
<FITID>Q-0001
<NAME>GROCERY
<MEMO>Weekly shop
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const statement = parseOfx(encode(qfx));

    expect(statement.externalAccountId).toBe('9988776655');
    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]?.amount).toBe(-2000n);
    expect(statement.rows[0]?.bankReference).toBe('Q-0001');
    expect(statement.closingBalance).toBeNull();
  });
});

describe('credit-card statement', () => {
  it('reads the account id from CCACCTFROM', () => {
    const card = `<?xml version="1.0"?>
<?OFX OFXHEADER="200" VERSION="211"?>
<OFX>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<CURDEF>USD</CURDEF>
<CCACCTFROM>
<ACCTID>4111111111111111</ACCTID>
</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20240220</DTPOSTED>
<TRNAMT>-99.99</TRNAMT>
<FITID>CC-77</FITID>
<NAME>ONLINE STORE</NAME>
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-543.21</BALAMT>
<DTASOF>20240229</DTASOF>
</LEDGERBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;

    const statement = parseOfx(encode(card));

    expect(statement.externalAccountId).toBe('4111111111111111');
    expect(statement.closingBalance).toBe(-54321n);
    expect(statement.rows[0]?.amount).toBe(-9999n);
  });
});

describe('amount signs and shapes', () => {
  const withAmount = (trnamt: string): Uint8Array =>
    encode(`<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><DTPOSTED>20240301</DTPOSTED><TRNAMT>${trnamt}</TRNAMT><FITID>F1</FITID></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);

  it.each([
    ['-4.50', -450n],
    ['4.50', 450n],
    ['1234.00', 123400n],
    ['1234', 123400n],
    ['0.00', 0n],
    ['-0.05', -5n],
    ['1234.5', 123450n],
  ])('parses %s as %s minor units', (trnamt, expected) => {
    const statement = parseOfx(withAmount(trnamt));
    expect(statement.rows[0]?.amount).toBe(expected);
  });

  it('rejects an amount with more than two decimal places rather than rounding it', () => {
    expect(() => parseOfx(withAmount('-4.555'))).toThrow(ValidationError);
    expect(() => parseOfx(withAmount('10.001'))).toThrow(ValidationError);
  });
});

describe('two identical transactions', () => {
  it('keeps both STMTTRN with distinct FITIDs — dedupe is OB-078, not the parser', () => {
    // Same shop, same day, same amount; only FITID differs. The parser must not collapse
    // them — deciding a duplicate needs the account's stored history and the other rows in
    // the file, neither of which a parser can see (parser.ts, D-42). OB-078 dedupes.
    const twoCoffees = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><DTPOSTED>20240401</DTPOSTED><TRNAMT>-4.50</TRNAMT><FITID>A1</FITID><NAME>COFFEE</NAME></STMTTRN>
<STMTTRN><DTPOSTED>20240401</DTPOSTED><TRNAMT>-4.50</TRNAMT><FITID>A2</FITID><NAME>COFFEE</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const statement = parseOfx(encode(twoCoffees));

    expect(statement.rows).toHaveLength(2);
    expect(statement.rows.map((row) => row.bankReference)).toEqual(['A1', 'A2']);
    expect(statement.rows[0]?.amount).toBe(-450n);
    expect(statement.rows[1]?.amount).toBe(-450n);
  });
});

describe('missing required tags', () => {
  const base = (body: string): Uint8Array =>
    encode(`<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>${body}</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);

  it('rejects a transaction with no DTPOSTED', () => {
    expect(() => parseOfx(base('<TRNAMT>-1.00</TRNAMT><FITID>F1</FITID>'))).toThrow(/DTPOSTED/);
  });

  it('rejects a transaction with no TRNAMT', () => {
    expect(() => parseOfx(base('<DTPOSTED>20240301</DTPOSTED><FITID>F1</FITID>'))).toThrow(
      /TRNAMT/,
    );
  });

  it('rejects a transaction with no FITID', () => {
    expect(() => parseOfx(base('<DTPOSTED>20240301</DTPOSTED><TRNAMT>-1.00</TRNAMT>'))).toThrow(
      /FITID/,
    );
  });

  it('names the offending transaction by position and FITID', () => {
    const twoRows = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><DTPOSTED>20240301</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>OK</FITID></STMTTRN>
<STMTTRN><TRNAMT>-2.00</TRNAMT><FITID>BAD</FITID></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(() => parseOfx(encode(twoRows))).toThrow(/Transaction 2 \(FITID BAD\).*DTPOSTED/);
  });

  it('rejects a non-numeric OFX date', () => {
    expect(() =>
      parseOfx(base('<DTPOSTED>2024-03-01</DTPOSTED><TRNAMT>-1.00</TRNAMT><FITID>F1</FITID>')),
    ).toThrow(ValidationError);
  });
});

describe('not an OFX file', () => {
  it('rejects an empty file', () => {
    expect(() => parseOfx(encode(''))).toThrow(/empty/i);
    expect(() => parseOfx(encode('   \n  '))).toThrow(ValidationError);
  });

  it('rejects a file with no <OFX> root', () => {
    expect(() => parseOfx(encode('Date,Amount\n2024-01-01,10.00'))).toThrow(/not OFX/i);
    expect(() => parseOfx(encode('<html><body>hello</body></html>'))).toThrow(ValidationError);
  });
});

describe('a statement with no transactions', () => {
  it('is a valid empty statement, not an error', () => {
    const empty = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><ACCTID>555</ACCTID></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240131</DTEND></BANKTRANLIST>
<LEDGERBAL><BALAMT>0.00</BALAMT></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const statement = parseOfx(encode(empty));

    expect(statement.rows).toEqual([]);
    expect(statement.externalAccountId).toBe('555');
    expect(statement.closingBalance).toBe(0n);
  });
});
