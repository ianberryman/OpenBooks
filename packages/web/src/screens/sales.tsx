import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { SelectOption } from '../components';
import { cx } from '../lib/cx';
import { useIsCompact } from '../lib/use-viewport';
import { DocumentEditor } from './sales/document-editor';
import { DocumentList } from './sales/document-list';
import { todayIsoDate } from './sales/document-state';
import { DocumentView } from './sales/document-view';
import { compareInvoicesForList, matchesCardFilter } from './sales/invoice-list';
import type { InvoiceCardFilter } from './sales/invoice-list';
import {
  apiFor,
  salesKeys,
  useDocument,
  useDocumentList,
  useInvoicesSummary,
  useSalesReferenceData,
} from './sales/queries';
import type { DocumentStatus, SalesDocumentKind, SalesDocumentSummary } from './sales/queries';
import { Refusal } from './sales/refusal';
import { InvoicesSummaryCards } from './sales/summary-cards';
import { vocabularyFor } from './sales/vocabulary';

/**
 * Sales — invoices and credit notes (OB-068; ROADMAP D-13, D-34, D-35, D-36, D-38, D-39).
 *
 * ## What this screen is for
 *
 * Six of the server's rules are invisible in a plain CRUD form, and a user meets each of
 * them as a refusal unless the screen says so first. Making them legible is the job; none
 * of them is re-enforced here, because a second copy of a rule that lives in
 * `packages/server/src/modules/invoices/` is a copy that drifts.
 *
 * - **Approve is the irreversible step (D-38)**, and it is `POST …/approve` rather than a
 *   patch of `status`. Status is *derived* from the journals and the allocations on every
 *   read, so there is no field to write and the API publishes none. Before approval a
 *   document is editable and discardable; after it, the ledger has been told.
 * - **Status and outstanding are computed, not stored (D-34).** Every figure on this
 *   screen comes off a response. Nothing recomputes outstanding from `allocations`, which
 *   would be a second definition of it — the divergence spec §11 makes an invariant about.
 * - **Tax is per line with a mode on the document (D-35).** `taxMode` decides what
 *   `unitAmount` *means*, so changing it reprices the document rather than converting it,
 *   and the editor confirms that rather than moving the totals silently. No tax arithmetic
 *   happens in this browser: it is rounded twice per line by one implementation, and a
 *   second one would disagree at the cent on a printed invoice.
 * - **A credit note is a document, not a negative invoice (D-39).** Its own tab, its own
 *   gapless series, its own journal — and it reduces an invoice by being *allocated*
 *   against it, through the same rows a payment uses.
 * - **Nothing is deleted (D-16).** A draft is discarded because it never reached the
 *   ledger; an approved document is voided, and the document, its number and its journal
 *   all stay visible.
 * - **Every write carries an `Idempotency-Key`**, minted once per user intent. Approve's
 *   is held against the document id so that repeated clicks are one approval; the rest are
 *   minted per submission, for the reasons in `sales/intent-keys.ts`.
 *
 * ## The list and a document are two routes now, not one piece of state
 *
 * `/sales` is the list; `/sales/invoices/:id` (and the credit-note mirror) is one open
 * document — the same move the purchases screen made (mirror of 46432a6). Routing them
 * rather than holding a `view` in state is what makes an invoice a link someone can send, a
 * page the browser's Back button returns from, and a URL that survives a refresh, and it is
 * what lets the document's breadcrumb be real. The document's *kind* is the path, so an
 * approved credit note opened cold from its URL knows it is a credit without the list
 * having chosen a tab.
 *
 * Which component an open document gets is still decided by its computed status and by
 * nothing else. A draft gets the editor; anything else gets the read-only view, because
 * after approval an edit is refused with `document_approved` and a form that only ever
 * fails is worse than no form at all.
 */
const TABS: readonly SalesDocumentKind[] = ['invoice', 'credit_note'];

const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'part_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

const DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'approved',
  'part_paid',
  'paid',
  'void',
];

function asStatus(value: string): DocumentStatus | null {
  return DOCUMENT_STATUSES.find((status) => status === value) ?? null;
}

/** The URL an open document lives at. Kept in one place so a link and the route table
 * cannot spell the same document two ways. */
function documentPath(kind: SalesDocumentKind, id: string): string {
  const segment = kind === 'invoice' ? 'invoices' : 'credit-notes';
  return `/sales/${segment}/${id}`;
}

/** The intent an approval carries to the read-only view it lands on: an invoice's
 * "Approve & Send" opens the Send dialog straight away. Carried as navigation state so a
 * refresh of the resulting URL is a plain view, not a re-send prompt. */
interface DocumentNavState {
  readonly send?: boolean;
}

export function SalesScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<SalesList />} />
      <Route path="invoices/:documentId" element={<DocumentRoute kind="invoice" />} />
      <Route path="credit-notes/:documentId" element={<DocumentRoute kind="credit_note" />} />
      {/* A stray sales path is the list, not a 404 — there is nothing else here to be. */}
      <Route path="*" element={<Navigate to="/sales" replace />} />
    </Routes>
  );
}

/** The server-side narrowing on the list — shared by both tabs, unlike `search` and
 * `cardFilter`, which are client-side and invoice-only. */
interface DocumentFilters {
  readonly contactId: string | null;
  readonly status: DocumentStatus | null;
}

function SalesList(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<SalesDocumentKind>('invoice');
  const [filters, setFilters] = useState<DocumentFilters>({ contactId: null, status: null });
  /** Invoice tab only, and both client-side: which summary card is tapped, and a
   * free-text search over the invoice number or the customer's name. Neither is a filter
   * `/v1/invoices` offers, so both narrow the page already loaded rather than refetching. */
  const [search, setSearch] = useState('');
  const [cardFilter, setCardFilter] = useState<InvoiceCardFilter | null>(null);
  /** Compact-tier only: the filter controls collapse behind a button so the small screen
   * leads with the list, matching the purchases list (D-120/D-123). */
  const [showFilters, setShowFilters] = useState(false);

  const isCompact = useIsCompact();
  const reference = useSalesReferenceData();
  const summary = useInvoicesSummary();
  /** Today, for the overdue pills and the summary cards to draw the line on the same day. */
  const asOf = summary.data?.asOf ?? new Date().toISOString().slice(0, 10);

  const list = useDocumentList(kind, {
    ...(filters.contactId === null ? {} : { contactId: filters.contactId }),
    ...(filters.status === null ? {} : { status: filters.status }),
  });

  const words = vocabularyFor(kind);

  const create = useMutation({
    mutationFn: async (variables: {
      readonly contactId: string;
      readonly idempotencyKey: string;
    }) =>
      apiFor(kind).create(
        {
          contactId: variables.contactId,
          /**
           * Dated today, and pre-filled rather than asked for up front: the issue date
           * decides which fiscal period the journal lands in, and that is resolved at
           * approval rather than now (D-17, D-38), so a default costs nothing and saves
           * the commonest keystroke. A customer, a date and a tax mode are nevertheless
           * all required by the create request — unlike a journal draft, where every
           * field is nullable (D-19), those three decide what the document *is*, and
           * `taxMode` in particular cannot be filled in later without repricing every
           * line entered under the other reading.
           */
          issueDate: todayIsoDate(),
          taxMode: 'exclusive',
        },
        variables.idempotencyKey,
      ),
  });

  const customers = reference.data?.contacts.filter((contact) => contact.isCustomer) ?? [];

  async function handleNew(): Promise<void> {
    const contactId = customers[0]?.id;
    if (contactId === undefined) return;
    // A draft is created up front and then opened at its own URL: the number is still null
    // (none is allocated before approval, D-36), so the editor titles it "New invoice"
    // until it is approved. Seeding the query cache means the editor renders from the
    // create response rather than refetching what it was just handed.
    const created = await create.mutateAsync({ contactId, idempotencyKey: newIdempotencyKey() });
    queryClient.setQueryData(salesKeys.document(kind, created.id), created);
    void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
    void navigate(documentPath(kind, created.id));
  }

  /**
   * What the invoice tab actually shows. `cardFilter` narrows to the subset the tapped
   * summary card counts (`matchesCardFilter`); `search` is a case-insensitive substring
   * over the invoice number or the customer's name; and the default order is owed-first,
   * then by due date (`compareInvoicesForList`). The credit-note tab takes neither — it
   * shows the server's own order over its own filtered page.
   */
  const displayedDocuments = useMemo<readonly SalesDocumentSummary[]>(() => {
    if (kind !== 'invoice') return list.items;

    const term = search.trim().toLowerCase();
    const filtered = list.items.filter((item) => {
      if (cardFilter !== null && !matchesCardFilter(item, cardFilter, asOf)) return false;
      if (term === '') return true;
      const customerName = reference.data?.contactsById.get(item.contactId)?.displayName ?? '';
      return (
        (item.documentNumber ?? '').toLowerCase().includes(term) ||
        customerName.toLowerCase().includes(term)
      );
    });
    return [...filtered].sort(compareInvoicesForList);
  }, [kind, list.items, cardFilter, search, asOf, reference.data]);

  /** How many server filters are set — the badge on the compact "Filters" button. The
   * card filter and the search box are excluded from the count for the card's own reason
   * (its state shows on the highlighted card) and shown separately since the search box
   * itself is what carries its own state visibly. */
  const activeFilterCount =
    (filters.contactId !== null ? 1 : 0) +
    (filters.status !== null ? 1 : 0) +
    (kind === 'invoice' && search.trim() !== '' ? 1 : 0);

  const filterControls = (
    <div className="flex flex-col gap-3">
      {kind === 'invoice' && (
        <Field hint="Search by the invoice number or the customer’s name.">
          <div className="relative">
            <SearchIcon />
            <TextInput
              className="pl-9"
              aria-label="Invoice number or customer"
              placeholder="Search by invoice number or customer…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </div>
        </Field>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64 max-w-full">
          <FieldLabel>Customer</FieldLabel>
          <Select
            value={filters.contactId ?? 'all'}
            options={[
              { value: 'all', label: 'Any customer' },
              ...customers.map((customer) => ({
                value: customer.id,
                label: customer.displayName,
              })),
            ]}
            onValueChange={(value) => {
              setFilters((current) => ({
                ...current,
                contactId: value === 'all' ? null : value,
              }));
            }}
          />
        </Field>

        <Field className="w-40 max-w-full">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filters.status ?? 'all'}
            options={STATUS_FILTER_OPTIONS}
            onValueChange={(value) => {
              setFilters((current) => ({ ...current, status: asStatus(value) }));
            }}
          />
        </Field>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text">Sales Invoices</h1>
            <p className="text-text-muted">Manage and track your customer billing lifecycle.</p>
          </div>

          <div className="flex-1" />

          <Button
            variant="primary"
            disabled={create.isPending || customers.length === 0}
            onClick={() => {
              void handleNew();
            }}
          >
            New {words.singular.toLowerCase()}
          </Button>
        </div>

        {/* Two series, never one list with a sign column: an invoice and a credit note are
            different documents with different numbers (D-36, D-39). */}
        <div
          role="tablist"
          aria-label="Sales documents"
          className="flex gap-6 border-b border-border"
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === kind}
              onClick={() => {
                setKind(tab);
                setCardFilter(null);
              }}
              className={cx(
                '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
                tab === kind
                  ? 'border-text text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              )}
            >
              {vocabularyFor(tab).plural}
            </button>
          ))}
        </div>
      </div>

      {create.error !== null && <Refusal error={create.error} />}

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading contacts, accounts and tax rates…</p>
      ) : customers.length === 0 ? (
        <p className="text-text-muted">
          This organization has no customers yet. A {words.singular.toLowerCase()} is addressed to a
          contact marked as a customer — add one on the Contacts screen first.
        </p>
      ) : (
        <>
          {kind === 'invoice' && (
            <InvoicesSummaryCards
              summary={summary}
              activeFilter={cardFilter}
              onSelectFilter={(filter) => {
                setCardFilter((current) => (current === filter ? null : filter));
              }}
            />
          )}

          {/**
           * On a compact viewport the filter controls collapse behind a button so the small
           * screen leads with the list; on `md` and up they sit inline. The count badge is
           * the server filters that are set, so a collapsed panel still says whether
           * anything is narrowing the list.
           */}
          {isCompact ? (
            <div className="flex flex-col gap-3">
              <Button
                variant="secondary"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((open) => !open)}
              >
                <span className="inline-flex items-center gap-2">
                  <FilterIcon />
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </span>
              </Button>
              {showFilters && filterControls}
            </div>
          ) : (
            filterControls
          )}

          {list.error != null ? (
            <ErrorBanner error={list.error} onRetry={list.refetch} />
          ) : list.isPending ? (
            <p className="text-text-subtle">Loading {words.plural.toLowerCase()}…</p>
          ) : (
            <DocumentList
              documents={displayedDocuments}
              kind={kind}
              reference={reference.data}
              asOf={asOf}
              truncated={list.truncated}
              onOpen={(documentId) => void navigate(documentPath(kind, documentId))}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * One document, addressed by the URL. The `kind` is the route's (an invoice path renders an
 * invoice), and the id is `:documentId`. A draft renders the editor; anything else renders
 * the read-only view — the same status split the list used to make in local state, now made
 * off the fetched document so a cold URL lands on the right component.
 */
function DocumentRoute({ kind }: { readonly kind: SalesDocumentKind }): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { documentId } = useParams();
  const id = documentId ?? null;

  const reference = useSalesReferenceData();
  const opened = useDocument(kind, id);
  const words = vocabularyFor(kind);

  function toList(): void {
    void navigate('/sales');
  }

  if (reference.error != null) {
    return <ErrorBanner error={reference.error} onRetry={reference.refetch} />;
  }
  if (reference.data === null) {
    return <p className="text-text-subtle">Loading contacts, accounts and tax rates…</p>;
  }
  if (opened.error != null) {
    return <ErrorBanner error={opened.error} onRetry={opened.refetch} />;
  }
  if (opened.document === null) {
    return <p className="text-text-subtle">Loading the {words.singular.toLowerCase()}…</p>;
  }

  if (opened.document.status === 'draft') {
    return (
      <DocumentEditor
        /** Keyed by the document, so opening another one remounts the editor rather than
         * merging one document's rows into another's. */
        key={opened.document.id}
        document={opened.document}
        kind={kind}
        reference={reference.data}
        onBack={toList}
        onApproved={(approved, opts) => {
          // Approving posted the journal; the cache is already the approved document (the
          // editor set it), so navigating to the same URL re-renders it as the read-only
          // view. The `send` intent rides along so an invoice's "Approve & Send" opens the
          // Send dialog on arrival.
          void navigate(documentPath(kind, approved.id), {
            state: { send: opts?.openSend === true } satisfies DocumentNavState,
          });
        }}
        onDiscarded={toList}
      />
    );
  }

  const navState = (location.state ?? null) as DocumentNavState | null;
  return (
    <DocumentView
      key={opened.document.id}
      document={opened.document}
      kind={kind}
      reference={reference.data}
      onBack={toList}
      initialSend={navState?.send === true}
      onChanged={opened.refetch}
    />
  );
}

/** The magnifier inside the search field — `currentColor`, so it inherits the token below. */
function SearchIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden
      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-subtle"
    >
      <circle cx="9" cy="9" r="6" />
      <path d="m14 14 3.5 3.5" />
    </svg>
  );
}

/** A funnel for the compact "Filters" button — `currentColor`, inline with the label. */
function FilterIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-4 w-4"
    >
      <path d="M3 5h14M6 10h8M9 15h2" />
    </svg>
  );
}
