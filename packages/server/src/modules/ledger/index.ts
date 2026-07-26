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

export { getTrialBalance } from './trial-balance.service';
export type { TrialBalance, TrialBalanceQuery, TrialBalanceRow } from './trial-balance.service';
