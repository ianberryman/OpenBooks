import type {
  CreateDraftFromCaptureBody,
  DocumentCapture,
  DocumentLineRequest,
  TaxMode,
} from './queries';

/**
 * The review form's own model of a draft bill, and the conversion to
 * `CreateDraftFromCaptureRequest`.
 *
 * Separate from the wire shape for `purchases/editor-state.ts`'s reason: a row seeded
 * from an extracted line, or added by hand, has no server-assigned id, and React needs a
 * stable key for it or the row remounts on every keystroke and takes the caret with it.
 *
 * There is no arithmetic here and no "priced" state to track. Unlike `purchases`'
 * `DocumentEditor` — which edits a *saved* document and shows the server's own totals for
 * the content on screen — this form produces exactly one request and is done: there is
 * nothing to reprice, because nothing has been saved yet for the server to price.
 */
export interface ReviewLine {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — the wire form (`Quantity`). */
  readonly quantity: string;
  readonly accountId: string | null;
  /** `null` means **no tax**, which D-35 distinguishes from a zero-rated rate. */
  readonly taxRateId: string | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly unitAmount: string | null;
}

export interface ReviewState {
  readonly contactId: string | null;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly taxMode: TaxMode;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly ReviewLine[];
}

let nextLocalKey = 0;

function freshKey(): string {
  nextLocalKey += 1;
  return `line-${String(nextLocalKey)}`;
}

export function blankLine(): ReviewLine {
  return {
    key: freshKey(),
    description: '',
    // One is the quantity of almost every captured bill line, and it is a pre-fill rather
    // than a rule: the field is editable.
    quantity: '1',
    accountId: null,
    taxRateId: null,
    unitAmount: null,
  };
}

/**
 * `YYYY-MM-DD`, local time. Duplicated from `purchases/editor-state.ts` and
 * `dunning/queries.ts` rather than imported — each screen is self-contained
 * (`sales/queries.ts`'s reason), and this is three lines with nothing to drift.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Seeds the form from what extraction found.
 *
 * `matchedContactId` pre-selects the vendor when extraction resolved exactly one active
 * vendor contact from the name on the document; otherwise it is `null` and the combobox
 * opens empty, for a human to choose or create the contact — extraction does not invent
 * one (D-25's "no name lookup exists yet" is the service's own account of this same
 * boundary, on `DocumentCapture.matchedContactId`). Every extracted line seeds a row with
 * no account and no tax rate: extraction reads a description, a quantity and an amount off
 * the document, never a chart-of-accounts posting, so those two fields are exactly what
 * review adds that extraction could not.
 */
export function stateFromCapture(capture: DocumentCapture, today: string): ReviewState {
  const lines = capture.lines.map((line): ReviewLine => ({
    key: freshKey(),
    description: line.description ?? '',
    quantity: line.quantity,
    accountId: null,
    taxRateId: null,
    unitAmount: line.unitAmount,
  }));

  return {
    contactId: capture.matchedContactId,
    issueDate: capture.extractedIssueDate ?? today,
    dueDate: '',
    taxMode: 'exclusive',
    reference: capture.extractedReference ?? '',
    memo: '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A row nobody has touched. Dropped on submit rather than complained about — an unused
 * row at the bottom of the table is not an error, it is an unused row. */
export function isUntouched(line: ReviewLine): boolean {
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
 * Matches `purchases/editor-state.ts`'s `lineProblem` field for field: `DocumentLineRequest`
 * requires `description`, `accountId`, `quantity` and `unitAmount`, so there is no partial
 * body the server could give a per-field verdict on, and this is the one place the form
 * refuses something the server would also refuse.
 */
export function lineProblem(line: ReviewLine): LineProblem | null {
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
  /** Keyed by `ReviewLine.key`. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

export function problemsIn(state: ReviewState): StateProblems {
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

function toRequestLine(line: ReviewLine): DocumentLineRequest {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    // Non-null by construction: `problemsIn` is checked before a submit is attempted, and
    // the `??` values below are unreachable rather than defaults. They are written as
    // empty strings so that a bug here fails the server's validator loudly instead of
    // being papered over with a plausible-looking account.
    accountId: line.accountId ?? '',
    unitAmount: line.unitAmount ?? '',
    taxRateId: line.taxRateId,
  };
}

/** The whole request `POST .../draft` takes — the same shape as a bill create (D-25's
 * "the vendor extraction could not resolve on its own is what `contactId` supplies here"). */
export function requestFromState(state: ReviewState): CreateDraftFromCaptureBody {
  const dueDate = blankToNull(state.dueDate);

  return {
    contactId: state.contactId ?? '',
    issueDate: state.issueDate,
    ...(dueDate === null ? {} : { dueDate }),
    taxMode: state.taxMode,
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}
