import type { ApDocument, DocumentInput } from './ap-document';
import type { DocumentLineRequest, TaxMode } from './queries';

/**
 * The editor's own model of an AP document, and the conversion to the request that
 * stores it.
 *
 * Separate from the wire shape for `journal-entry/draft-state.ts`'s reason: a row the
 * user has added but not yet saved has no `lineId`, and React needs a stable key for it
 * or the row remounts on every keystroke and takes the caret with it.
 *
 * What is **not** here is any arithmetic. A line's net, tax and gross are computed by the
 * server, per line and rounded per line (D-35), and returned on the document; this module
 * carries what was typed and nothing derived from it. A browser-side copy of that
 * rounding would be a second implementation of it, and the first thing it would disagree
 * about is a printed total.
 */
export interface EditorLine {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — the wire form (`Quantity`). */
  readonly quantity: string;
  readonly accountId: string | null;
  /** `null` means **no tax**, which D-35 distinguishes from a zero-rated rate. */
  readonly taxRateId: string | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly unitAmount: string | null;
  /**
   * The catalog item this line was seeded from, or `null` for a hand-typed line. Provenance
   * only (D-CAT-2) — carried through unedited, never re-read to reprice.
   */
  readonly catalogItemId: string | null;
}

export interface EditorState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** `''` on a vendor credit, which has no due date at all. */
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
    // One is the quantity of almost every bill line an AP clerk types, and it is a
    // pre-fill rather than a rule: the field is editable and negative is legitimate.
    quantity: '1',
    accountId: null,
    taxRateId: null,
    unitAmount: null,
    catalogItemId: null,
  };
}

/**
 * Today, from the local calendar rather than from UTC.
 *
 * `toISOString().slice(0, 10)` is the obvious version and it is wrong for a third of every
 * day west of Greenwich: a document entered at 7pm in New York would be dated tomorrow and
 * land in next month's period. Spelled here rather than imported from the journal-entry
 * screen's private state module, for the reason the query keys are local — one screen
 * reaching into another's internals is a coupling neither ticket agreed to.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function emptyState(today: string = todayIsoDate()): EditorState {
  return {
    contactId: null,
    issueDate: today,
    dueDate: today,
    taxMode: 'exclusive',
    reference: '',
    memo: '',
    lines: [blankLine()],
  };
}

export function stateFromDocument(document: ApDocument): EditorState {
  const lines = document.lines.map((line): EditorLine => ({
    key: line.lineId,
    description: line.description,
    quantity: line.quantity,
    accountId: line.accountId,
    taxRateId: line.taxRateId,
    unitAmount: line.unitAmount,
    catalogItemId: line.catalogItemId,
  }));

  return {
    contactId: document.contactId,
    issueDate: document.issueDate,
    dueDate: document.dueDate ?? '',
    taxMode: document.taxMode,
    reference: document.reference ?? '',
    memo: document.memo ?? '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A row nobody has touched. Dropped on save rather than complained about — an unused row
 * at the bottom of a table is not an error, it is an unused row. */
export function isUntouched(line: EditorLine): boolean {
  return (
    line.description.trim() === '' &&
    line.accountId === null &&
    line.unitAmount === null &&
    line.taxRateId === null
  );
}

export type LineProblem = 'description' | 'account' | 'unitAmount' | 'quantity';

/**
 * What a half-entered line is missing, or `null` when it is sendable.
 *
 * This is the one place the editor refuses something the server would also refuse, and it
 * exists because the **request type cannot express the half-entered line**:
 * `DocumentLineRequest` requires `description`, `accountId`, `quantity` and `unitAmount`,
 * so there is no body to send that would earn the server's per-field verdict. A journal
 * draft is the opposite case — every field on one is nullable by design (D-19) — which is
 * why that editor refuses nothing and this one names four fields.
 *
 * Nothing beyond those four is checked here. Whether the account is an expense account,
 * whether the vendor is a vendor, whether the period is open: all of that is the service's
 * and arrives as a `validation_failed` or a `precondition_failed` with its own message.
 */
export function lineProblem(line: EditorLine): LineProblem | null {
  if (line.description.trim() === '') return 'description';
  if (line.accountId === null) return 'account';
  if (line.unitAmount === null) return 'unitAmount';
  if (line.quantity.trim() === '') return 'quantity';
  return null;
}

export interface StateProblems {
  readonly vendor: boolean;
  readonly issueDate: boolean;
  readonly noLines: boolean;
  /** Keyed by `EditorLine.key`. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

export function problemsIn(state: EditorState): StateProblems {
  const lines = new Map<string, LineProblem>();
  let sendable = 0;

  for (const line of state.lines) {
    if (isUntouched(line)) continue;
    const problem = lineProblem(line);
    if (problem === null) sendable += 1;
    else lines.set(line.key, problem);
  }

  return {
    vendor: state.contactId === null,
    issueDate: state.issueDate.trim() === '',
    noLines: sendable === 0 && lines.size === 0,
    lines,
  };
}

export function hasProblems(problems: StateProblems): boolean {
  return problems.vendor || problems.issueDate || problems.noLines || problems.lines.size > 0;
}

function toRequestLine(line: EditorLine): DocumentLineRequest {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    // Non-null by construction: `problemsIn` is checked before a save is attempted, and
    // the `??` values below are unreachable rather than defaults. They are written as
    // empty strings so that a bug here fails the server's validator loudly instead of
    // being papered over with a plausible-looking account.
    accountId: line.accountId ?? '',
    unitAmount: line.unitAmount ?? '',
    taxRateId: line.taxRateId,
    // Provenance only (D-CAT-2): recorded so the line remembers the item it was seeded from.
    catalogItemId: line.catalogItemId,
  };
}

/**
 * The whole document, every time — `lines` replaces the entire set, which is both routes'
 * contract (`updateBill`, `updateVendorCredit`).
 *
 * `withDueDate` is false for a vendor credit, whose request shape has no such field:
 * nothing about one falls due, and aging never ages one.
 */
export function inputFromState(state: EditorState, withDueDate: boolean): DocumentInput {
  return {
    contactId: state.contactId ?? '',
    issueDate: state.issueDate,
    dueDate: withDueDate ? blankToNull(state.dueDate) : null,
    taxMode: state.taxMode,
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}

/**
 * A stable string for one save's content, so the idempotency key changes exactly when the
 * request does (`useIntentKey`'s argument, applied to a document rather than a form).
 */
export function fingerprintOf(input: DocumentInput): string {
  return JSON.stringify(input);
}
