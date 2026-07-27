import { createHash } from 'node:crypto';

import type { ParsedStatementRow } from '../parser';

/**
 * The dedupe fingerprint and the occurrence index (OB-078; ROADMAP D-42, E1).
 *
 * This file is the single source of truth for how a bank line is identified for
 * dedupe. It is pure and takes no database — the persist decision that consumes it
 * lives in `repository.ts`, and the reason to keep the identity function separate is
 * that E1 is a property over *inputs*, and a property is only checkable against a
 * function you can call without a database (`fingerprint.test.ts`).
 *
 * ## Two things, stored separately, and why
 *
 * `0006_banking`'s uniqueness key is `(org_id, bank_account_id, fingerprint,
 * occurrence_index)`, and the two are deliberately not one value:
 *
 *  - **`fingerprint`** is a SHA-256 hex over the fields the bank actually supplied —
 *    the posted date, the signed amount, the description, and the bank's own
 *    reference where there is one. It is a pure function of the bank's data and of
 *    nothing else, which is what makes "how many of these have I already got" a
 *    `COUNT` on an index rather than a probe.
 *  - **`occurrence_index`** is the rank of a line *among file rows sharing its
 *    fingerprint*, and it is stored beside the fingerprint rather than folded into
 *    it. It exists because two genuinely distinct transactions can be identical in
 *    every supplied field — two £4.50 coffees at the same shop on the same day, from
 *    a bank with no transaction id — and both must survive while a re-import of the
 *    same file still collapses to two (D-42).
 *
 * ## The index counts occurrences, not file position — this is the whole of E1
 *
 * E1 says re-import produces no duplicates "whatever the file's ordering". The row
 * number would make the fingerprint depend on ordering, which is exactly what E1
 * forbids; the *count* of earlier identical rows does not, because rows with equal
 * fingerprints are indistinguishable and which one is called the first is arbitrary.
 *
 * So `fingerprintRows` groups the file by fingerprint and, within each group, sorts
 * by the fields that are *not* in the fingerprint (`valueDate`, `counterparty`)
 * before numbering. That sort is what makes the stored set invariant under a shuffle
 * of the file: for two coffees that are identical in every field the assignment is
 * arbitrary but the stored rows are byte-identical either way, and for two rows that
 * merely share a fingerprint but differ in counterparty the sort pins which one is
 * occurrence 0 regardless of the order they arrived in. The persist step then treats
 * a row as new iff its occurrence index is at least the count already stored, which
 * is the `insert max(0, k − n) rows at indexes n … k−1` algorithm `0006_banking`'s
 * header states.
 */

/** The bank-supplied fields the fingerprint is computed over (D-42). */
export interface FingerprintInput {
  readonly postedDate: string;
  readonly amount: bigint;
  readonly description: string;
  readonly bankReference: string | null;
}

/**
 * A stable, injective hash of what the bank supplied.
 *
 * The pre-image is a JSON array, not a delimiter-joined string, and the difference
 * is load-bearing: JSON element boundaries are unambiguous — strings are quoted and
 * escaped, `null` is the literal and not the three characters `n u l l`, and the
 * amount is the decimal string of the bigint — so no two distinct tuples produce the
 * same pre-image and collide before SHA-256 is even reached. A joined string would
 * not have that property, because a description ending in the separator could
 * impersonate the field after it.
 *
 * `CHAR(64)` in the schema, so hex and not base64.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.postedDate,
    input.amount.toString(),
    input.description,
    input.bankReference,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** A parsed row with its identity resolved: the fingerprint and its occurrence. */
export interface FingerprintedRow {
  readonly row: ParsedStatementRow;
  /** Where the row sat in the file, so a preview can show rows in file order. */
  readonly fileIndex: number;
  readonly fingerprint: string;
  readonly occurrenceIndex: number;
}

/**
 * Assigns every file row its fingerprint and occurrence index, order-independently.
 *
 * The output is the same multiset of `(fingerprint, occurrenceIndex, row)` whatever
 * order the input arrived in — which is the property E1 rests on. `fileIndex` is
 * carried through so a caller that wants the rows back in file order (the preview
 * sample) can re-sort without losing the occurrence numbering, which is a fact about
 * the fingerprint group and not about file position.
 */
export function fingerprintRows(rows: readonly ParsedStatementRow[]): FingerprintedRow[] {
  interface Member {
    readonly row: ParsedStatementRow;
    readonly fileIndex: number;
    readonly sortKey: string;
  }
  const groups = new Map<string, Member[]>();

  rows.forEach((row, fileIndex) => {
    const fingerprint = computeFingerprint(row);
    const member: Member = { row, fileIndex, sortKey: supplementaryKey(row) };
    const group = groups.get(fingerprint);
    if (group === undefined) {
      groups.set(fingerprint, [member]);
    } else {
      group.push(member);
    }
  });

  const result: FingerprintedRow[] = [];
  for (const [fingerprint, members] of groups) {
    // Sorted by the fields not in the fingerprint, so the occurrence numbering does
    // not depend on the order the rows arrived in. Members that are fully identical
    // compare equal and are interchangeable — the stored row is the same whichever is
    // called occurrence 0 — so a total order among them is unnecessary for E1.
    const ordered = [...members].sort((a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
    );
    ordered.forEach((member, occurrenceIndex) => {
      result.push({ row: member.row, fileIndex: member.fileIndex, fingerprint, occurrenceIndex });
    });
  }

  return result;
}

/** The supplied fields a fingerprint does *not* cover, canonically serialized. */
function supplementaryKey(row: ParsedStatementRow): string {
  return JSON.stringify([row.valueDate, row.counterparty]);
}
