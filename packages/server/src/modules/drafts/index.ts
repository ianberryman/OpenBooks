/**
 * Journal drafts (OB-038; ROADMAP D-16, D-19; spec §2.2).
 *
 * ## What a draft is, and what it is not
 *
 * D-16 settles that deletion stays impossible and that reversal is not the UX
 * answer to it: a typo noticed ten seconds after posting should not produce three
 * journal entries. A draft is that answer. An entry that has not reached the
 * ledger may be edited and discarded freely, because it is not yet a posting —
 * which gives the delete-like experience where users actually want it without a
 * mutable ledger anywhere.
 *
 * So a draft is **not a weaker journal**. It is in no report, in no trial
 * balance, and no invariant test applies to it. It has not happened yet. Three
 * absences follow from that and each is enforced by the schema rather than by
 * this module's care (`0002_ledger`):
 *
 *  - **No sequence number.** Numbers come from the counter row at post time
 *    (D-14). A draft that reserved one and was then discarded would leave a gap,
 *    and a gap is indistinguishable from a deleted entry.
 *  - **No period.** The period is resolved from `entry_date` at post, so a draft
 *    written while a period was open and posted after it closed cannot carry a
 *    stale answer.
 *  - **No invariants.** Not balanced, not two-sided, not even complete. The one
 *    thing a draft line may not be is negative, because that is not incompleteness.
 *
 * ## Why the permission is `journals.post` and not a new catalog code
 *
 * Reads take `journals.read`; every write — create, update, discard, and the post
 * itself — takes `journals.post`.
 *
 * A `journals.draft` code was the alternative and it was declined. The catalog is
 * fixed (spec §5) and adding to it is three coordinated edits — the seed in
 * `0001_tenancy`, the union in `modules/permissions/catalog.ts`, and the
 * set-equality test — plus a fourth decision that is the real cost: the six system
 * roles are set operations over the catalog, so a new code lands in Owner and
 * Bookkeeper automatically, misses AP-only and AR-only (explicit lists), and
 * misses Approver, whose bundle is `%.read` plus a named few. Approver holds
 * `journals.post` deliberately — "the point of the role is to be the one who can
 * turn a proposal into a posting" — so a separate draft code would give M2 a role
 * that can post an entry but not compose one, which is incoherent.
 *
 * The deeper reason is that nothing in M2 distinguishes the two capabilities. A
 * role that may draft but not post is a *review* workflow, and review arrives with
 * `agents.review` in M5. When it does, `journals.draft` becomes a code with a
 * meaning and a role to grant it to, and adding it then is the same three edits
 * against a question that has an answer.
 *
 * The two consequences of reusing `journals.post`, stated so they are chosen
 * rather than discovered: an AP-only or AR-only clerk cannot compose a manual
 * journal draft, which matches their not being able to post one; and `read_only`
 * can *see* drafts, which is consistent with a role that reads everything and
 * changes nothing — a draft is org work-in-progress, not private correspondence.
 *
 * ## Posting is the whole ticket
 *
 * `postDraft` runs `postJournal` and deletes the draft in one transaction, keyed
 * on the draft id. Read its commentary in `drafts.service.ts` for the lock order,
 * for what the loser of a concurrent post sees, and for how the line's contact and
 * its tags reach the ledger without this module writing either table (OB-059).
 */

export {
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  postDraft,
  updateDraft,
} from './drafts.service';
