import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import { applyKeyset, instantKey, toKeysetPage, uuidKey } from '../../db';
import type { ApDocumentFilters, ApDocumentRow } from '../bills/ap-documents.repository';

/**
 * The one query that is genuinely expenses' own (initiative M, D-M2, D-M8).
 *
 * Everything else about an expense reuses `ap-documents.repository.ts` verbatim —
 * it is the same `ap_documents` row, `document_type='bill'`. Listing is the
 * exception: `listBills` and `listExpenses` have to be clean mirrors (D-M8), and
 * "clean mirror" means a bill raised against a contact who is *also* flagged an
 * employee has to appear on both lists, which rules out a `WHERE document_type =
 * 'bill' AND NOT <on the bill list>` construction. The honest predicate is the one
 * below: join to `contacts` and filter on the flag the expense list actually
 * means, `is_employee = 1`. The mirror on the bill side — `listBills` gaining an
 * `is_vendor = 1` predicate — is `bills.service.ts`'s own change, out of scope
 * here (this module only imports from it).
 */
const EXPENSE_DOCUMENT_COLUMNS = [
  'ap_documents.id',
  'ap_documents.document_type',
  'ap_documents.sequence_number',
  'ap_documents.contact_id',
  'ap_documents.issue_date',
  'ap_documents.due_date',
  'ap_documents.payment_term_id',
  'ap_documents.tax_mode',
  'ap_documents.reference',
  'ap_documents.memo',
  'ap_documents.journal_id',
  'ap_documents.void_journal_id',
  'ap_documents.created_by_user_id',
  'ap_documents.created_at',
  'ap_documents.updated_at',
] as const;

/** The same ordering `ap-documents.repository.ts` uses for `selectDocumentsPage` (D-21). */
const EXPENSE_DOCUMENT_KEYSET: KeysetOrdering<ApDocumentRow> = [
  instantKey('ap_documents.created_at', (row) => row.created_at),
  uuidKey('ap_documents.id', (row) => row.id),
];

/**
 * One page of this org's expenses: bills whose contact carries `is_employee = 1`.
 *
 * The join condition ties `contacts.org_id` to `ap_documents.org_id` rather than
 * to the context directly, because `TenantDatabase.selectFrom` only injects the
 * scope predicate on the table named in `selectFrom` — a joined table is scoped by
 * construction here, transitively, the same pattern `allocations.repository.ts`
 * uses for its own joins (see `tenant.ts`'s note on why the predicate is
 * qualified). Without it, "ambiguous column" would be the friendliest failure
 * available; the unfriendly one is a cross-org contact silently satisfying the
 * join.
 */
export async function selectExpensesPage(
  db: TenantDatabase,
  filters: ApDocumentFilters,
  limit: number,
): Promise<KeysetPage<ApDocumentRow>> {
  let query = db
    .selectFrom('ap_documents')
    .innerJoin('contacts', (join) =>
      join
        .onRef('contacts.org_id', '=', 'ap_documents.org_id')
        .onRef('contacts.id', '=', 'ap_documents.contact_id'),
    )
    .select(EXPENSE_DOCUMENT_COLUMNS)
    .where('ap_documents.document_type', '=', 'bill')
    .where('contacts.is_employee', '=', 1);

  if (filters.contactId !== undefined) {
    query = query.where('ap_documents.contact_id', '=', filters.contactId);
  }
  if (filters.from !== undefined) {
    query = query.where('ap_documents.issue_date', '>=', filters.from);
  }
  if (filters.to !== undefined) {
    query = query.where('ap_documents.issue_date', '<=', filters.to);
  }
  if (filters.dueBefore !== undefined) {
    query = query.where('ap_documents.due_date', '<', filters.dueBefore);
  }
  if (filters.lifecycle === 'draft') {
    query = query.where('ap_documents.journal_id', 'is', null);
  }
  if (filters.lifecycle === 'void') {
    query = query.where('ap_documents.void_journal_id', 'is not', null);
  }
  if (filters.lifecycle === 'approved') {
    query = query
      .where('ap_documents.journal_id', 'is not', null)
      .where('ap_documents.void_journal_id', 'is', null);
  }

  const rows = await applyKeyset(query, EXPENSE_DOCUMENT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, EXPENSE_DOCUMENT_KEYSET, limit);
}
