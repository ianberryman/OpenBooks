/**
 * Accepting a match (M4 wave 2, OB-081, generalised by Cash application's OB-137;
 * ROADMAP D-43, D-16, D-45, D-80, D-105, D-106; acceptance E3, E4).
 *
 * The clearing service is where the banking pipeline first writes to the ledger, and
 * it writes because a human accepted a match (D-43, E3) — never as a side effect of
 * matching, which proposes and nothing more. Read `clearing.service.ts` for the four
 * entry kinds a clear may be made of and how E4 is held as an invariant over N of
 * them; `clearing.repository.ts` for why nothing here takes a `FOR UPDATE` on the
 * line or an entry's journal, and for the parent/child split D-105 made of what used
 * to be one row.
 *
 * ## The four entry kinds, and the one undo
 *
 * - `post_entry` — code (part of) the line to an account; the journal is created for it.
 * - `link_entry` — the ledger already has the entry; link it.
 * - `allocate_document` — record a payment and apply it to an invoice or bill (D-39).
 * - `discount` — an early-pay discount (D-79, D-106): post the discount journal and
 *   apply it against a document, without touching the bank ledger account at all.
 * - the difference — posted once, for the whole clear, against whatever residual the
 *   entries above leave (D-105).
 * - undo (`removeBankLineClearing`) — un-match, reversing whatever every entry posted
 *   (never deleting a journal, D-16), and refusing if a finalised session counts it.
 *
 * A clear is one or more entries (`entries.min(1)`); the single-target case OB-081
 * shipped is simply the one-entry array.
 *
 * ## Permissions this module enforces
 *
 * Its own gate is `banking.match`. Beyond it, the ledger and subledger services it
 * calls enforce their own: `post_entry`/`discount` and any difference reach
 * `journals.post`; `allocate_document` reaches `payments_received.write` /
 * `payments_made.write` and `journals.post`; undo reaches `journals.reverse` (and,
 * for an `allocate_document` entry, the payment write). That layering is the OB-093
 * gap, made visible rather than worked around: a role with `banking.match` alone can
 * accept a `link_entry` that posts nothing and is refused the rest.
 *
 * There are no routes: `/v1` for M4 is OB-084, and the wire contracts in
 * `shared-types/src/banking/clearing.ts` deliberately carry no `.meta({ id })` until then.
 */
export {
  assembleClearing,
  assertClearingBalances,
  clearBankStatementLine,
  removeBankLineClearing,
} from './clearing.service';
