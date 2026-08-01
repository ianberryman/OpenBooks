import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { SelectOption } from '../components';
import { useIsCompact } from '../lib/use-viewport';
import { PurchaseOrderDetailView } from './purchase-orders/detail-view';
import { PurchaseOrderList } from './purchase-orders/list';
import { PurchaseOrderEditor } from './purchase-orders/order-editor';
import {
  comparePurchaseOrdersForList,
  matchesCardFilter,
} from './purchase-orders/order-presentation';
import type { PurchaseOrderCardFilter } from './purchase-orders/order-presentation';
import { todayIsoDate } from './purchase-orders/order-state';
import {
  useCreatePurchaseOrder,
  usePurchaseOrder,
  usePurchaseOrderListItems,
  usePurchaseOrderReferenceData,
  usePurchaseOrdersSummary,
} from './purchase-orders/queries';
import type { PurchaseOrderStatus, PurchaseOrderSummary } from './purchase-orders/queries';
import { PurchaseOrdersSummaryCards } from './purchase-orders/summary-cards';
import { PLURAL, SINGULAR } from './purchase-orders/vocabulary';

/**
 * Purchase orders (initiative M, OB-170…174; ROADMAP D-M3, D-M4, D-M6, D-M7) — a
 * **non-posting pre-document** that carries lines and its own gapless number but never a
 * journal, moving `draft` → `approved` → `converted`. The AP-side mirror of an estimate,
 * given the same list/detail/editor redesign the bills and estimates screens have.
 *
 * ## What this screen is careful not to compute
 *
 * `status`, `documentNumber` and `totals` are all read off the response, never derived —
 * `PurchaseOrder.status`'s own words ("stored, not computed") are why: there is no ledger
 * here for D-38's usual "derive status from the journals" trick to apply to. Approving
 * allocates a number and nothing else; converting builds a draft bill from the header and
 * lines and hands back *that* bill, which the Purchases screen then approves on its own.
 *
 * ## The list and a document are two routes now, mirroring bills and estimates
 *
 * `/purchase-orders` is the list; `/purchase-orders/:id` is one open order — a draft renders
 * the editor, an approved or converted one the read-only detail. Routing rather than holding
 * a `view` in state makes a purchase order a shareable, refresh-safe link and gives its
 * breadcrumb something real to return to.
 */
const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'converted', label: 'Converted' },
];

const PURCHASE_ORDER_STATUSES: readonly PurchaseOrderStatus[] = ['draft', 'approved', 'converted'];

function asStatus(value: string): PurchaseOrderStatus | null {
  return PURCHASE_ORDER_STATUSES.find((status) => status === value) ?? null;
}

/** The URL an open purchase order lives at, in one place so a link and the route table cannot
 * spell the same order two ways. */
function purchaseOrderPath(id: string): string {
  return `/purchase-orders/${id}`;
}

/** The intent an approval carries to the detail view it lands on: "Approve & Send" opens the
 * Send dialog straight away, carried as navigation state so a refresh is a plain view. */
interface PurchaseOrderNavState {
  readonly send?: boolean;
}

export function PurchaseOrdersScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<PurchaseOrdersList />} />
      <Route path=":purchaseOrderId" element={<PurchaseOrderRoute />} />
      {/* A stray purchase-orders path is the list, not a 404 — there is nothing else here to be. */}
      <Route path="*" element={<Navigate to="/purchase-orders" replace />} />
    </Routes>
  );
}

interface PurchaseOrderFilters {
  readonly contactId: string | null;
  readonly status: PurchaseOrderStatus | null;
}

function PurchaseOrdersList(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<PurchaseOrderFilters>({ contactId: null, status: null });
  /** Both client-side: which summary card is tapped, and a free-text search over the number
   * or the vendor's name — neither is a filter `/v1/purchase-orders` offers beyond `status`. */
  const [search, setSearch] = useState('');
  const [cardFilter, setCardFilter] = useState<PurchaseOrderCardFilter | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const isCompact = useIsCompact();
  const reference = usePurchaseOrderReferenceData();
  const summary = usePurchaseOrdersSummary();

  const list = usePurchaseOrderListItems({
    ...(filters.contactId === null ? {} : { contactId: filters.contactId }),
    ...(filters.status === null ? {} : { status: filters.status }),
  });

  const create = useCreatePurchaseOrder();
  const vendors = reference.data?.vendors ?? [];

  async function handleNew(): Promise<void> {
    const contactId = vendors[0]?.id;
    if (contactId === undefined) return;
    // A draft is created up front (its lines are optional — "New purchase order produces an
    // empty one") and opened at its own URL; the number is null until approval (D-M6), so the
    // editor titles it "New purchase order" until then. `GET /v1/purchase-orders/:id` reads it back.
    const created = await create.mutateAsync({
      idempotencyKey: newIdempotencyKey(),
      contactId,
      issueDate: todayIsoDate(),
      taxMode: 'exclusive',
    });
    void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
    void navigate(purchaseOrderPath(created.id));
  }

  /** What the list actually shows: the tapped summary card narrows to its subset
   * (`matchesCardFilter`), the search box is a case-insensitive substring over the number or
   * the vendor's name, and the default order is open-first then by expected date
   * (`comparePurchaseOrdersForList`). */
  const displayedOrders = useMemo<readonly PurchaseOrderSummary[]>(() => {
    const term = search.trim().toLowerCase();
    const filtered = list.items.filter((item) => {
      if (cardFilter !== null && !matchesCardFilter(item, cardFilter)) return false;
      if (term === '') return true;
      const vendorName = reference.data?.vendorsById.get(item.contactId)?.displayName ?? '';
      return (
        (item.documentNumber ?? '').toLowerCase().includes(term) ||
        vendorName.toLowerCase().includes(term)
      );
    });
    return [...filtered].sort(comparePurchaseOrdersForList);
  }, [list.items, cardFilter, search, reference.data]);

  const activeFilterCount =
    (filters.contactId !== null ? 1 : 0) +
    (filters.status !== null ? 1 : 0) +
    (search.trim() !== '' ? 1 : 0);

  const filterControls = (
    <div className="flex flex-col gap-3">
      <Field hint="Search by the purchase-order number or the vendor’s name.">
        <div className="relative">
          <SearchIcon />
          <TextInput
            className="pl-9"
            aria-label="Purchase-order number or vendor"
            placeholder="Search by number or vendor…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      </Field>

      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64 max-w-full">
          <FieldLabel>Vendor</FieldLabel>
          <Select
            value={filters.contactId ?? 'all'}
            options={[
              { value: 'all', label: 'Any vendor' },
              ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.displayName })),
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
            Raise orders to your vendors and convert the approved ones to bills.
          </p>
        </div>

        <div className="flex-1" />

        <Button
          variant="primary"
          disabled={create.isPending || vendors.length === 0}
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
        <p className="text-text-subtle">Loading vendors and accounts…</p>
      ) : vendors.length === 0 ? (
        <p className="text-text-muted">
          This organization has no vendors yet. A purchase order is addressed to a contact marked as
          a vendor — add one on the Contacts screen first.
        </p>
      ) : (
        <>
          <PurchaseOrdersSummaryCards
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
            <PurchaseOrderList
              orders={displayedOrders}
              reference={reference.data}
              truncated={list.truncated}
              onOpen={(purchaseOrderId) => void navigate(purchaseOrderPath(purchaseOrderId))}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * One purchase order, addressed by the URL. A draft renders the editor; an approved or
 * converted one renders the read-only detail — the status split the old screen made with a
 * dialog, now made off the fetched order so a cold URL lands on the right component.
 */
function PurchaseOrderRoute(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { purchaseOrderId } = useParams();
  const id = purchaseOrderId ?? null;

  const reference = usePurchaseOrderReferenceData();
  const opened = usePurchaseOrder(id);

  function toList(): void {
    void navigate('/purchase-orders');
  }

  if (reference.error != null) {
    return <ErrorBanner error={reference.error} onRetry={reference.refetch} />;
  }
  if (reference.data === null) {
    return <p className="text-text-subtle">Loading vendors and accounts…</p>;
  }
  if (opened.error != null) {
    return <ErrorBanner error={opened.error} onRetry={() => void opened.refetch()} />;
  }
  if (opened.data === undefined) {
    return <p className="text-text-subtle">Loading the {SINGULAR.toLowerCase()}…</p>;
  }

  if (opened.data.status === 'draft') {
    return (
      <PurchaseOrderEditor
        key={opened.data.id}
        order={opened.data}
        reference={reference.data}
        onBack={toList}
        onApproved={(approved, opts) => {
          // Approving allocated the number; the list cache is invalidated by the mutation, so
          // navigating to the same URL re-renders it as the read-only detail. The `send` intent
          // rides along so "Approve & Send" opens the Send dialog on arrival.
          void navigate(purchaseOrderPath(approved.id), {
            state: { send: opts?.openSend === true } satisfies PurchaseOrderNavState,
          });
        }}
        onDiscarded={toList}
      />
    );
  }

  const navState = (location.state ?? null) as PurchaseOrderNavState | null;
  return (
    <PurchaseOrderDetailView
      key={opened.data.id}
      order={opened.data}
      reference={reference.data}
      onBack={toList}
      initialSend={navState?.send === true}
      onConverted={(bill) => void navigate(`/purchases/bills/${bill.id}`)}
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
