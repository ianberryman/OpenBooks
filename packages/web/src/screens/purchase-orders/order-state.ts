import type {
  CreatePurchaseOrderRequest,
  DocumentLine,
  PurchaseOrder,
  UpdatePurchaseOrderRequest,
} from './queries';

/**
 * The draft editor's own model of a purchase order, and the conversion to the create/update
 * requests that store it — the AP-side mirror of `estimates/estimate-state.ts`, adapted to a
 * predocument line: no `id`, no computed `net`/`tax`/`gross`, and — per `PredocumentLine
 * RequestInput`'s own description (D-M7) — no `dimensionValueIds` either. A purchase order (like
 * an estimate) carries no dimension tags in v1; a converted draft bill can have them added
 * afterward, but not before.
 *
 * ## `taxMode` is fixed, not a field on this form
 *
 * `CreatePurchaseOrderRequest.taxMode` is required on the wire (D-35: it decides what a line's
 * `unitAmount` means), but this form offers no tax-rate control on a line at all, so no line
 * this screen ever writes carries one — the mode has nothing to apply to. Rather than show a
 * control whose two settings would be indistinguishable in every total this screen displays,
 * `'exclusive'` travels fixed and unexposed, the same way a line with no rate prices identically
 * under either mode.
 *
 * ## A purchase order needs no line to be saved
 *
 * Unlike an estimate (which requires at least one line to *approve*, though not to save a
 * draft), a purchase order needs no line at all to be created or saved —
 * `createPurchaseOrder`'s own words: "lines is optional... the arity and value checks belong at
 * approval." So a fully-blank trailing row is not an error here; it is simply dropped on save
 * (`isUntouched`). A row the buyer *started* still has to be completed before it can go, which
 * is the only line-level check this form makes.
 */

export interface OrderLineDraft {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — `Quantity` on the wire. */
  readonly quantity: string;
  /** Minor units (D-13), or `null` for an empty field. */
  readonly unitAmountMinor: string | null;
  readonly accountId: string | null;
  /**
   * Not a field this form exposes — there is no tax-rate control on this screen — but carried
   * through unedited so that opening an order whose lines already name a rate (set by some
   * other client) and saving again does not silently clear it. `PredocumentLineRequest.
   * taxRateId` is optional and absent means no tax, which is why a brand-new line leaves this
   * `null`.
   */
  readonly taxRateId: string | null;
  /**
   * The catalog item this line was seeded from, or `null` for a hand-typed line. Provenance
   * only (D-CAT-2) — carried through unedited, never re-read to reprice.
   */
  readonly catalogItemId: string | null;
}

export interface OrderFormState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** `''` means none (`expectedDate: null` on the wire) — purely informational either way. */
  readonly expectedDate: string;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly OrderLineDraft[];
}

let nextLocalKey = 0;

export function blankLine(): OrderLineDraft {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One is the quantity of almost every purchase-order line a buyer types, and it is a
    // pre-fill rather than a rule: the field is editable and a blank quantity is something the
    // buyer would otherwise have to type to get past a row they did mean to keep.
    quantity: '1',
    unitAmountMinor: null,
    accountId: null,
    taxRateId: null,
    catalogItemId: null,
  };
}

/**
 * `new Date()`'s calendar date, in the `YYYY-MM-DD` shape the wire takes — copied from the old
 * `order-state.ts` for the reason its own header gave: `toISOString().slice(0, 10)` is wrong
 * for a third of every day west of Greenwich.
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
    lines: [blankLine()],
  };
}

function lineFromDocumentLine(line: DocumentLine): OrderLineDraft {
  return {
    key: line.lineId,
    description: line.description,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmount,
    accountId: line.accountId,
    taxRateId: line.taxRateId,
    catalogItemId: line.catalogItemId,
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

/**
 * A row nobody has touched. Dropped on save rather than complained about — the old
 * `order-state.ts`'s `isUntouched`: an unused row at the bottom of a table is not an error, it
 * is an unused row, and a purchase order is allowed to have no lines at all.
 */
export function isUntouched(line: OrderLineDraft): boolean {
  return line.description.trim() === '' && line.accountId === null && line.unitAmountMinor === null;
}

export type LineProblem = 'description' | 'account' | 'unitAmount' | 'quantity';

/**
 * What a half-entered line is missing, or `null` when it is sendable. Checked for the same
 * reason the old `order-state.ts` checked it: the request type has no way to express a
 * half-entered line (`PredocumentLineRequest` requires `description`, `accountId`, `quantity`
 * and `unitAmount`), so there is no body a half-filled row could produce for the server to
 * render its own verdict on.
 */
export function lineProblem(line: OrderLineDraft): LineProblem | null {
  if (line.description.trim() === '') return 'description';
  if (line.accountId === null) return 'account';
  if (line.unitAmountMinor === null) return 'unitAmount';
  if (line.quantity.trim() === '') return 'quantity';
  return null;
}

/** A line that is both started and finished — the editor's hint reads this to know a started
 * row is ready. An untouched row is not "complete" (it has no description), which is why the
 * editor pairs this with `isUntouched` rather than asking every row to satisfy it. */
export function lineIsComplete(line: OrderLineDraft): boolean {
  return lineProblem(line) === null;
}

export interface StateProblems {
  readonly vendor: boolean;
  readonly issueDate: boolean;
  /** Keyed by `OrderLineDraft.key`; holds only the *started* lines that are incomplete. */
  readonly lines: ReadonlyMap<string, LineProblem>;
}

/**
 * Unlike a bill or an invoice, a purchase order needs no line at all to be created or saved —
 * `createPurchaseOrder`'s own words. So there is no `noLines` problem here; a touched line
 * still has to be complete, but an untouched one is simply dropped.
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

/** The element type of a create/update request's `lines` — `PredocumentLineRequestInput`,
 * reached through the request type so this module needs no second import of the wire schema. */
type OrderLineRequest = NonNullable<CreatePurchaseOrderRequest['lines']>[number];

function toRequestLine(line: OrderLineDraft): OrderLineRequest {
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    // Non-null by construction: only lines that pass `lineProblem`/`isUntouched` reach here,
    // and the `??` values below are unreachable rather than defaults — written as empty
    // strings so a bug here fails the server's validator loudly rather than being papered over
    // with a plausible-looking account.
    accountId: line.accountId ?? '',
    unitAmount: line.unitAmountMinor ?? '',
    taxRateId: line.taxRateId,
    // Provenance only (D-CAT-2): recorded so the line remembers the item it was seeded from.
    catalogItemId: line.catalogItemId,
  };
}

/**
 * The create request. `taxMode` is hard-coded to `exclusive` rather than a field this form asks
 * about: with no tax-rate control on any line, there is nothing for the mode to change the
 * meaning of, and exposing the choice would be a control with no effect a user could observe.
 * Untouched rows are dropped rather than sent, so a draft with a blank trailing line writes no
 * line at all.
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
 * from this form is a line dropped from the order, not merely unedited. Never reachable once
 * approved — `updatePurchaseOrder` refuses with `purchase_order_approved` before this editor is
 * even offered (`purchase-orders.tsx` only opens it for a draft).
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
