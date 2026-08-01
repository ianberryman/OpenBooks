import type { PillTone } from '../../components';
import { dueDateOf } from './queries';
import type { SalesDocument, SalesDocumentSummary } from './queries';

/**
 * The status/overdue helpers read only `status`, `settlement` and the due date, which the
 * list summary and the full document both carry — so the detail header and the list draw
 * their pills from one definition rather than two. `dueDateOf` already accepts either.
 */
type StatusItem = SalesDocument | SalesDocumentSummary;

/**
 * Presentation helpers for the invoices list — the AR mirror of
 * `purchases/ap-document.ts`'s `statusPresentation` / `matchesCardFilter` /
 * `compareBillsForList` (OB-069 UI redesign, invoices side).
 *
 * ## Overdue is a derived display state, not a stored one
 *
 * It is `dueDate < asOf` on two calendar-date strings, the same comparison a `<` on ISO
 * `YYYY-MM-DD` text answers correctly without parsing either side. That is different in
 * kind from `status` and the totals on every `SalesDocumentSummary`, which arrive computed
 * (D-34, D-38) and are never to be re-derived here — a date comparison is not a money
 * computation and does not risk disagreeing with the server the way a second
 * implementation of settlement would.
 *
 * ## Why the card filter and the sort are client-side
 *
 * `unpaid` spans two statuses (`approved`, `part_paid`) and `overdue` is a due-date
 * comparison against `asOf` — neither is a filter `/v1/invoices` offers — so both narrow
 * the page already loaded rather than refetching. `settlement.outstanding` and `status`
 * are still the server's; the helpers below only read them.
 */
export type InvoiceCardFilter = 'unpaid' | 'overdue' | 'paid';

/**
 * Whether an invoice or credit note is overdue: something is still owed, it has a due
 * date, and that date is behind `asOf`. Used both by `statusPresentation` and by the list
 * to color the due-date and still-owed cells red — one definition of "overdue" rather
 * than two that could drift apart.
 */
export function isOverdue(item: StatusItem, asOf: string): boolean {
  const dueDate = dueDateOf(item);
  return item.settlement.outstanding !== '0' && dueDate !== null && dueDate < asOf;
}

/**
 * The status pill shown on the list, one document at a time.
 *
 * `paid`, `void` and `draft` are named directly from `status`. What remains — `approved`
 * and `part_paid`, both owing — is the mockup's "UNPAID" unless the due date has already
 * passed, in which case it reads "Overdue" instead: a part-paid invoice that has slipped
 * past its due date is still labelled by the date, not by how much of it is left.
 */
export function statusPresentation(
  item: StatusItem,
  asOf: string,
): { label: string; tone: PillTone } {
  if (item.status === 'paid') return { label: 'Paid', tone: 'positive' };
  if (item.status === 'void') return { label: 'Void', tone: 'muted' };
  if (item.status === 'draft') return { label: 'Draft', tone: 'muted' };

  if (isOverdue(item, asOf)) return { label: 'Overdue', tone: 'negative' };

  return { label: 'Unpaid', tone: 'accent' };
}

/**
 * The subset of invoices each summary card stands for, so tapping the card narrows the
 * list to exactly what the card counts (OB-069 UI). `outstanding` and `status` are still
 * the server's; this only reads them.
 */
export function matchesCardFilter(
  item: StatusItem,
  filter: InvoiceCardFilter,
  asOf: string,
): boolean {
  switch (filter) {
    case 'unpaid':
      return item.settlement.outstanding !== '0';
    case 'overdue':
      return isOverdue(item, asOf);
    case 'paid':
      return item.status === 'paid';
  }
}

/**
 * The invoices list's default order: what is still owed first, then by due date so the
 * soonest (and the already-overdue) rise to the top. A settled document
 * (`outstanding === '0'`, covering paid and void) sorts after every owing one, whatever
 * its date. A document with no due date (every credit note, and an invoice not yet dated)
 * sorts last within its group. `outstanding` is the server's; this only reads it to order
 * the page, and reorders nothing on the server.
 */
export function compareInvoicesForList(a: SalesDocumentSummary, b: SalesDocumentSummary): number {
  const aSettled = a.settlement.outstanding === '0' ? 1 : 0;
  const bSettled = b.settlement.outstanding === '0' ? 1 : 0;
  if (aSettled !== bSettled) return aSettled - bSettled;

  const aDue = dueDateOf(a);
  const bDue = dueDateOf(b);
  if (aDue === bDue) return 0;
  if (aDue === null) return 1;
  if (bDue === null) return -1;
  return aDue < bDue ? -1 : 1;
}
