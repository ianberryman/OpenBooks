import type { components } from '../../api';

/**
 * The multi-entry clear, as drafts the editor builds before it is a request (OB-140;
 * ROADMAP D-80, D-81, D-106).
 *
 * ## Why a draft is not the wire shape
 *
 * `ClearBankStatementLineRequestInput['entries'][number]` names exactly what the server
 * needs to post — `accountId`, `targetId`/`targetType`, a positive `amount` — and nothing
 * about how a person found it. Building one entry means picking a contact before a
 * document is choosable, and remembering what a document's own `outstanding` was so
 * "In full" has something to fill in; none of that belongs on the wire. So a draft carries
 * the server's fields plus the picker state, and `toWireEntry` is the one place that
 * narrows back down to what gets sent.
 *
 * ## The running difference, in one sentence
 *
 * `clearBankStatementLine` requires `Σ(entries, excluding discount) + differenceAmount ===
 * line.amount`, signed in the line's frame (`clearing.service.ts`'s own file header). Every
 * non-`discount` entry's `amount` is a **positive magnitude** — the server signs it to
 * match the line — so the client-side arithmetic never has to reconstruct a sign: it
 * compares the *magnitude* entered against the line's own magnitude and the difference is
 * whatever is left. `discount` entries are excluded from that sum on both sides (D-106):
 * they settle a document out of their own journal, not out of the line's cash.
 */

export type ClearRequest = components['schemas']['ClearBankStatementLineRequestInput'];
export type WireEntry = ClearRequest['entries'][number];

interface EntryBase {
  /** A stable React key, never sent — the wire entries carry no id of their own. */
  readonly key: string;
  readonly memo: string | null;
}

export interface PostEntryDraft extends EntryBase {
  readonly method: 'post_entry';
  readonly accountId: string | null;
  /** Positive magnitude, minor units. `null` is "not yet typed", not zero. */
  readonly amount: string | null;
}

export interface AllocateDocumentDraft extends EntryBase {
  readonly method: 'allocate_document';
  /** Picker state only — narrows which document a contact's open documents offers. */
  readonly contactId: string | null;
  readonly targetType: 'invoice' | 'bill';
  readonly targetId: string | null;
  /** The chosen document's own outstanding, carried for the "In full" default — never sent. */
  readonly outstanding: string | null;
  readonly amount: string | null;
}

export interface DiscountEntryDraft extends EntryBase {
  readonly method: 'discount';
  readonly contactId: string | null;
  readonly targetType: 'invoice' | 'bill';
  readonly targetId: string | null;
  readonly accountId: string | null;
  /** Never defaulted (schema's own words: "a discount is never the whole of the line"). */
  readonly amount: string | null;
}

export type EntryDraft = PostEntryDraft | AllocateDocumentDraft | DiscountEntryDraft;

/**
 * The three methods this editor builds — deliberately not `WireEntry['method']`, which
 * also carries `link_entry` (linking to a journal already posted). OB-140 offers
 * `post_entry`/`allocate_document`/`discount` only: a `link_entry` has no picker of its own
 * here and stays the proposal-acceptance path's (`proposalToClearRequest`) — nothing in
 * the ticket's scope asks an operator to type a journal id by hand.
 */
export type EntryMethod = EntryDraft['method'];

let keySeq = 0;

/** A fresh draft key. Module-scoped counter rather than `crypto.randomUUID()`: these never
 *  leave the browser tab, so a React list key needs only to be distinct, not unguessable. */
export function nextEntryKey(): string {
  keySeq += 1;
  return `entry-${String(keySeq)}`;
}

export function blankPostEntry(): PostEntryDraft {
  return { key: nextEntryKey(), method: 'post_entry', accountId: null, amount: null, memo: null };
}

export function blankAllocateDocument(targetType: 'invoice' | 'bill'): AllocateDocumentDraft {
  return {
    key: nextEntryKey(),
    method: 'allocate_document',
    contactId: null,
    targetType,
    targetId: null,
    outstanding: null,
    amount: null,
    memo: null,
  };
}

export function blankDiscount(targetType: 'invoice' | 'bill'): DiscountEntryDraft {
  return {
    key: nextEntryKey(),
    method: 'discount',
    contactId: null,
    targetType,
    targetId: null,
    accountId: null,
    amount: null,
    memo: null,
  };
}

/**
 * A `discount` entry pre-filled from a confirmed suggestion (OB-138) — the one-click
 * affordance the discount preview offers, never added on its own (D-43). Always a fresh
 * key, so confirming the same document's suggestion twice (once removed, once re-added)
 * never collides with an entry still in the list.
 */
export function discountEntryFromSuggestion(
  contactId: string | null,
  targetType: 'invoice' | 'bill',
  suggestion: {
    readonly targetId: string;
    readonly accountId: string;
    readonly discountAmountMinor: string;
  },
): DiscountEntryDraft {
  return {
    key: nextEntryKey(),
    method: 'discount',
    contactId,
    targetType,
    targetId: suggestion.targetId,
    accountId: suggestion.accountId,
    amount: suggestion.discountAmountMinor,
    memo: null,
  };
}

/**
 * The one target type a line's entries offer — "an inbound line settles an invoice, an
 * outbound one a bill" (`clearBankStatementLineRequestSchema`'s own words). Fixed by the
 * line's sign rather than chosen per entry: `recordPayment`'s `direction` is derived from
 * the same sign (`paymentDirectionFor`), so an entry naming the other document type would
 * be refused server-side as `allocation_target_mismatch` — not offered here in the first
 * place.
 */
export function naturalTargetType(lineAmount: string): 'invoice' | 'bill' {
  return BigInt(lineAmount) >= 0n ? 'invoice' : 'bill';
}

export function magnitude(signedMinor: string): bigint {
  const value = BigInt(signedMinor);
  return value < 0n ? -value : value;
}

/**
 * One entry's contribution to the sum the line must balance to — its own `amount` if
 * typed, or `null` when it is missing and cannot default (every entry once the request
 * holds more than one, per `resolveEntryAmount`'s own refusal).
 */
export function resolvedMagnitude(
  entry: EntryDraft,
  isSole: boolean,
  lineAmount: string,
): bigint | null {
  if (entry.amount !== null && entry.amount !== '') return magnitude(entry.amount);
  return isSole ? magnitude(lineAmount) : null;
}

/** Whether one entry has everything its method needs, aside from `amount` (checked by
 *  `resolvedMagnitude`/the sole-entry default). */
export function entryFieldsComplete(entry: EntryDraft): boolean {
  switch (entry.method) {
    case 'post_entry':
      return entry.accountId !== null;
    case 'allocate_document':
      return entry.targetId !== null;
    case 'discount':
      return entry.targetId !== null && entry.accountId !== null && entry.amount !== null;
  }
}

/**
 * The magnitude entered so far, summed over every non-`discount` entry that resolves to
 * one. An entry with no resolvable amount (a second-or-later entry with nothing typed)
 * contributes nothing to this sum and is surfaced separately as incomplete — `remaining`
 * below would otherwise read as "balanced" while a blank field sat in the list.
 */
export function sumEnteredMagnitude(entries: readonly EntryDraft[], lineAmount: string): bigint {
  const isSole = entries.length === 1;
  return entries.reduce((total, entry) => {
    if (entry.method === 'discount') return total;
    const resolved = resolvedMagnitude(entry, isSole, lineAmount);
    return resolved === null ? total : total + resolved;
  }, 0n);
}

/** `line's magnitude − entered magnitude`. Positive: short of the line. Negative: over it.
 *  Zero: balanced, and no `differenceAccountId` is needed. */
export function remainingMagnitude(entries: readonly EntryDraft[], lineAmount: string): bigint {
  return magnitude(lineAmount) - sumEnteredMagnitude(entries, lineAmount);
}

/** Every entry has what its method needs, and — once there is more than one — an amount
 *  of its own (`resolveEntryAmount`'s refusal, checked client-side before it is a 412). */
export function allEntriesComplete(entries: readonly EntryDraft[], lineAmount: string): boolean {
  if (entries.length === 0) return false;
  const isSole = entries.length === 1;
  return entries.every(
    (entry) => entryFieldsComplete(entry) && resolvedMagnitude(entry, isSole, lineAmount) !== null,
  );
}

/**
 * Ready to submit: every entry complete, and the line accounted for — balanced, or a
 * difference account named for the residual (E4, `clearing_difference_unaccounted`).
 */
export function canSubmit(
  entries: readonly EntryDraft[],
  lineAmount: string,
  differenceAccountId: string | null,
): boolean {
  if (!allEntriesComplete(entries, lineAmount)) return false;
  const remaining = remainingMagnitude(entries, lineAmount);
  return remaining === 0n || differenceAccountId !== null;
}

/** One draft, narrowed to what the wire accepts — `amount` omitted when it is the sole
 *  entry and nothing was typed, letting the server default it to the whole line. */
export function toWireEntry(entry: EntryDraft): WireEntry {
  const memo = entry.memo === null || entry.memo === '' ? {} : { memo: entry.memo };

  switch (entry.method) {
    case 'post_entry': {
      if (entry.accountId === null) {
        throw new Error('An incomplete post_entry draft reached toWireEntry.');
      }
      return {
        method: 'post_entry',
        accountId: entry.accountId,
        ...(entry.amount === null || entry.amount === '' ? {} : { amount: entry.amount }),
        ...memo,
      };
    }
    case 'allocate_document': {
      if (entry.targetId === null) {
        throw new Error('An incomplete allocate_document draft reached toWireEntry.');
      }
      return {
        method: 'allocate_document',
        targetId: entry.targetId,
        targetType: entry.targetType,
        ...(entry.amount === null || entry.amount === '' ? {} : { amount: entry.amount }),
        ...memo,
      };
    }
    case 'discount': {
      if (entry.targetId === null || entry.accountId === null || entry.amount === null) {
        throw new Error('An incomplete discount draft reached toWireEntry.');
      }
      return {
        method: 'discount',
        accountId: entry.accountId,
        amount: entry.amount,
        targetId: entry.targetId,
        targetType: entry.targetType,
        ...memo,
      };
    }
  }
}

/** The request body, once `canSubmit` says the draft set is ready. */
export function toClearRequest(
  entries: readonly EntryDraft[],
  differenceAccountId: string | null,
): ClearRequest {
  return {
    entries: entries.map((entry) => toWireEntry(entry)),
    ...(differenceAccountId === null ? {} : { differenceAccountId }),
  };
}
