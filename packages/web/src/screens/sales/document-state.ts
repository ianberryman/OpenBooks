import type {
  DocumentLineRequest,
  SalesDocument,
  SalesDocumentKind,
  TaxMode,
  UpdateDocumentBody,
} from './queries';
import { dueDateOf } from './queries';

/**
 * The editor's own model of a draft document, and the conversion back to the request
 * that stores it.
 *
 * ## What this file deliberately does not hold
 *
 * **No money.** There is no `netAmount`, no `taxAmount` and no `grossAmount` here, and
 * nothing in this package computes one. Tax is rounded per line, twice — once on the
 * extension and once on the tax — and the document's totals are the sums of those rounded
 * lines rather than the rate applied to a sum (D-35). A second implementation in the
 * browser would be a fourth rounding rule and the first one to disagree would disagree on
 * a printed invoice, so the editor sends `quantity × unitAmount × rate` as *inputs* and
 * reads every figure back off the response.
 *
 * The visible consequence is that a line's amounts are stale between an edit and a save,
 * and the editor says so rather than guessing (see `document-editor.tsx`).
 *
 * **No `status`.** It is computed from the journals and the allocations on every read
 * (D-38); there is no column and the request schemas carry no field.
 */

/**
 * One line as the form holds it.
 *
 * `key` is the React identity, which cannot be the server's `lineId`: a row the user has
 * just added has none, and without a stable key the row remounts on every keystroke and
 * takes the caret with it. Server-issued where the line came back from a save, locally
 * minted otherwise — `journal-entry/draft-state.ts`' reason.
 */
export interface EditorLine {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — `Quantity` on the wire. */
  readonly quantity: string;
  /**
   * Minor units (D-13), or `null` for an empty field. **Tax-inclusive exactly when the
   * document's `taxMode` is `inclusive`** — that flag is what gives this field its
   * meaning, which is why changing it reprices rather than converts.
   */
  readonly unitAmount: string | null;
  readonly accountId: string | null;
  readonly taxRateId: string | null;
  readonly dimensionValueIds: readonly string[];
  /**
   * The catalog item this line was seeded from, or `null` for a hand-typed line. Provenance
   * only (D-CAT-2): it seeds the description, price, account and tax and then travels
   * unedited — nothing here reads it back to re-apply a default.
   */
  readonly catalogItemId: string | null;
  /** What the server last made of this line, or `null` for a row it has never seen. */
  readonly priced: LinePricing | null;
}

export interface LinePricing {
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
  readonly taxRatePercentage: string | null;
}

export interface EditorState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** Invoices only. `''` on a credit note, where the field is not rendered at all. */
  readonly dueDate: string;
  readonly taxMode: TaxMode;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly EditorLine[];
}

let nextLocalKey = 0;

export function blankLine(): EditorLine {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One, because a line is usually one of something and a blank quantity field is a
    // required value the user has to supply to get past a row they did not mean to enter.
    quantity: '1',
    unitAmount: null,
    accountId: null,
    taxRateId: null,
    dimensionValueIds: [],
    catalogItemId: null,
    priced: null,
  };
}

export function stateFromDocument(document: SalesDocument): EditorState {
  const lines = document.lines.map((line): EditorLine => ({
    key: line.lineId,
    description: line.description,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    accountId: line.accountId,
    taxRateId: line.taxRateId,
    dimensionValueIds: line.dimensionValueIds,
    catalogItemId: line.catalogItemId,
    priced: {
      netAmount: line.netAmount,
      taxAmount: line.taxAmount,
      grossAmount: line.grossAmount,
      taxRatePercentage: line.taxRatePercentage,
    },
  }));

  if (lines.length === 0) lines.push(blankLine());

  return {
    contactId: document.contactId,
    issueDate: document.issueDate,
    dueDate: dueDateOf(document) ?? '',
    taxMode: document.taxMode,
    reference: document.reference ?? '',
    memo: document.memo ?? '',
    lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A line the server can price, or `null` for a row that is still empty.
 *
 * Incomplete rows are dropped rather than sent. `documentLineInputSchema` requires a
 * description, a quantity, a unit amount and an account, so a half-typed row would be a
 * `validation_failed` on every autosave — and unlike a journal draft, where every field is
 * nullable *deliberately* (D-19), a document line has no partial form on the wire. The row
 * stays on screen; it simply is not part of the document yet.
 */
function toRequestLine(line: EditorLine): DocumentLineRequest | null {
  const description = blankToNull(line.description);
  const quantity = blankToNull(line.quantity);
  if (description === null || quantity === null) return null;
  if (line.unitAmount === null || line.accountId === null) return null;

  return {
    description,
    quantity,
    unitAmount: line.unitAmount,
    accountId: line.accountId,
    // Absent means *no tax*, not a default rate — there is no default, because a rate
    // nobody chose is a rate that ends up on a filing (D-35).
    taxRateId: line.taxRateId,
    dimensionValueIds: [...line.dimensionValueIds],
    // Provenance only (D-CAT-2): recorded so the line remembers the item it was seeded from,
    // never re-read to reprice.
    catalogItemId: line.catalogItemId,
  };
}

export function completeLines(state: EditorState): readonly DocumentLineRequest[] {
  return state.lines
    .map(toRequestLine)
    .filter((line): line is DocumentLineRequest => line !== null);
}

/** How many rows on screen are not yet part of the document. */
export function incompleteLineCount(state: EditorState): number {
  return state.lines.filter((line) => toRequestLine(line) === null).length;
}

/**
 * The whole document, every time — `lines` replaces the entire set.
 *
 * The route's contract rather than a simplification: per-line patching would need line
 * identities that survive an edit inserting a row in the middle, and the client is a form
 * that already holds every line (`updateInvoiceRequestSchema`).
 *
 * `contactId` is omitted while it is unset, because the field is not nullable on the wire
 * — a document with no customer is not an unfinished invoice, and the server refuses to
 * create one at all.
 */
export function patchFromState(state: EditorState, kind: SalesDocumentKind): UpdateDocumentBody {
  return {
    ...(state.contactId === null ? {} : { contactId: state.contactId }),
    ...(state.issueDate === '' ? {} : { issueDate: state.issueDate }),
    ...(kind === 'invoice' && state.dueDate !== '' ? { dueDate: state.dueDate } : {}),
    taxMode: state.taxMode,
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    lines: completeLines(state),
  };
}

/**
 * Today, from the local calendar rather than from UTC.
 *
 * `toISOString().slice(0, 10)` is the obvious version and it is wrong for a third of every
 * day west of Greenwich: an invoice raised at 7pm in New York would be dated tomorrow and
 * would then be approved into next month's period, or refused because that period is not
 * open yet.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
