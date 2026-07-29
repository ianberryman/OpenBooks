import type {
  CreateTemplateRequest,
  RecurringInvoiceTemplate,
  TemplateFrequency,
  TemplateLineRequest,
  TemplateMaterializationMode,
  TemplateTaxMode,
  UpdateTemplateRequest,
} from './queries';

/**
 * The form's own model of a template, and the conversion to the create/update requests
 * that store it — `sales/document-state.ts`' shape, adapted to a template's simpler line
 * (no `id`, no computed `net`/`tax`/`gross`: a template line is priced only when a cycle
 * materialises it, never here).
 */

/**
 * One line as the form holds it.
 *
 * `key` is the React identity and is never the wire shape's business: `RecurringInvoiceLine`
 * carries no id at all, so a key minted here — for a fresh row and for one hydrated from an
 * existing template alike — is the only stable identity a line ever has in this file.
 */
export interface TemplateLineDraft {
  readonly key: string;
  readonly description: string;
  /** A decimal string with at most four fraction digits — `Quantity` on the wire. */
  readonly quantity: string;
  /**
   * Minor units (D-13), or `null` for an empty field. Tax-inclusive exactly when the
   * template's `taxMode` is `inclusive` — the same flag that decides it on a document,
   * because a materialised cycle is priced by the same rules an invoice is (D-35).
   */
  readonly unitAmount: string | null;
  readonly accountId: string | null;
  readonly taxRateId: string | null;
}

export interface TemplateFormState {
  readonly contactId: string | null;
  readonly name: string;
  readonly materializationMode: TemplateMaterializationMode;
  readonly taxMode: TemplateTaxMode;
  readonly frequency: TemplateFrequency;
  /** Free text while typed, so the field can sit empty mid-edit; parsed at submit. */
  readonly intervalCount: string;
  readonly dueDays: string;
  readonly memo: string;
  /** `''` means unset. Required on create, fixed thereafter — the form never edits it. */
  readonly startDate: string;
  /** `''` means open-ended (`endDate: null` on the wire). */
  readonly endDate: string;
  readonly lines: readonly TemplateLineDraft[];
}

let nextLocalKey = 0;

export function blankLine(): TemplateLineDraft {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    description: '',
    // One, for `document-state.ts`'s reason: a line is usually one of something, and a
    // blank quantity is a required value the user has to type to get past a row they did
    // not mean to add.
    quantity: '1',
    unitAmount: null,
    accountId: null,
    taxRateId: null,
  };
}

export function blankFormState(): TemplateFormState {
  return {
    contactId: null,
    name: '',
    materializationMode: 'draft',
    taxMode: 'exclusive',
    frequency: 'monthly',
    intervalCount: '1',
    dueDays: '0',
    memo: '',
    startDate: '',
    endDate: '',
    lines: [blankLine()],
  };
}

export function stateFromTemplate(template: RecurringInvoiceTemplate): TemplateFormState {
  const lines = template.lines.map((line, index): TemplateLineDraft => ({
    key: `existing-${String(index)}`,
    description: line.description ?? '',
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    accountId: line.accountId,
    taxRateId: line.taxRateId ?? null,
  }));

  return {
    contactId: template.contactId,
    name: template.name,
    materializationMode: template.materializationMode,
    taxMode: template.taxMode,
    frequency: template.frequency,
    intervalCount: String(template.intervalCount),
    dueDays: String(template.dueDays),
    memo: template.memo ?? '',
    // Not stored on the response at all (`startDate` seeded `nextRunDate` once and is
    // gone) — the field simply is not rendered while editing, so this value never reaches
    // a form control. See `template-form.tsx`.
    startDate: '',
    endDate: template.endDate ?? '',
    lines: lines.length === 0 ? [blankLine()] : lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** An integer at least `minimum`, parsed from free text, or `fallback` when it is not one. */
function parseCount(text: string, fallback: number, minimum: number): number {
  const parsed = Number(text.trim());
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** Whether a line has everything `RecurringInvoiceLineInput` requires. */
export function lineIsComplete(line: TemplateLineDraft): boolean {
  return line.quantity.trim() !== '' && line.unitAmount !== null && line.accountId !== null;
}

/**
 * Whether the form has enough to submit: a name, a customer, a start date on create, at
 * least one line, and every line complete. Checked here rather than left entirely to the
 * server, because a validation round trip for "you have not chosen a customer yet" is a
 * worse teacher than a disabled button.
 */
export function formIsComplete(state: TemplateFormState, requireStartDate: boolean): boolean {
  if (state.contactId === null) return false;
  if (state.name.trim() === '') return false;
  if (requireStartDate && state.startDate === '') return false;
  if (state.lines.length === 0) return false;
  return state.lines.every(lineIsComplete);
}

function toLineInput(line: TemplateLineDraft): TemplateLineRequest {
  // Not reachable through the submit button (`formIsComplete` gates it), but a line that
  // slipped through would rather throw here than send a request the schema will refuse
  // with a message naming a field this form does not show a value for.
  if (!lineIsComplete(line) || line.unitAmount === null || line.accountId === null) {
    throw new Error('Cannot serialize an incomplete template line.');
  }
  return {
    description: blankToNull(line.description),
    quantity: line.quantity.trim(),
    unitAmount: line.unitAmount,
    accountId: line.accountId,
    // Absent or null means *no tax*, never a default rate — there is no default, because
    // a rate nobody chose is a rate that ends up on a filing (D-35).
    taxRateId: line.taxRateId,
  };
}

/**
 * The create request. `startDate` travels once, here, and never again — it seeds
 * `nextRunDate` and is not itself a stored field (`RecurringInvoiceTemplate`'s own words),
 * so there is no later form this value could be re-sent from even if this screen kept it.
 */
export function toCreateRequest(state: TemplateFormState): CreateTemplateRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize a template with no customer.');
  }
  return {
    contactId: state.contactId,
    name: state.name.trim(),
    materializationMode: state.materializationMode,
    taxMode: state.taxMode,
    frequency: state.frequency,
    intervalCount: parseCount(state.intervalCount, 1, 1),
    dueDays: parseCount(state.dueDays, 0, 0),
    memo: blankToNull(state.memo),
    startDate: state.startDate,
    endDate: blankToNull(state.endDate),
    lines: state.lines.map(toLineInput),
  };
}

/**
 * The whole editable surface, every time — `lines` replaces the entire set, and there is
 * no per-field diff the way `contacts/contact-form.tsx` computes one. A template's fields
 * are few enough that an unconditional patch costs nothing a diff would have saved, and it
 * keeps this function a pure mirror of `toCreateRequest` rather than a second set of rules
 * about what changed. `isActive` is deliberately absent: it is written by the pause/resume
 * control on the list, never by this form (`queries.ts`' `useSetTemplateActive`).
 */
export function toUpdateRequest(state: TemplateFormState): UpdateTemplateRequest {
  if (state.contactId === null) {
    throw new Error('Cannot serialize a template with no customer.');
  }
  return {
    contactId: state.contactId,
    name: state.name.trim(),
    materializationMode: state.materializationMode,
    taxMode: state.taxMode,
    frequency: state.frequency,
    intervalCount: parseCount(state.intervalCount, 1, 1),
    dueDays: parseCount(state.dueDays, 0, 0),
    memo: blankToNull(state.memo),
    endDate: blankToNull(state.endDate),
    lines: state.lines.map(toLineInput),
  };
}
