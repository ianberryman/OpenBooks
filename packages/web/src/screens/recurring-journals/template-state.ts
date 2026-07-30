import type { BalanceTotals } from './balance';
import { totalsOf } from './balance';
import type {
  CreateTemplateRequest,
  RecurringJournalTemplate,
  TemplateFrequency,
  TemplateLineRequest,
  TemplateLineSide,
  TemplateMaterializationMode,
  UpdateTemplateRequest,
} from './queries';

/**
 * The form's own model of a GL template, and the conversion to the create/update requests
 * that store it — `recurring-invoices/template-state.ts`'s shape, adapted to a line that
 * is already a posting instruction (`{ accountId, side, amount, contactId?, description? }`)
 * rather than something priced from a quantity and a unit amount.
 */

/**
 * One line as the form holds it.
 *
 * `key` is the React identity and is never the wire shape's business: `RecurringJournalLine`
 * carries no id at all, so a key minted here — for a fresh row and for one hydrated from an
 * existing template alike — is the only stable identity a line ever has in this file.
 *
 * `side` and `amount` are held apart rather than as one signed number, `journal-entry/
 * draft-state.ts`'s `EditorLine` exactly: the side carries the sign (D-90, mirroring the
 * ledger kernel's own model), so a negative credit is not a representable state and typing
 * into the Credit box on a line that held a debit moves the line rather than giving it two
 * amounts — see `withAmount` below.
 */
export interface TemplateLineDraft {
  readonly key: string;
  readonly accountId: string | null;
  readonly side: TemplateLineSide | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly amount: string | null;
  readonly contactId: string | null;
  readonly description: string;
}

export interface TemplateFormState {
  readonly name: string;
  readonly memo: string;
  readonly materializationMode: TemplateMaterializationMode;
  readonly frequency: TemplateFrequency;
  /** Free text while typed, so the field can sit empty mid-edit; parsed at submit. */
  readonly intervalCount: string;
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
    accountId: null,
    side: null,
    amount: null,
    contactId: null,
    description: '',
  };
}

/**
 * Two blank lines for an empty template — `journal-entry/draft-state.ts`'s
 * `MINIMUM_VISIBLE_LINES`, not a validation rule restated but the shape of the thing being
 * entered: a journal has at least two sides by nature, and a form that opens with one row
 * makes the user discover that by being refused.
 */
const MINIMUM_VISIBLE_LINES = 2;

export function blankFormState(): TemplateFormState {
  return {
    name: '',
    memo: '',
    materializationMode: 'draft',
    frequency: 'monthly',
    intervalCount: '1',
    startDate: '',
    endDate: '',
    lines: [blankLine(), blankLine()],
  };
}

export function stateFromTemplate(template: RecurringJournalTemplate): TemplateFormState {
  const lines = template.lines.map((line, index): TemplateLineDraft => ({
    key: `existing-${String(index)}`,
    accountId: line.accountId,
    side: line.side,
    amount: line.amount,
    contactId: line.contactId ?? null,
    description: line.description ?? '',
  }));

  while (lines.length < MINIMUM_VISIBLE_LINES) lines.push(blankLine());

  return {
    name: template.name,
    memo: template.memo ?? '',
    materializationMode: template.materializationMode,
    frequency: template.frequency,
    intervalCount: String(template.intervalCount),
    // Not stored on the response at all (`startDate` seeded `nextRunDate` once and is
    // gone) — the field simply is not rendered while editing, so this value never reaches
    // a form control. See `template-form.tsx`.
    startDate: '',
    endDate: template.endDate ?? '',
    lines,
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

/** Whether a line has everything `RecurringJournalLineInput` requires. */
export function lineIsComplete(line: TemplateLineDraft): boolean {
  return line.accountId !== null && line.side !== null && line.amount !== null;
}

/** The live balance over every line the form currently holds. */
export function balanceOf(lines: readonly TemplateLineDraft[]): BalanceTotals {
  return totalsOf(lines);
}

/**
 * Whether the form has enough to submit: a name, a start date on create, at least two
 * lines, every line complete, and the lines balanced — the same two rules
 * `assertBalancedLines` (`shared-types/recurring-journals/recurring-journals.ts`) checks
 * server-side, checked here too so a validation round trip for "your lines don't balance"
 * is a worse teacher than a disabled button.
 */
export function formIsComplete(state: TemplateFormState, requireStartDate: boolean): boolean {
  if (state.name.trim() === '') return false;
  if (requireStartDate && state.startDate === '') return false;
  if (state.lines.length < MINIMUM_VISIBLE_LINES) return false;
  if (!state.lines.every(lineIsComplete)) return false;
  return balanceOf(state.lines).difference === 0n;
}

/**
 * Setting one side's amount, which is also how the other side is cleared —
 * `journal-entry/draft-state.ts`'s `withAmount`, copied for the reason `TemplateLineDraft`
 * gives.
 */
export function withAmount(
  line: TemplateLineDraft,
  side: TemplateLineSide,
  amount: string | null,
): TemplateLineDraft {
  if (amount === null) {
    // Clearing the *other* side's field is not an edit to this line: the debit box on a
    // credit line is already empty, and reacting to it would erase the amount the user
    // can see in the box next to it.
    return line.side === side ? { ...line, side: null, amount: null } : line;
  }
  return { ...line, side, amount };
}

function toLineInput(line: TemplateLineDraft): TemplateLineRequest {
  // Not reachable through the submit button (`formIsComplete` gates it), but a line that
  // slipped through would rather throw here than send a request the schema will refuse
  // with a message naming a field this form does not show a value for.
  if (
    !lineIsComplete(line) ||
    line.accountId === null ||
    line.side === null ||
    line.amount === null
  ) {
    throw new Error('Cannot serialize an incomplete recurring journal line.');
  }
  return {
    accountId: line.accountId,
    side: line.side,
    amount: line.amount,
    contactId: line.contactId,
    description: blankToNull(line.description),
  };
}

/**
 * The create request. `startDate` travels once, here, and never again — it seeds
 * `nextRunDate` and is not itself a stored field (`RecurringJournalTemplate`'s own words),
 * so there is no later form this value could be re-sent from even if this screen kept it.
 */
export function toCreateRequest(state: TemplateFormState): CreateTemplateRequest {
  return {
    name: state.name.trim(),
    memo: blankToNull(state.memo),
    materializationMode: state.materializationMode,
    frequency: state.frequency,
    intervalCount: parseCount(state.intervalCount, 1, 1),
    startDate: state.startDate,
    endDate: blankToNull(state.endDate),
    lines: state.lines.map(toLineInput),
  };
}

/**
 * The whole editable surface, every time — `lines` replaces the entire set, and there is
 * no per-field diff the way `contacts/contact-form.tsx` computes one, `recurring-invoices/
 * template-state.ts`'s `toUpdateRequest` reasoning exactly. `isActive` is deliberately
 * absent: it is written by the pause/resume control on the list, never by this form
 * (`queries.ts`'s `useSetTemplateActive`).
 */
export function toUpdateRequest(state: TemplateFormState): UpdateTemplateRequest {
  return {
    name: state.name.trim(),
    memo: blankToNull(state.memo),
    materializationMode: state.materializationMode,
    frequency: state.frequency,
    intervalCount: parseCount(state.intervalCount, 1, 1),
    endDate: blankToNull(state.endDate),
    lines: state.lines.map(toLineInput),
  };
}
