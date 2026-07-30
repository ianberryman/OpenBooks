import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select } from '../components';
import { ApproveEstimateDialog } from './estimates/approve-dialog';
import { ConvertEstimateDialog } from './estimates/convert-dialog';
import { DiscardEstimateDialog } from './estimates/discard-dialog';
import { EstimateFormDialog } from './estimates/estimate-form';
import { EstimateList } from './estimates/list';
import { useEstimateList, useEstimateReferenceData } from './estimates/queries';
import type { EstimateStatus, EstimateSummary, Invoice } from './estimates/queries';
import { SendEstimateDialog } from './estimates/send-dialog';
import { Notice } from './settings/section';

/**
 * Estimates (initiative M, OB-172, OB-176; ROADMAP D-M3, D-M4, D-M6, D-M7) — the AR
 * mirror of a purchase order: a **non-posting pre-document** that carries lines and its
 * own gapless number but never a journal, moving `draft` → `approved` → `converted`.
 *
 * ## What this screen is careful not to compute
 *
 * `status`, `documentNumber` and `totals` are all read off the response, never derived —
 * `Estimate.status`'s own words ("stored, not computed") are why: there is no ledger here
 * for D-38's usual "derive status from the journals" trick to apply to. Approving
 * allocates a number and nothing else; converting builds a draft invoice from the header
 * and lines and hands back *that* invoice, which is why `useConvertEstimateToInvoice`
 * (`estimates/queries.ts`) is typed against `Invoice` rather than a second `Estimate`.
 *
 * ## One list, one dialog per action
 *
 * `estimates/list.tsx` is the register — `fixed-assets.tsx`'s shape, without a drill-in
 * detail view, because an estimate has nothing analogous to a depreciation schedule to
 * show once opened. Create and edit share one dialog (`estimate-form.tsx`); approve,
 * convert, send and discard each get their own small confirmation dialog rather than
 * folding into the form, because none of the four is "editing a field" — each is a
 * one-way or customer-facing act the row itself gates on `status` (`list.tsx`).
 */

type StatusFilter = EstimateStatus | 'all';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'converted', label: 'Converted' },
];

function toQueryStatus(filter: StatusFilter): EstimateStatus | null {
  return filter === 'all' ? null : filter;
}

export function EstimatesScreen(): ReactElement {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [approving, setApproving] = useState<EstimateSummary | null>(null);
  const [converting, setConverting] = useState<EstimateSummary | null>(null);
  const [sending, setSending] = useState<EstimateSummary | null>(null);
  const [discarding, setDiscarding] = useState<EstimateSummary | null>(null);
  const [convertedInvoice, setConvertedInvoice] = useState<Invoice | null>(null);

  const reference = useEstimateReferenceData();
  const list = useEstimateList(toQueryStatus(filter));

  const estimates = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Estimates</h1>
          <p className="max-w-form text-text-muted">
            Quotes for a customer — approved, sent, and converted to an invoice on acceptance.
            Nothing here posts a journal until it converts.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={reference.data === null}
          onClick={() => {
            setEditingId(null);
            setFormOpen(true);
          }}
        >
          New estimate
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-48">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={(value) => {
              if (
                value === 'draft' ||
                value === 'approved' ||
                value === 'converted' ||
                value === 'all'
              ) {
                setFilter(value);
              }
            }}
          />
        </Field>
      </div>

      {convertedInvoice !== null && (
        <Notice
          tone="success"
          title="Converted to a draft invoice"
          actions={
            <Button
              size="sm"
              onClick={() => {
                setConvertedInvoice(null);
              }}
            >
              Dismiss
            </Button>
          }
        >
          Invoice {convertedInvoice.documentNumber ?? convertedInvoice.id} was created from this
          estimate&rsquo;s lines. Find it on the Sales screen.
        </Notice>
      )}

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading contacts and accounts…</p>
      ) : (
        <>
          <EstimateList
            estimates={estimates}
            reference={reference.data}
            loading={list.isPending}
            emptyMessage={
              filter === 'all'
                ? 'No estimates yet. "New estimate" starts a draft — nothing is sent or ' +
                  'converted until you say so.'
                : 'No estimates match this filter.'
            }
            onEdit={(estimate) => {
              setEditingId(estimate.id);
              setFormOpen(true);
            }}
            onApprove={setApproving}
            onConvert={setConverting}
            onSend={setSending}
            onDiscard={setDiscarding}
          />

          {list.hasNextPage && (
            <div>
              <Button
                disabled={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}

          <EstimateFormDialog
            estimateId={editingId}
            reference={reference.data}
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open);
              if (!open) setEditingId(null);
            }}
          />

          <ApproveEstimateDialog
            estimate={approving}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setApproving(null);
            }}
          />

          <ConvertEstimateDialog
            estimate={converting}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setConverting(null);
            }}
            onConverted={(invoice) => {
              setConvertedInvoice(invoice);
            }}
          />

          <SendEstimateDialog
            estimate={sending}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setSending(null);
            }}
          />

          <DiscardEstimateDialog
            estimate={discarding}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setDiscarding(null);
            }}
          />
        </>
      )}
    </div>
  );
}
