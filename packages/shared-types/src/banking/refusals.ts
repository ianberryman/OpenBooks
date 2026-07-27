/**
 * The refusals banking is allowed to speak (OB-075; ROADMAP E4–E7, OB-092).
 *
 * ## Why a vocabulary exists here at all, when M3's does not
 *
 * M3 let each service mint its own precondition token at the throw site, and the
 * result is [OB-092](../../../../ROADMAP.md#where-things-stand): AR and AP spell
 * four shared facts differently, one of them not as a `precondition_failed` at all
 * but as a `409 conflict` carrying **no `details` bag**, so a client gets prose and
 * nothing to branch on. `test/enforcement/refusal-vocabulary.test.ts` pins that
 * divergence deliberately — including a property asserting the two vocabularies are
 * unequal — because reconciling them is a published-contract change and its own
 * ticket.
 *
 * M4 fans out across six waves and eighteen tickets, three of which are written in
 * parallel in each of waves 1 and 2. Left to the throw sites, that is the exact
 * shape that produced OB-092, three more times. So the tokens are declared once,
 * here, before the first service exists, and a wave-1 service that needs a refusal
 * this file does not have adds it here rather than inlining a string.
 *
 * ## The register, which is AP's
 *
 * Every entry below is a `details.precondition` on a `precondition_failed` — a
 * `412` with a machine-branchable token, which is what AP does and what OB-092
 * records as the spelling that should win. Nothing in banking may answer a state
 * refusal with a bare `409`.
 *
 * The naming follows AP's shape and not AR's: *subject* then *state*, with the
 * subject named in full (`reconciliation_session_already_finalised`, not
 * `session_finalised`). Long, and deliberately so — `document_approved` on the AP
 * side is ambiguous about whether it is a state or a request, and the tokens that
 * read unambiguously are the ones nobody has to look up.
 *
 * This is **not** a third dialect: no token here restates an M3 fact under a new
 * name. Where banking reaches into the subledger — allocating a cleared line
 * against an open invoice — the refusal is the subledger's own, spoken by the
 * subledger service, and OB-092 is what fixes it there.
 *
 * ## What is not here
 *
 * A malformed file, an unknown column, a date that is not a date: all of those are
 * `validation_failed` on the way in, not preconditions. The distinction is the one
 * `errors.ts` draws — a validation failure means change the request, a precondition
 * failure means change the state.
 */

/**
 * `SCREAMING_SNAKE` key, `snake_case` value, following `ERROR_CODES`: the value
 * appears in a JSON body and the rest of the wire surface is snake_case.
 *
 * A const object rather than the `as const` array the enums in this module use,
 * because a service should name a token rather than retype it — a literal string
 * at a throw site is exactly how AR and AP came to disagree, and a member
 * expression is checked at compile time.
 *
 * A token is **never renamed** once a client can see it, for `ERROR_CODES`'s
 * reason: renaming breaks every consumer silently, at run time, with no compile
 * step anywhere to catch it.
 */
export const BANKING_PRECONDITIONS = {
  /** Importing into, or clearing against, a bank account that has been deactivated. */
  BANK_ACCOUNT_ARCHIVED: 'bank_account_archived',
  /** Deactivating a bank account while a reconciliation session on it is still open. */
  BANK_ACCOUNT_HAS_OPEN_SESSION: 'bank_account_has_open_session',
  /**
   * A saved column mapping used against a file it cannot describe — a CSV mapping
   * on an OFX upload. A mapping names columns, and OFX has none.
   */
  IMPORT_MAPPING_FORMAT_MISMATCH: 'import_mapping_format_mismatch',
  /** Accepting a proposal for a line that already carries a clearing (E3, E4). */
  STATEMENT_LINE_ALREADY_CLEARED: 'statement_line_already_cleared',
  /** Removing a clearing from a line that has none. */
  STATEMENT_LINE_NOT_CLEARED: 'statement_line_not_cleared',
  /**
   * Clearing a line dated after a session's `endDate` into that session. A session
   * asserts a balance *at a date* (D-45), so a later line would be counted in a
   * figure it is not part of.
   */
  STATEMENT_LINE_OUTSIDE_SESSION: 'statement_line_outside_session',
  /**
   * Linking an existing entry that another line has already cleared. One journal
   * settles one statement line; a second link would count the same money twice.
   */
  JOURNAL_ALREADY_CLEARED: 'journal_already_cleared',
  /**
   * E4: the line's amount and what the clearing accounts for do not add up.
   * `clearedAmount + differenceAmount` must equal the line's `amount` exactly.
   */
  CLEARING_AMOUNT_MISMATCH: 'clearing_amount_mismatch',
  /**
   * A non-zero difference with no account to post it to. E4 requires the
   * difference to be *recorded*, and an unposted difference is a number on a
   * screen rather than an entry in the books.
   */
  CLEARING_DIFFERENCE_UNACCOUNTED: 'clearing_difference_unaccounted',
  /** Clearing into, or finalising, a session that has already been finalised (E6). */
  RECONCILIATION_SESSION_ALREADY_FINALISED: 'reconciliation_session_already_finalised',
  /** Reopening a session that is already open (E6). */
  RECONCILIATION_SESSION_NOT_FINALISED: 'reconciliation_session_not_finalised',
  /**
   * E5: finalising when the cleared book balance does not equal the statement's
   * closing balance at the session's end date. This is the refusal the whole
   * milestone exists to be able to make.
   */
  RECONCILIATION_SESSION_BALANCE_MISMATCH: 'reconciliation_session_balance_mismatch',
  /**
   * A session whose date window overlaps an existing one on the same bank account.
   * Overlapping sessions would let one line be cleared into two assertions.
   */
  RECONCILIATION_SESSION_OVERLAPS: 'reconciliation_session_overlaps',
} as const;

export type BankingPrecondition =
  (typeof BANKING_PRECONDITIONS)[keyof typeof BANKING_PRECONDITIONS];

/**
 * The resource tokens banking's `NotFoundError`s carry (E9).
 *
 * `NotFoundError` takes a validated *token* and no message, no details bag and no
 * id echo, so that a cross-org read is byte-identical to a read of something that
 * never existed — 404, never 403. The tokens are declared here for the same reason
 * the preconditions are: eight resources arrive across six waves, and
 * `'bankaccount'` in one service beside `'bank_account'` in the next is a
 * distinguishable answer, which is precisely what A7 forbids.
 *
 * `reconciliationSessionEvent` has no token and needs none: an event is only ever
 * read as part of its session, so there is no path on which one can be missing on
 * its own.
 */
export const BANKING_RESOURCES = {
  BANK_ACCOUNT: 'bank_account',
  BANK_STATEMENT_IMPORT: 'bank_statement_import',
  BANK_STATEMENT_LINE: 'bank_statement_line',
  BANK_IMPORT_MAPPING: 'bank_import_mapping',
  BANK_RULE: 'bank_rule',
  BANK_MATCH_PROPOSAL: 'bank_match_proposal',
  BANK_LINE_CLEARING: 'bank_line_clearing',
  RECONCILIATION_SESSION: 'reconciliation_session',
} as const;

export type BankingResource = (typeof BANKING_RESOURCES)[keyof typeof BANKING_RESOURCES];
