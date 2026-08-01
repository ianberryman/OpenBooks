import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { SelectOption } from '../components';
import { useIsCompact } from '../lib/use-viewport';
import { EstimateDetailView } from './estimates/detail-view';
import { EstimateEditor } from './estimates/estimate-editor';
import { compareEstimatesForList, matchesCardFilter } from './estimates/estimate-presentation';
import type { EstimateCardFilter } from './estimates/estimate-presentation';
import { todayIsoDate } from './estimates/estimate-state';
import { EstimateList } from './estimates/list';
import {
  useCreateEstimate,
  useEstimate,
  useEstimateListItems,
  useEstimateReferenceData,
  useEstimatesSummary,
} from './estimates/queries';
import type { EstimateStatus, EstimateSummary } from './estimates/queries';
import { EstimatesSummaryCards } from './estimates/summary-cards';
import { PLURAL, SINGULAR } from './estimates/vocabulary';

/**
 * Estimates (initiative M, OB-172, OB-176; ROADMAP D-M3, D-M4, D-M6, D-M7) — the AR
 * mirror of a purchase order: a **non-posting pre-document** that carries lines and its
 * own gapless number but never a journal, moving `draft` → `approved` → `converted`.
 *
 * ## What this screen is careful not to compute
 *
 * `status`, `documentNumber` and `totals` are all read off the response, never derived —
 * `Estimate.status`'s own words ("stored, not computed") are why: there is no ledger here
 * for D-38's usual "derive status from the journals" trick to apply to. Approving allocates
 * a number and nothing else; converting builds a draft invoice from the header and lines and
 * hands back *that* invoice.
 *
 * ## The list and a document are two routes now, mirroring sales
 *
 * `/estimates` is the list; `/estimates/:id` is one open estimate — a draft renders the
 * editor, an approved or converted one the read-only detail. Routing rather than holding a
 * `view` in state makes an estimate a shareable, refresh-safe link and gives its breadcrumb
 * something real to return to. "Expired" is the estimates analog of an overdue invoice: an
 * approved estimate past its `expiryDate` that has not been converted (`estimate-presentation.ts`).
 */
const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'converted', label: 'Converted' },
];

const ESTIMATE_STATUSES: readonly EstimateStatus[] = ['draft', 'approved', 'converted'];

function asStatus(value: string): EstimateStatus | null {
  return ESTIMATE_STATUSES.find((status) => status === value) ?? null;
}

/** The URL an open estimate lives at, in one place so a link and the route table cannot
 * spell the same estimate two ways. */
function estimatePath(id: string): string {
  return `/estimates/${id}`;
}

/** The intent an approval carries to the detail view it lands on: "Approve & Send" opens the
 * Send dialog straight away, carried as navigation state so a refresh is a plain view. */
interface EstimateNavState {
  readonly send?: boolean;
}

export function EstimatesScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<EstimatesList />} />
      <Route path=":estimateId" element={<EstimateRoute />} />
      {/* A stray estimates path is the list, not a 404 — there is nothing else here to be. */}
      <Route path="*" element={<Navigate to="/estimates" replace />} />
    </Routes>
  );
}

interface EstimateFilters {
  readonly contactId: string | null;
  readonly status: EstimateStatus | null;
}

function EstimatesList(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<EstimateFilters>({ contactId: null, status: null });
  /** Both client-side: which summary card is tapped, and a free-text search over the number
   * or the customer's name — neither is a filter `/v1/estimates` offers. */
  const [search, setSearch] = useState('');
  const [cardFilter, setCardFilter] = useState<EstimateCardFilter | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const isCompact = useIsCompact();
  const reference = useEstimateReferenceData();
  const summary = useEstimatesSummary();
  /** Today, so the "Expired" pills and the summary cards draw the line on the same day. */
  const asOf = summary.data?.asOf ?? new Date().toISOString().slice(0, 10);

  const list = useEstimateListItems({
    ...(filters.contactId === null ? {} : { contactId: filters.contactId }),
    ...(filters.status === null ? {} : { status: filters.status }),
  });

  const create = useCreateEstimate();
  const customers = reference.data?.customers ?? [];

  async function handleNew(): Promise<void> {
    const contactId = customers[0]?.id;
    if (contactId === undefined) return;
    // A draft is created up front (its lines are optional — "New estimate produces an empty
    // one") and opened at its own URL; the number is null until approval (D-M6), so the
    // editor titles it "New estimate" until then. `GET /v1/estimates/:id` reads it back.
    const created = await create.mutateAsync({
      idempotencyKey: newIdempotencyKey(),
      contactId,
      issueDate: todayIsoDate(),
      taxMode: 'exclusive',
    });
    void queryClient.invalidateQueries({ queryKey: ['estimates'] });
    void navigate(estimatePath(created.id));
  }

  /** What the list actually shows: the tapped summary card narrows to its subset
   * (`matchesCardFilter`), the search box is a case-insensitive substring over the number or
   * the customer's name, and the default order is open-first then by expiry
   * (`compareEstimatesForList`). */
  const displayedEstimates = useMemo<readonly EstimateSummary[]>(() => {
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
    return [...filtered].sort(compareEstimatesForList);
  }, [list.items, cardFilter, search, asOf, reference.data]);

  const activeFilterCount =
    (filters.contactId !== null ? 1 : 0) +
    (filters.status !== null ? 1 : 0) +
    (search.trim() !== '' ? 1 : 0);

  const filterControls = (
    <div className="flex flex-col gap-3">
      <Field hint="Search by the estimate number or the customer’s name.">
        <div className="relative">
          <SearchIcon />
          <TextInput
            className="pl-9"
            aria-label="Estimate number or customer"
            placeholder="Search by number or customer…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      </Field>

      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64 max-w-full">
          <FieldLabel>Customer</FieldLabel>
          <Select
            value={filters.contactId ?? 'all'}
            options={[
              { value: 'all', label: 'Any customer' },
              ...customers.map((customer) => ({ value: customer.id, label: customer.displayName })),
            ]}
            onValueChange={(value) => {
              setFilters((current) => ({ ...current, contactId: value === 'all' ? null : value }));
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
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text">{PLURAL}</h1>
          <p className="text-text-muted">
            Quote your customers and convert the winners to invoices.
          </p>
        </div>

        <div className="flex-1" />

        <Button
          variant="primary"
          disabled={create.isPending || customers.length === 0}
          onClick={() => {
            void handleNew();
          }}
        >
          New {SINGULAR.toLowerCase()}
        </Button>
      </div>

      {create.error !== null && (
        <ErrorBanner error={create.error} onRetry={() => void handleNew()} />
      )}

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading customers and accounts…</p>
      ) : customers.length === 0 ? (
        <p className="text-text-muted">
          This organization has no customers yet. An estimate is addressed to a contact marked as a
          customer — add one on the Contacts screen first.
        </p>
      ) : (
        <>
          <EstimatesSummaryCards
            summary={summary}
            activeFilter={cardFilter}
            onSelectFilter={(filter) => {
              setCardFilter((current) => (current === filter ? null : filter));
            }}
          />

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
            <p className="text-text-subtle">Loading {PLURAL.toLowerCase()}…</p>
          ) : (
            <EstimateList
              estimates={displayedEstimates}
              reference={reference.data}
              asOf={asOf}
              truncated={list.truncated}
              onOpen={(estimateId) => void navigate(estimatePath(estimateId))}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * One estimate, addressed by the URL. A draft renders the editor; an approved or converted
 * one renders the read-only detail — the status split the old screen made with a dialog,
 * now made off the fetched estimate so a cold URL lands on the right component.
 */
function EstimateRoute(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { estimateId } = useParams();
  const id = estimateId ?? null;

  const reference = useEstimateReferenceData();
  const opened = useEstimate(id);

  function toList(): void {
    void navigate('/estimates');
  }

  if (reference.error != null) {
    return <ErrorBanner error={reference.error} onRetry={reference.refetch} />;
  }
  if (reference.data === null) {
    return <p className="text-text-subtle">Loading customers and accounts…</p>;
  }
  if (opened.error != null) {
    return <ErrorBanner error={opened.error} onRetry={() => void opened.refetch()} />;
  }
  if (opened.data === undefined) {
    return <p className="text-text-subtle">Loading the {SINGULAR.toLowerCase()}…</p>;
  }

  if (opened.data.status === 'draft') {
    return (
      <EstimateEditor
        key={opened.data.id}
        estimate={opened.data}
        reference={reference.data}
        onBack={toList}
        onApproved={(approved, opts) => {
          // Approving allocated the number; the list cache is invalidated by the mutation, so
          // navigating to the same URL re-renders it as the read-only detail. The `send` intent
          // rides along so "Approve & Send" opens the Send dialog on arrival.
          void navigate(estimatePath(approved.id), {
            state: { send: opts?.openSend === true } satisfies EstimateNavState,
          });
        }}
        onDiscarded={toList}
      />
    );
  }

  const navState = (location.state ?? null) as EstimateNavState | null;
  return (
    <EstimateDetailView
      key={opened.data.id}
      estimate={opened.data}
      reference={reference.data}
      onBack={toList}
      initialSend={navState?.send === true}
      onConverted={(invoice) => void navigate(`/sales/invoices/${invoice.id}`)}
      onChanged={() => void opened.refetch()}
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
