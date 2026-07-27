import type { ActorProvenance } from './actor';
import type { OperationContext } from './context';
import type { CalendarDate, Instant, MinorUnits } from './primitives';
import type { ServiceToken } from './registry';

export const JOURNAL_SIDES = ['debit', 'credit'] as const;

export type JournalSide = (typeof JOURNAL_SIDES)[number];

/**
 * A line names one side and a positive amount, rather than carrying separate
 * `debit` and `credit` amounts as the table does (OB-011).
 *
 * Two amount fields make "both sides set" and "neither side set" constructible,
 * and both are invariant violations that the spec §11 property tests would then
 * have to catch at runtime. With a side discriminator they do not typecheck, and
 * the only thing left to validate is that the amount is positive. Mapping to the
 * two columns happens in the repository, where the table shape belongs.
 */
export interface JournalLineInput {
  readonly accountId: string;
  readonly side: JournalSide;
  /** Strictly positive. Sign is carried by `side` — a negative credit is not a debit. */
  readonly amount: MinorUnits;
  readonly memo?: string;
  /**
   * Who the line is with. `journal_lines.contact_id` is a column of the line, so
   * naming it is part of posting the entry rather than a later annotation — the
   * table is append-only and there is no operation that could add it afterwards
   * (OB-059).
   */
  readonly contactId?: string;
  /**
   * The dimension values this line is tagged with, named by value and never by
   * axis (D-18). Written with the line, in the posting's own transaction, so an
   * entry and everything entered with it commit together; *changing* a tag on a
   * line that already exists stays `dimensions.setJournalLineDimensions` (D-32).
   */
  readonly dimensionValueIds?: readonly string[];
}

/**
 * Actor provenance is on the input rather than read from `ctx` because the two
 * legitimately differ: a scheduled automation posts as `actorType: 'automation'`
 * with `invocationMode: 'scheduled'` while the surrounding context belongs to the
 * worker that drained the queue. What is here is what the journal row persists.
 *
 * There is no `orgId` and no `currency`. Org scope comes from `ctx` (see
 * OperationContext); multi-currency is not in scope for M1 and adding a field
 * the kernel would ignore would be worse than its absence.
 */
export interface PostJournalInput extends ActorProvenance {
  readonly date: CalendarDate;
  readonly memo?: string;
  /** At least two lines, balanced. Enforced in OB-020 — arity is not expressible here. */
  readonly lines: readonly JournalLineInput[];
}

/**
 * Reversal describes an insert, not an edit. D-02: the link lives on the
 * reversing journal because §2.2 forbids updating the original and the app user
 * has no `UPDATE` grant to do it with.
 */
export interface ReverseJournalInput extends ActorProvenance {
  readonly journalId: string;
  /**
   * The reversal's own posting date. Separate from the original's because the
   * original's period is frequently closed by the time an error is found, and
   * the reversal must land somewhere postable (A4).
   */
  readonly date: CalendarDate;
  readonly memo?: string;
}

/**
 * Outputs use `| null` where inputs use `?`. Under `exactOptionalPropertyTypes`
 * those are different types, and a persisted row either holds a value or holds
 * NULL — the property is never absent.
 */
export interface PostedJournalLine {
  readonly lineId: string;
  readonly accountId: string;
  readonly side: JournalSide;
  readonly amount: MinorUnits;
  readonly memo: string | null;
  readonly contactId: string | null;
  /**
   * Read back from `journal_line_dimensions` rather than echoed, so a caller that
   * posted a tagged entry sees the tags the database holds. Unordered.
   */
  readonly dimensionValueIds: readonly string[];
}

export interface PostedJournal {
  readonly journalId: string;
  readonly orgId: string;
  readonly date: CalendarDate;
  readonly memo: string | null;
  readonly postedAt: Instant;
  readonly actorType: ActorProvenance['actorType'];
  readonly actorId: string;
  readonly invocationMode: ActorProvenance['invocationMode'] | null;
  /** Set when this journal reverses another; null otherwise (D-02). */
  readonly reversesJournalId: string | null;
  readonly lines: readonly PostedJournalLine[];
}

/**
 * The one contract the ledger kernel implements and everything else consumes
 * (spec §8). OB-020 is its sole implementation and the only code permitted to
 * write `journals` or `journal_lines`.
 *
 * There are no read methods, deliberately: reporting is a separate service, so a
 * caller that only needs a trial balance never holds a handle that can post.
 */
export interface PostingService {
  postJournal(input: PostJournalInput, ctx: OperationContext): Promise<PostedJournal>;
  reverseJournal(input: ReverseJournalInput, ctx: OperationContext): Promise<PostedJournal>;
}

export const POSTING_SERVICE: ServiceToken<PostingService> = { name: 'ledger.posting' };
