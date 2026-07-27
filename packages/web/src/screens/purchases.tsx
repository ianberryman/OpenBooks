import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select, TextInput } from '../components';
import type { SelectOption } from '../components';
import {
  billAsDocument,
  billSummaryAsDocument,
  vendorCreditAsDocument,
  vendorCreditSummaryAsDocument,
  vocabularyFor,
} from './purchases/ap-document';
import type { ApDocument, ApDocumentSummary, DocumentKind } from './purchases/ap-document';
import { DocumentEditor } from './purchases/document-editor';
import { DocumentList } from './purchases/document-list';
import {
  useBill,
  useBills,
  useReferenceData,
  useVendorCredit,
  useVendorCredits,
} from './purchases/queries';
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
 * ## What this screen is careful about
 *
 * **Whose number is whose.** A bill carries two: ours, allocated at approval, and the
 * vendor's, typed in by hand. The list gives them separate, owner-named columns and the
 * editor's field is labelled `Vendor's invoice number` — because a user who types our
 * number into that box has recorded the wrong thing and nothing downstream will complain
 * (D-36). The vendor's number is also the one filter on this screen that answers a
 * question people ask several times a week: *have we already entered this?*
 *
 * **Nothing here is computed that the server computes.** Status, what is outstanding, and
 * every tax figure arrive derived (D-34, D-35, D-38). This screen displays them.
 *
 * The screen holds its own selection rather than reading a route parameter, following the
 * journal-entry screen: routing is another ticket's file, and local state adds no second
 * place — outside the query cache — where fetched rows could survive an org switch.
 */
type View =
  /** `documentId: null` is a document being entered that has never been saved. */
  { readonly kind: 'document'; readonly documentId: string | null } | { readonly kind: 'list' };

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

export function PurchasesScreen(): ReactElement {
  const [kind, setKind] = useState<DocumentKind>('bill');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filters, setFilters] = useState<BillFilters>({
    contactId: null,
    status: null,
    reference: '',
  });

  const reference = useReferenceData();

  const bills = useBills(filters);
  const vendorCredits = useVendorCredits(filters.contactId, filters.status);

  const billId = kind === 'bill' && view.kind === 'document' ? view.documentId : null;
  const creditId = kind === 'vendor_credit' && view.kind === 'document' ? view.documentId : null;
  const bill = useBill(billId);
  const credit = useVendorCredit(creditId);

  /**
   * The bills a vendor credit could be applied to. Fetched for the credit's own vendor,
   * because a credit may only be applied to that vendor's bills, and unfiltered by status
   * because the dialog reads the server's `status` and `settlement` to decide which of them
   * can take one (D-34).
   */
  const vendorBills = useBills({
    contactId: credit.document?.contactId ?? null,
    status: null,
    reference: '',
  });

  const list = kind === 'bill' ? bills : vendorCredits;
  const vocabulary = vocabularyFor(kind);

  const summaries = useMemo<readonly ApDocumentSummary[]>(
    () =>
      kind === 'bill'
        ? bills.items.map(billSummaryAsDocument)
        : vendorCredits.items.map(vendorCreditSummaryAsDocument),
    [kind, bills.items, vendorCredits.items],
  );

  const openDocument: ApDocument | null =
    kind === 'bill'
      ? bill.document === null
        ? null
        : billAsDocument(bill.document)
      : credit.document === null
        ? null
        : vendorCreditAsDocument(credit.document);

  const documentError = kind === 'bill' ? bill.error : credit.error;
  const editing = view.kind === 'document';
  /** A stored document is editable only once it has arrived; a new one has nothing to wait for. */
  const documentReady =
    view.kind === 'document' && (view.documentId === null || openDocument !== null);

  function showList(): void {
    setView({ kind: 'list' });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Purchases</h1>

        <div className="flex gap-1" role="group" aria-label="Document type">
          {(['bill', 'vendor_credit'] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={kind === option ? 'primary' : 'ghost'}
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
                showList();
              }}
            >
              {vocabularyFor(option).plural}
            </Button>
          ))}
        </div>

        <div className="flex-1" />

        {editing && <Button onClick={showList}>Back to {vocabulary.plural.toLowerCase()}</Button>}

        <Button variant="primary" onClick={() => setView({ kind: 'document', documentId: null })}>
          New {vocabulary.singular}
        </Button>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading vendors, accounts and tax rates…</p>
      ) : editing ? (
        documentError != null ? (
          <ErrorBanner
            error={documentError}
            onRetry={kind === 'bill' ? bill.refetch : credit.refetch}
          />
        ) : !documentReady ? (
          <p className="text-text-subtle">Loading the {vocabulary.singular}…</p>
        ) : (
          <DocumentEditor
            /**
             * Keyed by the document, so switching documents remounts the editor rather than
             * merging one document's lines into another's. The editor owns its lines after
             * mount; without the key a background refetch of a different document would land
             * in the form being typed into.
             */
            key={`${kind}:${view.kind === 'document' ? (view.documentId ?? 'new') : 'new'}`}
            kind={kind}
            document={openDocument}
            reference={reference.data}
            vendorBills={kind === 'vendor_credit' ? vendorBills.items : []}
            onCreated={(documentId) => setView({ kind: 'document', documentId })}
            onDiscarded={showList}
            onFindDuplicate={(contactId, vendorReference) => {
              // The recovery the duplicate refusal offers, and the reason `GET /v1/bills`
              // takes a `reference` filter at all (D-36): the refusal names the colliding
              // bill's number, and this is the route to the bill itself.
              setKind('bill');
              setFilters({ contactId, status: null, reference: vendorReference });
              showList();
            }}
          />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-64">
              <FieldLabel>Vendor</FieldLabel>
              <Select
                value={filters.contactId ?? 'all'}
                options={[
                  { value: 'all', label: 'Any vendor' },
                  ...reference.data.vendors.map((vendor) => ({
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

            <Field className="w-40">
              <FieldLabel>Status</FieldLabel>
              <Select
                value={filters.status ?? 'all'}
                options={STATUS_FILTER_OPTIONS}
                onValueChange={(value) => {
                  setFilters((current) => ({ ...current, status: asStatus(value) }));
                }}
              />
            </Field>

            {kind === 'bill' && (
              /**
               * The filter that exists on bills and on nothing else. "Have we already
               * entered this bill" is a question someone asks with the vendor's number in
               * their hand; nobody looks an invoice up by the customer's purchase-order
               * number (D-36).
               */
              <Field className="w-64" hint="Search by the number the vendor printed, not by ours.">
                <FieldLabel>Vendor’s invoice number</FieldLabel>
                <TextInput
                  value={filters.reference}
                  onChange={(event) => {
                    setFilters((current) => ({ ...current, reference: event.target.value }));
                  }}
                />
              </Field>
            )}
          </div>

          {list.error != null ? (
            <ErrorBanner error={list.error} onRetry={list.refetch} />
          ) : list.isPending ? (
            <p className="text-text-subtle">Loading {vocabulary.plural.toLowerCase()}…</p>
          ) : (
            <DocumentList
              kind={kind}
              items={summaries}
              reference={reference.data}
              truncated={list.truncated}
              onOpen={(documentId) => setView({ kind: 'document', documentId })}
            />
          )}
        </>
      )}
    </div>
  );
}
