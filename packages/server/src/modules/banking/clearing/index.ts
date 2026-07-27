/**
 * Accepting a match (M4 wave 2, OB-081; ROADMAP D-43, D-16, D-45; acceptance E3, E4).
 *
 * The clearing service is where the banking pipeline first writes to the ledger, and
 * it writes because a human accepted a match (D-43, E3) — never as a side effect of
 * matching, which proposes and nothing more. Read `clearing.service.ts` for the three
 * ways a line is accepted and how E4 is held as an invariant; `clearing.repository.ts`
 * for why nothing here takes a `FOR UPDATE` on the line or the entry.
 *
 * ## The three methods, and the one undo
 *
 * - `post_entry` — code the line to an account; the journal is created for it.
 * - `link_entry` — the ledger already has the entry; link it, and post any difference.
 * - `allocate_document` — record a payment and apply it to an invoice or bill (D-39).
 * - undo (`removeBankLineClearing`) — un-match, reversing whatever the clearing posted
 *   (never deleting a journal, D-16), and refusing if a finalised session counts it.
 *
 * ## Permissions this module enforces
 *
 * Its own gate is `banking.match`. Beyond it, the ledger and subledger services it
 * calls enforce their own: `post_entry` and any difference reach `journals.post`;
 * `allocate_document` reaches `payments_received.write` / `payments_made.write` and
 * `journals.post`; undo reaches `journals.reverse` (and, for an allocation, the payment
 * write). That layering is the OB-093 gap, made visible rather than worked around: a
 * role with `banking.match` alone can accept a `link_entry` that posts nothing and is
 * refused the rest.
 *
 * There are no routes: `/v1` for M4 is OB-084, and the wire contracts in
 * `shared-types/src/banking/clearing.ts` deliberately carry no `.meta({ id })` until then.
 */
export {
  assertClearingBalances,
  clearBankStatementLine,
  removeBankLineClearing,
} from './clearing.service';
