import type {
  CreatePurchaseOrderRequest,
  DocumentLine,
  PurchaseOrder,
  UpdatePurchaseOrderRequest,
} from './queries';

/**
 * The create/edit form's own model of a purchase order, and the conversion to the create
 * and update requests that store it — `purchases/editor-state.ts`'s shape, trimmed to what
 * this screen actually collects (D-M7: no dimensions, and no tax-rate picker — see
 * `OrderFormLine.taxRateId` below).
 *
 * A row the user has added but not yet saved has no `lineId`, so `EditorLine`'s reason for
 * a separate local key applies here too: React needs a stable one or a row remounts on
 * every keystroke and takes the caret with it.
 *
 * Nothing here computes a total. `totals` is the server's arithmetic, rounded per line
 * (D-35) exactly as a bill's or an invoice's is, and this module carries what was typed and
 * nothing derived from it.
 */
export interface OrderFormLine {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — the wire form (`Quantity`). */
  readonly quantity: string;
  readonly accountId: string | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly unitAmount: string | null;
  /**
   * Not a field this form exposes — there is no tax-rate control on this screen — but
   * carried through unedited so that opening an order whose lines already name a rate
   * (set by some other client, or restored from an earlier version of this screen) and
   * saving again does not silently clear it. `PredocumentLineRequest.taxRateId` is
   * optional and absent means no tax, which is why a brand-new line leaves this `null`.
   */
  readonly taxRateId: string | null;
}

export interface OrderFormState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** `''` means none — purely informational on the wire (`PurchaseOrder.expectedDate`). */
  readonly expectedDate: string;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly OrderFormLine[];
}

let nextLocalKey = 0;

export function blankLine(): OrderFormLine {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One is the quantity of almost every purchase-order line a buyer types, and it is a
    // pre-fill rather than a rule: the field is editable and negative is legitimate.
    quantity: '1',
    accountId: null,
    unitAmount: null,
    taxRateId: null,
  };
}

/**
 * Today, from the local calendar rather than from UTC — `purchases/editor-state.ts`'s
 * `todayIsoDate`, copied for the reason its own header gives: `toISOString().slice(0, 10)`
 * is wrong for a third of every day west of Greenwich.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function blankFormState(today: string = todayIsoDate()): OrderFormState {
  return {
    contactId: null,
    issueDate: today,
    expectedDate: '',
    reference: '',
    memo: '',
    // "New purchase order" produces an empty draft on the wire (`lines` is optional on
    // create) — one blank row is offered here purely so the dialog does not open on an
    // empty table with no way to start typing.
    lines: [blankLine()],
  };
}

function lineFromDocumentLine(line: DocumentLine): OrderFormLine {
  return {
    key: line.lineId,
    description: line.description,
    quantity: line.quantity,
    accountId: line.accountId,
    unitAmount: line.unitAmount,
    taxRateId: line.taxRateId,
  };
}

export function stateFromOrder(order: PurchaseOrder): OrderFormState {
  const lines = order.lines.map(lineFromDocumentLine);
  return {
    contactId: order.contactId,
    issueDate: order.issueDate,
    expectedDate: order.expectedDate ?? '',
    reference: order.reference ?? '',
    memo: order.memo ?? '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A row nobody has touched. Dropped on save rather than complained about —
 * `purchases/editor-state.ts`'s `isUntouched`: an unused row at the bottom of a table is
 * not an error, it is an unused row. */
export function isUntouched(line: OrderFormLine): boolean {
  return line.description.trim() === '' && line.accountId === null && line.unitAmount === null;
}

export type LineProblem = 'description' | 'account' | 'unitAmount' | 'quantity';

/**
 * What a half-entered line is missing, or `null` when it is sendable —
 * `purchases/editor-state.ts`'s `lineProblem`, checked for the same reason: the request
 * type has no way to express a half-entered line (`PredocumentLineRequest` requires
 * `description`, `accountId`, `quantity` and `unitAmount`), so there is no body a
 * half-filled row could produce for the server to render its own verdict on.
 */
export function lineProblem(line: OrderFormLine): LineProblem | null {
  if (line.description.trim() === '') return 'description';
  if (line.accountId === null) return 'account';
  if (line.unitAmount === null) return 'unitAmount';
  if (line.quantity.trim() === '') return 'quantity';
  return null;
}

export interface StateProblems {
  readonly vendor: boolean;
  readonly issueDate: boolean;
  /** Keyed by `OrderFormLine.key`. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

/**
 * Unlike a bill or an invoice, a purchase order needs no line at all to be created or
 * saved — `createPurchaseOrder`'s own words: "lines is optional... the arity and value
 * checks belong at approval." So there is no `noLines` problem here; a touched line still
 * has to be complete, but an untouched one is simply dropped.
 */
export function problemsIn(state: OrderFormState): StateProblems {
  const lines = new Map<string, LineProblem>();

  for (const line of state.lines) {
    if (isUntouched(line)) continue;
    const problem = lineProblem(line);
    if (problem !== null) lines.set(line.key, problem);
  }

  return {
    vendor: state.contactId === null,
    issueDate: state.issueDate.trim() === '',
    lines,
  };
}

export function hasProblems(problems: StateProblems): boolean {
  return problems.vendor || problems.issueDate || problems.lines.size > 0;
}

export function formIsComplete(state: OrderFormState): boolean {
  return !hasProblems(problemsIn(state));
}

function toRequestLine(line: OrderFormLine): {
  description: string;
  quantity: string;
  accountId: string;
  unitAmount: string;
  taxRateId: string | null;
} {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    // Non-null by construction: `formIsComplete` is checked before a submit is attempted,
    // and the `??` values below are unreachable rather than defaults — written as empty
    // strings so a bug here fails the server's validator loudly rather than being papered
    // over with a plausible-looking account.
    accountId: line.accountId ?? '',
    unitAmount: line.unitAmount ?? '',
    taxRateId: line.taxRateId,
  };
}

/**
 * The create request. `taxMode` is hard-coded to `exclusive` rather than a field this form
 * asks about: with no tax-rate control on any line, there is nothing for the mode to
 * change the meaning of, and exposing the choice would be a control with no effect a user
 * could observe.
 */
export function toCreateRequest(state: OrderFormState): CreatePurchaseOrderRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize a purchase order with no vendor.');
  }

  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    expectedDate: blankToNull(state.expectedDate),
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    taxMode: 'exclusive',
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}

/**
 * The update patch — the whole editable surface, every time, `toCreateRequest`'s sibling.
 * `lines` replaces the entire set (`updatePurchaseOrder`'s own contract), so a line dropped
 * from this form is a line dropped from the order, not merely unedited.
 */
export function toUpdateRequest(state: OrderFormState): UpdatePurchaseOrderRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize a purchase order with no vendor.');
  }

  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    expectedDate: blankToNull(state.expectedDate),
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    taxMode: 'exclusive',
    lines: state.lines.filter((line) => !isUntouched(line)).map(toRequestLine),
  };
}
