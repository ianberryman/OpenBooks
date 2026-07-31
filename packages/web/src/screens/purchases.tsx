import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { SelectOption } from '../components';
import { cx } from '../lib/cx';
import { useIsCompact } from '../lib/use-viewport';
import {
  billAsDocument,
  billSummaryAsDocument,
  compareBillsForList,
  matchesCardFilter,
  vendorCreditAsDocument,
  vendorCreditSummaryAsDocument,
  vocabularyFor,
} from './purchases/ap-document';
import type {
  ApDocument,
  ApDocumentSummary,
  BillCardFilter,
  DocumentKind,
} from './purchases/ap-document';
import { DocumentEditor } from './purchases/document-editor';
import { DocumentList } from './purchases/document-list';
import {
  useBill,
  useBills,
  useBillsSummary,
  useReferenceData,
  useVendorCredit,
  useVendorCredits,
} from './purchases/queries';
import { BillsSummaryCards } from './purchases/summary-cards';
import type { BillFilters, DocumentStatus } from './purchases/queries';

/**
 * OB-069 — purchases: bills and vendor credits.
 *
 * Two documents on one screen because they are the two halves of one question ("what do we
 * owe this vendor, and what do they owe back"), and two tabs rather than one merged list
 * because they are separate series to the people who read them: each has its own gapless
 * per-org sequence (D-36), and a vendor credit is a document in its own right rather than
 * a negative bill (D-39).
 *
 * ## The list and a document are two routes now, not one piece of state
 *
 * `/purchases` is the list; `/purchases/bills/:id` (and `…/new`, and the vendor-credit
 * mirror) is one document. Routing them rather than holding a `view` in state is what makes
 * a bill a link someone can send, a page the browser's Back button returns from, and a URL
 * that survives a refresh — the deep-link the journal-entry screen's comment deferred. The
 * document's *kind* is the path, so an approved vendor credit opened cold from its URL knows
 * it is a credit without the list having chosen a tab.
 *
 * ## What this screen is careful about
 *
 * **Whose number is whose.** A bill carries two: ours, allocated at approval, and the
 * vendor's, typed in by hand. The list gives them separate, owner-named columns and the
 * editor's field is labelled `Vendor's invoice number` — because a user who types our
 * number into that box has recorded the wrong thing and nothing downstream will complain
 * (D-36).
 *
 * **Nothing here is computed that the server computes.** Status, what is outstanding, and
 * every tax figure arrive derived (D-34, D-35, D-38). This screen displays them.
 */
type NavSeed = {
  readonly kind?: DocumentKind;
  readonly contactId?: string;
  readonly reference?: string;
};

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

/** The URL a document lives at. `null` id is the create page. Kept in one place so a link
 * and the route table cannot spell the same document two ways. */
function documentPath(kind: DocumentKind, id: string | null): string {
  const segment = kind === 'bill' ? 'bills' : 'vendor-credits';
  return `/purchases/${segment}/${id ?? 'new'}`;
}

export function PurchasesScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<PurchasesList />} />
      <Route path="bills/new" element={<DocumentRoute kind="bill" />} />
      <Route path="bills/:documentId" element={<DocumentRoute kind="bill" />} />
      <Route path="vendor-credits/new" element={<DocumentRoute kind="vendor_credit" />} />
      <Route path="vendor-credits/:documentId" element={<DocumentRoute kind="vendor_credit" />} />
      {/* A stray purchases path is the list, not a 404 — there is nothing else here to be. */}
      <Route path="*" element={<Navigate to="/purchases" replace />} />
    </Routes>
  );
}

function PurchasesList(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  // The duplicate-refusal recovery arrives as navigation state (see `DocumentRoute`): it
  // names the bill's vendor and number so this list can open filtered to the collision.
  const seed = (location.state ?? null) as NavSeed | null;

  const [kind, setKind] = useState<DocumentKind>(seed?.kind ?? 'bill');
  const [filters, setFilters] = useState<BillFilters>({
    contactId: seed?.contactId ?? null,
    status: null,
    reference: seed?.reference ?? '',
  });
  /** The summary card tapped, if any — a client-side narrowing on top of the server
   * filters (`matchesCardFilter`). Bills only; the vendor-credit tab shows no cards. */
  const [cardFilter, setCardFilter] = useState<BillCardFilter | null>(null);
  /** Compact-tier only: the filter controls collapse behind a button, so the small screen
   * leads with the list rather than the form. */
  const [showFilters, setShowFilters] = useState(false);

  const isCompact = useIsCompact();
  const reference = useReferenceData();
  const summary = useBillsSummary();
  /** Today, for the overdue pill — the summary's own as-at date, so the pill and the
   * "total overdue" card draw the line on the same day. */
  const asOf = summary.data?.asOf ?? new Date().toISOString().slice(0, 10);

  const bills = useBills(filters);
  const vendorCredits = useVendorCredits(filters.contactId, filters.status);

  const list = kind === 'bill' ? bills : vendorCredits;
  const vocabulary = vocabularyFor(kind);

  const summaries = useMemo<readonly ApDocumentSummary[]>(
    () =>
      kind === 'bill'
        ? bills.items.map(billSummaryAsDocument)
        : vendorCredits.items.map(vendorCreditSummaryAsDocument),
    [kind, bills.items, vendorCredits.items],
  );

  /**
   * What the list actually shows: bills default to owed-first-then-due order
   * (`compareBillsForList`) and, when a summary card is active, narrow to the subset it
   * counts. Vendor credits keep the server's order and take no card filter.
   */
  const displayedSummaries = useMemo<readonly ApDocumentSummary[]>(() => {
    if (kind !== 'bill') return summaries;
    const filtered =
      cardFilter === null
        ? summaries
        : summaries.filter((item) => matchesCardFilter(item, cardFilter, asOf));
    return [...filtered].sort(compareBillsForList);
  }, [kind, summaries, cardFilter, asOf]);

  /** How many server filters are set — the badge on the compact "Filters" button, so a
   * collapsed panel still says whether the list is narrowed. The card filter is excluded:
   * its state shows on the highlighted card itself. */
  const activeFilterCount =
    (filters.contactId !== null ? 1 : 0) +
    (filters.status !== null ? 1 : 0) +
    (filters.reference.trim() !== '' ? 1 : 0);

  const filterControls = (
    <div className="flex flex-col gap-3">
      {kind === 'bill' && (
        /**
         * The filter that exists on bills and on nothing else, presented full-width as the
         * primary search. "Have we already entered this bill" is a question someone asks with
         * the vendor's number in their hand; nobody looks an invoice up by the customer's
         * purchase-order number (D-36). It stays the server-side `reference` filter — and so
         * the duplicate-recovery hook — rather than a broad text search the API does not offer.
         */
        <Field hint="Search by the number the vendor printed, not by ours.">
          <div className="relative">
            <SearchIcon />
            <TextInput
              className="pl-9"
              aria-label="Vendor’s invoice number"
              placeholder="Search by the vendor’s invoice number…"
              value={filters.reference}
              onChange={(event) => {
                setFilters((current) => ({ ...current, reference: event.target.value }));
              }}
            />
          </div>
        </Field>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64 max-w-full">
          <FieldLabel>Vendor</FieldLabel>
          <Select
            value={filters.contactId ?? 'all'}
            options={[
              { value: 'all', label: 'Any vendor' },
              ...(reference.data?.vendors ?? []).map((vendor) => ({
                value: vendor.id,
                label: vendor.displayName,
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
          <h1 className="text-2xl font-semibold text-text">Purchases</h1>

          <div className="flex-1" />

          <Button variant="primary" onClick={() => void navigate(documentPath(kind, null))}>
            New {vocabulary.singular}
          </Button>
        </div>

        {/**
         * Underlined tabs, but plain buttons with `aria-pressed` rather than the ARIA
         * `tablist`/`tab` pattern: that pattern also owes a `tabpanel` and arrow-key roving
         * focus, and half of it is worse than none. This is the original `role="group"`
         * toggle restyled, so its accessible shape is unchanged.
         */}
        <div className="flex gap-6 border-b border-border" role="group" aria-label="Document type">
          {(['bill', 'vendor_credit'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
                setCardFilter(null);
              }}
              className={cx(
                '-mb-px border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
                kind === option
                  ? 'border-text text-text'
                  : 'border-transparent text-text-muted hover:text-text',
              )}
            >
              {vocabularyFor(option).plural}
            </button>
          ))}
        </div>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading vendors, accounts and tax rates…</p>
      ) : (
        <>
          {kind === 'bill' && (
            <BillsSummaryCards
              summary={summary}
              activeFilter={cardFilter}
              onSelectFilter={(filter) =>
                setCardFilter((current) => (current === filter ? null : filter))
              }
            />
          )}

          {/**
           * On a compact viewport the filter controls collapse behind a button so the small
           * screen leads with the list; on `md` and up they sit inline. The count badge is the
           * server filters that are set, so a collapsed panel still says whether anything is
           * narrowing the list.
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
            <p className="text-text-subtle">Loading {vocabulary.plural.toLowerCase()}…</p>
          ) : (
            <DocumentList
              kind={kind}
              items={displayedSummaries}
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
 * One document, addressed by the URL. The `kind` is the route's (a bill path renders a bill
 * editor); the id is `:documentId`, or absent on the `…/new` path — a create.
 */
function DocumentRoute({ kind }: { readonly kind: DocumentKind }): ReactElement {
  const navigate = useNavigate();
  const { documentId } = useParams();
  const id = documentId ?? null;

  const reference = useReferenceData();
  const bill = useBill(kind === 'bill' ? id : null);
  const credit = useVendorCredit(kind === 'vendor_credit' ? id : null);

  /**
   * The bills a vendor credit could be applied to. Fetched for the credit's own vendor,
   * because a credit may only be applied to that vendor's bills, and unfiltered by status
   * because the dialog reads the server's `status` and `settlement` to decide which can
   * take one (D-34).
   */
  const vendorBills = useBills({
    contactId: credit.document?.contactId ?? null,
    status: null,
    reference: '',
  });

  const vocabulary = vocabularyFor(kind);
  const source = kind === 'bill' ? bill : credit;
  const openDocument: ApDocument | null =
    kind === 'bill'
      ? bill.document === null
        ? null
        : billAsDocument(bill.document)
      : credit.document === null
        ? null
        : vendorCreditAsDocument(credit.document);

  /** A stored document is editable only once it has arrived; a new one has nothing to wait for. */
  const documentReady = id === null || openDocument !== null;

  function toList(): void {
    void navigate('/purchases');
  }

  if (reference.data === null) {
    return (
      <>
        {reference.error != null && (
          <ErrorBanner error={reference.error} onRetry={reference.refetch} />
        )}
        {reference.error == null && (
          <p className="text-text-subtle">Loading vendors, accounts and tax rates…</p>
        )}
      </>
    );
  }

  if (source.error != null) {
    return <ErrorBanner error={source.error} onRetry={source.refetch} />;
  }

  if (!documentReady) {
    return <p className="text-text-subtle">Loading the {vocabulary.singular}…</p>;
  }

  return (
    <DocumentEditor
      /**
       * Keyed by the document so a different one remounts the editor rather than merging one
       * document's lines into another's. On create the key moves `new → :id` once, right after
       * the first save when nothing is unsaved, so the remount reloads the just-saved document
       * cleanly rather than losing edits.
       */
      key={`${kind}:${id ?? 'new'}`}
      kind={kind}
      document={openDocument}
      reference={reference.data}
      vendorBills={kind === 'vendor_credit' ? vendorBills.items : []}
      onCreated={(newId) => void navigate(documentPath(kind, newId), { replace: true })}
      onDiscarded={toList}
      onBack={toList}
      onFindDuplicate={(contactId, vendorReference) => {
        // The recovery the duplicate refusal offers, and the reason `GET /v1/bills` takes a
        // `reference` filter at all (D-36): the refusal names the colliding bill, and this
        // opens the list filtered to it — a bill is always a bill, so the seed fixes the tab.
        void navigate('/purchases', {
          state: { kind: 'bill', contactId, reference: vendorReference } satisfies NavSeed,
        });
      }}
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
