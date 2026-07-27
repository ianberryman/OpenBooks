import { MoneyParseError, fromDecimalString, toMinorUnits } from '@openbooks/shared-types/money';

import { ValidationError } from '../../../errors';
import type { ParsedStatement, ParsedStatementRow, StatementParser } from '../parser';

import type { OfxNode } from './tokenizer';
import { childOf, childText, detectDialect, findAll, findFirst, parseOfxTree } from './tokenizer';

/**
 * The OFX/QFX parser (OB-077; ROADMAP D-41, D-42, acceptance E1, E2).
 *
 * OFX is self-describing — it names its own fields and states its own sign — so this
 * is a `StatementParser<void>`: unlike a CSV it needs no mapping to be read. It turns
 * bytes into the bank facts `parser.ts` defines and does nothing else. It does not
 * dedupe and assigns no occurrence index; two `<STMTTRN>` with different `FITID`s both
 * survive here even when every other field is identical, because collapsing them is
 * OB-078's job and it needs the account's stored history, which a parser cannot see.
 *
 * There is no partial parse (`imports.ts`): the first row this cannot read is a thrown
 * `ValidationError` naming what was wrong, before a `ParsedStatement` is returned at
 * all. A statement half-imported is what makes a business afraid to re-upload, and
 * E1's whole value is that re-uploading is safe.
 */

/**
 * QFX's proprietary tags (`INTU.BID`, `INTU.USERID`) are Quicken's, not OFX's, and
 * carry no statement fact — they are ignored by never being looked up, which is why
 * there is no list of them here. QFX is OFX with these added, so one parser reads both
 * (D-41): a second format token would be a second name for one thing.
 */

/** Amounts and dates that fail to parse point back at the transaction that carried them. */
function transactionLabel(index: number, fitid: string | null): string {
  const which = fitid === null ? `#${String(index + 1)}` : `${String(index + 1)} (FITID ${fitid})`;
  return `Transaction ${which}`;
}

/**
 * An OFX date is `YYYYMMDD` with an optional time and timezone the reconciliation
 * never uses (D-45 counts a line under its posted date, which carries no time). So the
 * leading eight digits are the whole date; anything after them is dropped. A value
 * that is not eight digits, or whose month or day is out of range, is refused here
 * rather than passed on as a plausible-looking wrong date — full calendar validity
 * (a Feb 30) is the wire schema's to reject at the service boundary.
 */
function toIsoDate(raw: string, field: string, where: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (match === null) {
    throw new ValidationError(`${where}: ${field} is not an OFX date.`, [
      {
        path: field,
        message: `Expected an 8-digit YYYYMMDD date, received ${JSON.stringify(raw)}.`,
      },
    ]);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
    throw new ValidationError(`${where}: ${field} is not a valid date.`, [
      { path: field, message: `${year}-${month}-${day} is not a calendar date.` },
    ]);
  }
  return `${year}-${month}-${day}`;
}

/**
 * OFX amounts are already signed money-in / money-out decimal strings, which is the
 * `signed` convention this system stores — so the parser's only job is the decimal to
 * minor-units conversion, and its only trap is doing it without floating point.
 *
 * `fromDecimalString` is that path: it assembles the minor units with `BigInt`, so
 * `-4.55` becomes `-455n` and never `454.999…` (a `parseFloat(...) * 100` would, and
 * `openbooks/no-float-money` fails the build for trying). It also rejects a third
 * decimal place rather than rounding one away, which is exactly the >2-decimal case
 * that must fail rather than silently mis-state a cent.
 */
function toSignedMinor(raw: string, field: string, where: string): bigint {
  try {
    return toMinorUnits(fromDecimalString(raw.trim()));
  } catch (error) {
    if (error instanceof MoneyParseError) {
      throw new ValidationError(`${where}: ${field} is not a usable amount.`, [
        { path: field, message: error.message },
      ]);
    }
    throw error;
  }
}

/** The payer/payee, whether the bank put it in a bare `<NAME>` or a `<PAYEE>` aggregate. */
function readCounterparty(trn: OfxNode): string | null {
  const name = childText(trn, 'NAME');
  if (name !== null) return name;
  const payee = childOf(trn, 'PAYEE');
  if (payee === undefined) return null;
  if (payee.value !== null && payee.value !== '') return payee.value;
  return childText(payee, 'NAME');
}

function readTransaction(trn: OfxNode, index: number): ParsedStatementRow {
  const fitid = childText(trn, 'FITID');
  const where = transactionLabel(index, fitid);

  if (fitid === null) {
    throw new ValidationError(`${where}: missing FITID.`, [
      {
        path: 'FITID',
        message: 'A transaction has no bank reference, which OFX requires on every STMTTRN.',
      },
    ]);
  }

  const posted = childText(trn, 'DTPOSTED');
  if (posted === null) {
    throw new ValidationError(`${where}: missing DTPOSTED.`, [
      { path: 'DTPOSTED', message: 'A transaction has no posted date.' },
    ]);
  }

  const trnamt = childText(trn, 'TRNAMT');
  if (trnamt === null) {
    throw new ValidationError(`${where}: missing TRNAMT.`, [
      { path: 'TRNAMT', message: 'A transaction has no amount.' },
    ]);
  }

  const available = childText(trn, 'DTAVAIL');
  const counterparty = readCounterparty(trn);
  const memo = childText(trn, 'MEMO');

  return {
    postedDate: toIsoDate(posted, 'DTPOSTED', where),
    // DTAVAIL is optional; null when the bank supplies one date, per `bankLineFactsShape`.
    valueDate: available === null ? null : toIsoDate(available, 'DTAVAIL', where),
    amount: toSignedMinor(trnamt, 'TRNAMT', where),
    // MEMO is the narrative, but a great many banks put the whole narrative in NAME and
    // omit MEMO entirely. Falling back to NAME keeps the description non-empty for those
    // rows — and description feeds the dedupe fingerprint (D-42), so an empty one would
    // make two genuinely different rows collide.
    description: memo ?? counterparty ?? '',
    counterparty,
    bankReference: fitid,
  };
}

/**
 * The account the statement is for, from `<BANKACCTFROM>` or a card's `<CCACCTFROM>`.
 * Null when absent so a bare statement can still parse; it is the field that catches a
 * current-account file uploaded into savings (D-46), compared, never required.
 */
function readExternalAccountId(root: OfxNode): string | null {
  const acct = findFirst(root, 'BANKACCTFROM') ?? findFirst(root, 'CCACCTFROM');
  return acct === undefined ? null : childText(acct, 'ACCTID');
}

/**
 * The closing balance the file claims, from `<LEDGERBAL><BALAMT>`. A claim from
 * outside the system (D-46) kept as evidence for a reconciliation to test, never read
 * as this account's balance — so null when the file states none.
 */
function readClosingBalance(root: OfxNode): bigint | null {
  const ledger = findFirst(root, 'LEDGERBAL');
  if (ledger === undefined) return null;
  const balamt = childText(ledger, 'BALAMT');
  return balamt === null ? null : toSignedMinor(balamt, 'BALAMT', 'Ledger balance');
}

const OFX_DECODER = new TextDecoder('utf-8');

export function parseOfx(raw: Uint8Array): ParsedStatement {
  const source = OFX_DECODER.decode(raw).replace(/^\uFEFF/, '');
  if (source.trim() === '') {
    throw new ValidationError('The statement file is empty.', [
      { path: 'content', message: 'An OFX import needs a file with content.' },
    ]);
  }

  // Detection is the one gate: a document with no `<OFX>` root is not OFX, whichever
  // dialect it claims. Both dialects parse through one tolerant tree beyond this point.
  const dialect = detectDialect(source);
  const root = dialect === null ? null : parseOfxTree(source);
  if (root === null) {
    throw new ValidationError('This file is not OFX.', [
      {
        path: 'content',
        message: 'No <OFX> root was found — expected an OFX 1.x (SGML) or 2.x (XML) file.',
      },
    ]);
  }

  const rows = findAll(root, 'STMTTRN').map((trn, index) => readTransaction(trn, index));

  return {
    rows,
    closingBalance: readClosingBalance(root),
    externalAccountId: readExternalAccountId(root),
  };
}

/**
 * The registry (OB-078) dispatches by format to one of these. `parse` ignores its
 * `void` options because OFX carries its own field names — the seam's whole reason for
 * making `Opts` a type parameter rather than a fixed bag.
 */
export const ofxStatementParser: StatementParser<void> = {
  parse: (raw) => parseOfx(raw),
};
