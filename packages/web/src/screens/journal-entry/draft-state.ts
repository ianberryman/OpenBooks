import type { Side } from './balance';
import type { DimensionAxis, DraftLineRequest, JournalDraft, UpdateDraftRequest } from './queries';

/**
 * The editor's own model of a draft, and the conversion to the request that stores it.
 *
 * Separate from the wire shape for one reason: a row the user has added but not yet
 * saved has no `lineId`, and React needs a stable key for it or the row remounts on
 * every keystroke and takes the caret with it. `key` is that identity — server-issued
 * when the line came back from a save, locally minted otherwise.
 *
 * Nothing here refuses anything. D-16 and D-19 make a draft the state of a form that is
 * not finished: it holds whatever has been entered so far, and everything a journal
 * requires is checked when it is posted. An editor that would not let a half-typed line
 * be saved is the thing a draft exists to avoid.
 */
export interface EditorLine {
  readonly key: string;
  readonly accountId: string | null;
  readonly contactId: string | null;
  readonly side: Side | null;
  /** Minor units on the wire (D-13), or `null` for an empty amount field. */
  readonly amount: string | null;
  readonly memo: string;
  readonly dimensionValueIds: readonly string[];
}

export interface EditorState {
  /** `YYYY-MM-DD`, or `''` when the draft carries no date yet. */
  readonly entryDate: string;
  readonly reference: string;
  readonly memo: string;
  readonly lines: readonly EditorLine[];
}

let nextLocalKey = 0;

export function blankLine(): EditorLine {
  nextLocalKey += 1;
  return {
    key: `new-${String(nextLocalKey)}`,
    accountId: null,
    contactId: null,
    side: null,
    amount: null,
    memo: '',
    dimensionValueIds: [],
  };
}

/**
 * Two blank lines for an empty draft.
 *
 * Not a validation rule restated — the kernel decides arity along with balance and
 * one-sidedness — but the shape of the thing being entered. A journal has at least two
 * sides by nature, and a form that opens with one row makes the user discover that by
 * being refused.
 */
export const MINIMUM_VISIBLE_LINES = 2;

export function stateFromDraft(draft: JournalDraft): EditorState {
  const lines = draft.lines.map((line): EditorLine => ({
    key: line.lineId,
    accountId: line.accountId,
    contactId: line.contactId,
    side: line.side,
    // A stored line with no side reads back with an amount of `"0"` rather than null
    // (the `JournalDraftLine` contract), and showing a user `0.00` in a field they
    // left empty invites them to clear a zero they never typed.
    amount: line.side === null ? null : line.amount,
    memo: line.memo ?? '',
    dimensionValueIds: line.dimensionValueIds,
  }));

  while (lines.length < MINIMUM_VISIBLE_LINES) lines.push(blankLine());

  return {
    entryDate: draft.entryDate ?? '',
    reference: draft.reference ?? '',
    memo: draft.memo ?? '',
    lines,
  };
}

function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

function toRequestLine(line: EditorLine): DraftLineRequest {
  return {
    accountId: line.accountId,
    contactId: line.contactId,
    side: line.side,
    amount: line.amount,
    memo: blankToNull(line.memo),
    // Copied rather than passed: the request type is a mutable `string[]`, and handing
    // it the array the editor is still holding would let the serializer and the UI share
    // one object.
    dimensionValueIds: [...line.dimensionValueIds],
  };
}

/**
 * The whole draft, every time — `lines` replaces the entire set.
 *
 * That is the route's contract rather than a simplification: per-line patching would
 * need line identities that survive an edit inserting a row in the middle, and the
 * client is a form that holds every line already (`transport/routes/drafts.ts`).
 */
export function patchFromState(state: EditorState): UpdateDraftRequest {
  return {
    entryDate: blankToNull(state.entryDate),
    reference: blankToNull(state.reference),
    memo: blankToNull(state.memo),
    lines: state.lines.map(toRequestLine),
  };
}

/**
 * Setting one side's amount, which is also how the other side is cleared.
 *
 * A journal line moves one side only — the side carries the sign, which is why no
 * amount in this system is ever negative — so typing into Credit on a line that held a
 * debit moves the line rather than giving it two amounts.
 */
export function withAmount(line: EditorLine, side: Side, amount: string | null): EditorLine {
  if (amount === null) {
    // Clearing the *other* side's field is not an edit to this line: the debit box on a
    // credit line is already empty, and reacting to it would erase the amount the user
    // can see in the box next to it.
    return line.side === side ? { ...line, side: null, amount: null } : line;
  }
  return { ...line, side, amount };
}

/**
 * The value this line carries on one axis, or `null`.
 *
 * A dimension value names its own axis (`SetJournalLineDimensionsRequest`), so the line
 * stores a flat list of value ids and the axis is resolved by lookup rather than stored
 * twice.
 */
export function valueOnAxis(line: EditorLine, axis: DimensionAxis): string | null {
  const onAxis = new Set(axis.values.map((value) => value.id));
  return line.dimensionValueIds.find((id) => onAxis.has(id)) ?? null;
}

/** At most one value per axis — the unique key the schema carries, applied as you type. */
export function withAxisValue(
  line: EditorLine,
  axis: DimensionAxis,
  valueId: string | null,
): EditorLine {
  const onAxis = new Set(axis.values.map((value) => value.id));
  const others = line.dimensionValueIds.filter((id) => !onAxis.has(id));
  return {
    ...line,
    dimensionValueIds: valueId === null ? others : [...others, valueId],
  };
}

/**
 * Today, from the local calendar rather than from UTC.
 *
 * `toISOString().slice(0, 10)` is the obvious version and it is wrong for a third of
 * every day west of Greenwich: an entry made at 7pm in New York would be dated
 * tomorrow, land in next month's period, and be refused or misfiled depending on which
 * periods are open.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
