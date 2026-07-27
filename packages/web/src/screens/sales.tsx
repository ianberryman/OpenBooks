import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../api';
import { Button, ErrorBanner } from '../components';
import { cx } from '../lib/cx';
import { DocumentEditor } from './sales/document-editor';
import { DocumentList } from './sales/document-list';
import { todayIsoDate } from './sales/document-state';
import { DocumentView } from './sales/document-view';
import {
  apiFor,
  salesKeys,
  useDocument,
  useDocumentList,
  useSalesReferenceData,
} from './sales/queries';
import type { SalesDocument, SalesDocumentKind } from './sales/queries';
import { Refusal } from './sales/refusal';
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
 * ## Structure
 *
 * A tab per series, and within a tab either the list or one open document. The screen
 * holds its own selection rather than reading a route parameter: routing is another
 * ticket's file, and keeping the id in local state adds no second place — outside the
 * query cache — where fetched data could survive an org switch (`src/query/client.ts`).
 *
 * Which component an open document gets is decided by its computed status and by nothing
 * else. A draft gets the editor; anything else gets the read-only view, because after
 * approval an edit is refused with `document_not_draft` and a form that only ever fails is
 * worse than no form at all.
 */
type View = { readonly kind: 'list' } | { readonly kind: 'document'; readonly documentId: string };

const TABS: readonly SalesDocumentKind[] = ['invoice', 'credit_note'];

export function SalesScreen(): ReactElement {
  const queryClient = useQueryClient();

  const [kind, setKind] = useState<SalesDocumentKind>('invoice');
  const [view, setView] = useState<View>({ kind: 'list' });

  const reference = useSalesReferenceData();
  const list = useDocumentList(kind);
  const opened = useDocument(kind, view.kind === 'document' ? view.documentId : null);

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

  function show(document: SalesDocument): void {
    queryClient.setQueryData(salesKeys.document(kind, document.id), document);
    void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
    setView({ kind: 'document', documentId: document.id });
  }

  const customers = reference.data?.contacts.filter((contact) => contact.isCustomer) ?? [];

  async function handleNew(): Promise<void> {
    const contactId = customers[0]?.id;
    if (contactId === undefined) return;
    const created = await create.mutateAsync({ contactId, idempotencyKey: newIdempotencyKey() });
    show(created);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Sales</h1>
        <div className="flex-1" />
        {view.kind === 'document' && (
          <Button onClick={() => setView({ kind: 'list' })}>{words.plural}</Button>
        )}
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
      <div role="tablist" aria-label="Sales documents" className="flex gap-1">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === kind}
            onClick={() => {
              setKind(tab);
              setView({ kind: 'list' });
            }}
            className={cx(
              'rounded-md border px-3 py-1.5 text-sm font-medium',
              tab === kind
                ? 'border-border bg-surface-selected text-text'
                : 'border-transparent text-text-muted hover:bg-surface-hover',
            )}
          >
            {vocabularyFor(tab).plural}
          </button>
        ))}
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
      ) : view.kind === 'document' ? (
        opened.error != null ? (
          <ErrorBanner error={opened.error} onRetry={opened.refetch} />
        ) : opened.document === null ? (
          <p className="text-text-subtle">Loading…</p>
        ) : opened.document.status === 'draft' ? (
          <DocumentEditor
            /**
             * Keyed by the document, so opening another one remounts the editor rather
             * than merging one document's rows into another's. The editor owns its lines
             * after mount; without the key a background refetch of a *different* document
             * would land in the form the user is typing into.
             */
            key={opened.document.id}
            document={opened.document}
            kind={kind}
            reference={reference.data}
            onApproved={show}
            onDiscarded={() => setView({ kind: 'list' })}
          />
        ) : (
          <DocumentView
            key={opened.document.id}
            document={opened.document}
            kind={kind}
            reference={reference.data}
            onChanged={opened.refetch}
          />
        )
      ) : list.error != null ? (
        <ErrorBanner error={list.error} onRetry={list.refetch} />
      ) : list.isPending ? (
        <p className="text-text-subtle">Loading {words.plural.toLowerCase()}…</p>
      ) : (
        <DocumentList
          documents={list.items}
          kind={kind}
          reference={reference.data}
          onOpen={(documentId) => setView({ kind: 'document', documentId })}
        />
      )}
    </div>
  );
}
