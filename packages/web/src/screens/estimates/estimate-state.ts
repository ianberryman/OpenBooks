import type {
  CreateEstimateRequest,
  Estimate,
  PredocumentLineRequest,
  UpdateEstimateRequest,
} from './queries';

/**
 * The create/edit form's own model of an estimate, and the conversion to the create/update
 * requests that store it — `recurring-invoices/template-state.ts`'s shape, adapted to a
 * predocument line: no `id`, no computed `net`/`tax`/`gross`, and — per `PredocumentLine
 * RequestInput`'s own description (D-M7) — no `dimensionValueIds` either. A purchase order
 * or an estimate carries no dimension tags in v1; a converted draft invoice can have them
 * added afterward, but not before.
 *
 * ## `taxMode` is fixed, not a field on this form
 *
 * `CreateEstimateRequest.taxMode` is required on the wire (D-35: it decides what a line's
 * `unitAmount` means), but this form offers no tax-rate picker on a line at all, so no line
 * this screen ever writes carries one — the mode has nothing to apply to. Rather than show
 * a control whose two settings would be indistinguishable in every total this screen ever
 * displays, `'exclusive'` travels fixed and unexposed, the same way a line with no rate
 * prices identically under either mode.
 */

export interface EstimateLineDraft {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — `Quantity` on the wire. */
  readonly quantity: string;
  /** Minor units (D-13), or `null` for an empty field. */
  readonly unitAmountMinor: string | null;
  readonly accountId: string | null;
}

export interface EstimateFormState {
  readonly contactId: string | null;
  readonly issueDate: string;
  /** `''` means unset (`expiryDate: null` on the wire) — purely informational either way. */
  readonly expiryDate: string;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly EstimateLineDraft[];
}

let nextLocalKey = 0;

export function blankLine(): EstimateLineDraft {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One, for `recurring-invoices/template-state.ts`'s reason: a line is usually one of
    // something, and a blank quantity is a required value the user has to type to get past
    // a row they did not mean to add.
    quantity: '1',
    unitAmountMinor: null,
    accountId: null,
  };
}

/** `new Date()`'s calendar date, in the `YYYY-MM-DD` shape the wire takes — `sales/
 *  document-state.ts`'s `todayIsoDate`, copied for this file's self-containment reason. */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function blankFormState(): EstimateFormState {
  return {
    contactId: null,
    issueDate: todayIsoDate(),
    expiryDate: '',
    reference: '',
    memo: '',
    lines: [blankLine()],
  };
}

export function stateFromEstimate(estimate: Estimate): EstimateFormState {
  const lines = estimate.lines.map((line, index): EstimateLineDraft => ({
    key: `existing-${String(index)}`,
    description: line.description,
    quantity: line.quantity,
    unitAmountMinor: line.unitAmount,
    accountId: line.accountId,
  }));

  return {
    contactId: estimate.contactId,
    issueDate: estimate.issueDate,
    expiryDate: estimate.expiryDate ?? '',
    reference: estimate.reference ?? '',
    memo: estimate.memo ?? '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether a line has everything `PredocumentLineRequestInput` requires. */
export function lineIsComplete(line: EstimateLineDraft): boolean {
  return line.quantity.trim() !== '' && line.unitAmountMinor !== null && line.accountId !== null;
}

/**
 * Whether the form has enough to submit: a customer, an issue date, at least one line, and
 * every line complete. Checked here rather than left entirely to the server, because a
 * validation round trip for "you have not chosen a customer yet" is a worse teacher than a
 * disabled button. Approval separately refuses a zero-line estimate
 * (`ValidationError` on `estimates.write` approve) — this form does not anticipate that
 * refusal by requiring a line before a draft can even be *saved*, only before it can be
 * submitted with none at all.
 */
export function formIsComplete(state: EstimateFormState): boolean {
  if (state.contactId === null) return false;
  if (state.issueDate === '') return false;
  if (state.lines.length === 0) return false;
  return state.lines.every(lineIsComplete);
}

function toLineInput(line: EstimateLineDraft): PredocumentLineRequest {
  // Not reachable through the submit button (`formIsComplete` gates it), but a line that
  // slipped through would rather throw here than send a request the schema will refuse
  // with a message naming a field this form does not show a value for.
  if (!lineIsComplete(line) || line.unitAmountMinor === null || line.accountId === null) {
    throw new Error('Cannot serialize an incomplete estimate line.');
  }
  return {
    description: line.description.trim(),
    quantity: line.quantity.trim(),
    unitAmount: line.unitAmountMinor,
    accountId: line.accountId,
  };
}

export function toCreateRequest(state: EstimateFormState): CreateEstimateRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize an estimate with no customer.');
  }
  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    expiryDate: blankToNull(state.expiryDate),
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    // See the file header for why this travels fixed rather than as a field on this form.
    taxMode: 'exclusive',
    lines: state.lines.map(toLineInput),
  };
}

/**
 * The whole editable surface, every time — `lines` replaces the entire set, and there is
 * no per-field diff. `fixed-assets/asset-state.ts`'s reasoning: few enough fields that an
 * unconditional patch costs nothing a diff would have saved, and it keeps this a pure
 * mirror of `toCreateRequest` rather than a second set of rules about what changed. Never
 * reachable once approved — `updateEstimate` refuses with `estimate_approved` before this
 * form is even offered (`estimates.tsx` only opens it for a draft).
 */
export function toUpdateRequest(state: EstimateFormState): UpdateEstimateRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize an estimate with no customer.');
  }
  return {
    contactId: state.contactId,
    issueDate: state.issueDate,
    expiryDate: blankToNull(state.expiryDate),
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    taxMode: 'exclusive',
    lines: state.lines.map(toLineInput),
  };
}
