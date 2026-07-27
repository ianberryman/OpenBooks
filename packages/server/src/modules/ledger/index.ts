/**
 * The ledger kernel (spec §7).
 *
 * Everything financial in OpenBooks resolves to a posting made here (spec §2.1), and
 * `posting.repository.ts` is the only code in the tree permitted to write `journals`
 * or `journal_lines` — enforced by `openbooks/no-journal-writes`, not by convention.
 *
 * The reporting service is exported separately from the posting service on purpose:
 * `PostingService` has no read methods and `getTrialBalance` cannot write, so a
 * caller that only needs a report never holds a handle that can post.
 */

export { postJournal, reverseJournal, postingService } from './posting.service';

/**
 * Reading the ledger, keyset-paginated over `(entry_date, sequence_number)` — the
 * list D-21 was decided for, and the use D-14's sequence number was partly created
 * to serve. See `journal-list.service.ts` for why a back-dated entry is what
 * breaks an offset implementation.
 */
export { listJournals } from './journal-list.service';

export { getTrialBalance } from './trial-balance.service';
export type { TrialBalance, TrialBalanceQuery, TrialBalanceRow } from './trial-balance.service';
