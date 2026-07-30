import type {
  Bill,
  CreateExpenseRequest,
  DocumentLineRequest,
  UpdateExpenseRequest,
} from './queries';

/**
 * The expense form's own model, and the conversion to the create/update requests that
 * store it — `purchases/editor-state.ts`'s shape, sized to what this screen's form
 * actually collects (D-M2's own field list, minus tax): a line the user has added but not
 * yet saved has no `lineId`, and React needs a stable key for it or the row remounts on
 * every keystroke and takes the caret with it.
 *
 * ## No tax rate on this form
 *
 * The line editor this ticket describes has four fields — description, quantity, unit
 * amount, account — and no fifth for a tax rate. `DocumentLineRequest.taxRateId` is
 * optional and "absent or null means no tax — there is no default rate" (the field's own
 * words), so every line this form sends is untaxed by omission, and `taxMode` travels as
 * `'exclusive'` unconditionally: with no tax on any line, which mode it names changes
 * nothing about the amount posted. An org that needs a taxed expense still has the full
 * bill editor (`purchases.tsx`) available, because an expense is a bill (D-M1).
 *
 * What is **not** here, for the same reason `purchases/editor-state.ts` gives, is any
 * arithmetic: a line's net, tax and gross are computed by the server (D-35) and returned
 * on the document; this module carries what was typed and nothing derived from it.
 */
export interface ExpenseLine {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — the wire form (`Quantity`). */
  readonly quantity: string;
  readonly accountId: string | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly unitAmount: string | null;
}

export interface ExpenseFormState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** `''` means "not set" — `dueDate` is optional on `CreateExpenseRequest`. */
  readonly dueDate: string;
  readonly memo: string;
  readonly reference: string;
  readonly lines: readonly ExpenseLine[];
}

let nextLocalKey = 0;

export function blankLine(): ExpenseLine {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One is the quantity of almost every expense line — a receipt total, typed once —
    // and it is a pre-fill rather than a rule: the field is editable.
    quantity: '1',
    accountId: null,
    unitAmount: null,
  };
}

/**
 * Today, from the local calendar rather than from UTC — `purchases/editor-state.ts`'s
 * `todayIsoDate`, copied for the reason its own comment gives: `toISOString().slice(0,
 * 10)` is wrong for a third of every day west of Greenwich.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function blankFormState(today: string = todayIsoDate()): ExpenseFormState {
  return {
    contactId: null,
    issueDate: today,
    dueDate: '',
    memo: '',
    reference: '',
    lines: [blankLine()],
  };
}

export function stateFromExpense(expense: Bill): ExpenseFormState {
  const lines = expense.lines.map((line): ExpenseLine => ({
    key: line.lineId,
    description: line.description,
    quantity: line.quantity,
    accountId: line.accountId,
    unitAmount: line.unitAmount,
  }));

  return {
    contactId: expense.contactId,
    issueDate: expense.issueDate,
    dueDate: expense.dueDate ?? '',
    memo: expense.memo ?? '',
    reference: expense.reference ?? '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A row nobody has touched. Dropped on save rather than complained about — an unused row
 *  at the bottom of a table is not an error, it is an unused row. */
export function isUntouched(line: ExpenseLine): boolean {
  return line.description.trim() === '' && line.accountId === null && line.unitAmount === null;
}

export type LineProblem = 'description' | 'account' | 'unitAmount' | 'quantity';

const PROBLEM_MESSAGES: Readonly<Record<LineProblem, string>> = {
  description: 'This line needs a description.',
  account: 'This line needs an account to post to.',
  unitAmount: 'This line needs an amount.',
  quantity: 'This line needs a quantity.',
};

export function problemMessage(problem: LineProblem): string {
  return PROBLEM_MESSAGES[problem];
}

/**
 * What a half-entered line is missing, or `null` when it is sendable — `purchases/editor-
 * state.ts`'s `lineProblem`, for the same reason: `DocumentLineRequest` requires
 * `description`, `accountId`, `quantity` and `unitAmount`, so there is no body to send
 * that would earn the server's own per-field verdict on a half-entered row.
 */
export function lineProblem(line: ExpenseLine): LineProblem | null {
  if (line.description.trim() === '') return 'description';
  if (line.accountId === null) return 'account';
  if (line.unitAmount === null) return 'unitAmount';
  if (line.quantity.trim() === '') return 'quantity';
  return null;
}

export interface StateProblems {
  readonly employee: boolean;
  readonly issueDate: boolean;
  readonly noLines: boolean;
  /** Keyed by `ExpenseLine.key`. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

export function problemsIn(state: ExpenseFormState): StateProblems {
  const lines = new Map<string, LineProblem>();
  let sendable = 0;

  for (const line of state.lines) {
    if (isUntouched(line)) continue;
    const problem = lineProblem(line);
    if (problem === null) sendable += 1;
    else lines.set(line.key, problem);
  }

  return {
    employee: state.contactId === null,
    issueDate: state.issueDate.trim() === '',
    noLines: sendable === 0 && lines.size === 0,
    lines,
  };
}

export function hasProblems(problems: StateProblems): boolean {
  return problems.employee || problems.issueDate || problems.noLines || problems.lines.size > 0;
}

function toRequestLine(line: ExpenseLine): DocumentLineRequest {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    // Non-null by construction: `problemsIn` is checked before a save is attempted, and
    // the `??` values below are unreachable rather than defaults — written as empty
    // strings so a bug here fails the server's validator loudly instead of being papered
    // over with a plausible-looking account.
    accountId: line.accountId ?? '',
    unitAmount: line.unitAmount ?? '',
    // No `taxRateId` at all: this form collects no tax rate, and its absence is what
    // `DocumentLineRequest` calls "no tax" (D-35) — not the zero-rated case, which would
    // need a rate a person actually chose.
  };
}

/**
 * The create request. `dueDate` is sent only when the form actually holds one — the
 * field is optional on `CreateExpenseRequest`, and an expense with no due date is a real,
 * ordinary case rather than one this form defaults for the user.
 */
export function toCreateRequest(state: ExpenseFormState): CreateExpenseRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize an expense with no employee.');
  }

  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    ...(state.dueDate.trim() === '' ? {} : { dueDate: state.dueDate.trim() }),
    memo: blankToNull(state.memo),
    reference: blankToNull(state.reference),
    taxMode: 'exclusive',
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}

/**
 * The update patch — the whole editable surface, every time, `fixed-assets/asset-
 * state.ts`'s `toUpdateRequest` reasoning: few enough fields that an unconditional patch
 * costs nothing a diff would have saved, and it keeps this a pure mirror of
 * `toCreateRequest` rather than a second set of rules about what changed.
 */
export function toUpdateRequest(state: ExpenseFormState): UpdateExpenseRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize an expense with no employee.');
  }

  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    // Omitted rather than sent as an explicit `undefined`: `exactOptionalPropertyTypes`
    // treats the two differently, and an absent key is what `UpdateExpenseRequest` means
    // by "leave it alone" for a field this form has cleared.
    ...(state.dueDate.trim() === '' ? {} : { dueDate: state.dueDate.trim() }),
    memo: blankToNull(state.memo),
    reference: blankToNull(state.reference),
    taxMode: 'exclusive',
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}

/**
 * A stable string for one save's content, so the idempotency key changes exactly when the
 * request does (`useIntentKey`'s argument, applied to this form).
 */
export function fingerprintOf(input: CreateExpenseRequest | UpdateExpenseRequest): string {
  return JSON.stringify(input);
}
