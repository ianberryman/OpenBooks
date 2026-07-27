import type { ReactElement } from 'react';

import { cx } from '../../lib/cx';
import type { DocumentStatus, SalesDocumentKind, TaxMode } from './queries';

/**
 * What the two document series are called, and what their five computed states mean
 * (ROADMAP D-34, D-38, D-39).
 *
 * The words are here rather than inline because a credit note is a document and not a
 * negative invoice: it has its own number, its own list and its own journal, and a screen
 * that called it "invoice (negative)" anywhere would be describing the thing D-39
 * rejected. `settlement.outstanding` is the case where one arithmetic genuinely has two
 * readings — "still owed" on an invoice, "still available to apply" on a credit note —
 * and naming both is the whole reason this table exists.
 */
export interface KindVocabulary {
  readonly singular: string;
  readonly plural: string;
  /** What `settlement.outstanding` means on this document. */
  readonly outstandingLabel: string;
  readonly numberLabel: string;
  readonly referenceHint: string;
  readonly emptyList: string;
}

const VOCABULARY: Readonly<Record<SalesDocumentKind, KindVocabulary>> = {
  invoice: {
    singular: 'Invoice',
    plural: 'Invoices',
    outstandingLabel: 'Still owed',
    numberLabel: 'Invoice number',
    referenceHint: 'The customer’s own reference — their purchase-order number, in practice.',
    emptyList:
      'No invoices yet. A new invoice is a draft: nothing is posted and no number is ' +
      'allocated until it is approved.',
  },
  credit_note: {
    singular: 'Credit note',
    plural: 'Credit notes',
    outstandingLabel: 'Credit available',
    numberLabel: 'Credit note number',
    referenceHint: 'Free text — commonly the customer’s claim or return reference.',
    emptyList:
      'No credit notes yet. A credit note is a document in its own right, not an invoice ' +
      'with a minus sign — it has its own number and reduces an invoice by being applied to it.',
  },
};

export function vocabularyFor(kind: SalesDocumentKind): KindVocabulary {
  return VOCABULARY[kind];
}

/**
 * What each computed status means, in the words the lifecycle is explained in.
 *
 * All five are derived from two columns and a sum (D-38) — `journal_id IS NULL` is a
 * draft, `void_journal_id IS NOT NULL` is void, and the rest is what has been applied
 * against the total. Nothing in this screen writes one, and the API publishes no field
 * that could.
 */
export const STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  part_paid: 'Part paid',
  paid: 'Settled',
  void: 'Void',
};

const STATUS_CLASSES: Readonly<Record<DocumentStatus, string>> = {
  draft: 'border-border bg-surface-sunken text-text-muted',
  approved: 'border-accent-soft bg-accent-soft text-text',
  part_paid: 'border-warning-border bg-warning-soft text-warning-text',
  paid: 'border-success-border bg-success-soft text-success-text',
  void: 'border-danger-border bg-danger-soft text-danger-text',
};

export function StatusBadge({ status }: { readonly status: DocumentStatus }): ReactElement {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        STATUS_CLASSES[status],
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * The one sentence that says what can still be done, given where the document is.
 *
 * Approve is the irreversible step (D-38) and everything a user needs to know about this
 * screen follows from that: before it, edit and discard freely; after it, the ledger has
 * been told and the corrections are a credit note or a void. Saying so on the document —
 * rather than only in a disabled button's tooltip — is this screen's job, because the
 * server enforces it as a refusal and a refusal read after the fact is a worse teacher.
 */
export function lifecycleSummary(
  status: DocumentStatus,
  kind: SalesDocumentKind,
  outstandingLabel: string,
): string {
  switch (status) {
    case 'draft':
      return (
        'A draft. Nothing has reached the ledger and no number has been allocated, so it can ' +
        'be edited or discarded freely. Approving posts its journal and cannot be undone.'
      );
    case 'approved':
      return kind === 'invoice'
        ? 'Approved and posted to the ledger. It can no longer be edited — correct it with a ' +
            'credit note, or void it to reverse the journal.'
        : 'Approved and posted to the ledger. The credit is available but is not applied to ' +
            'anything yet — applying it to an invoice is a separate act.';
    case 'part_paid':
      return `Partly settled. ${outstandingLabel} is computed from the allocations against it, not stored.`;
    case 'paid':
      return kind === 'invoice'
        ? 'Fully settled by the allocations against it. Nothing is outstanding.'
        : 'Fully applied. None of this credit is left to apply.';
    case 'void':
      return (
        'Void. Its journal has been reversed by a second journal, and both remain visible — ' +
        'nothing here is ever deleted, because a document that vanished would make the ' +
        'gapless number series a lie.'
      );
  }
}

/**
 * What `taxMode` means, said in full wherever it can be changed.
 *
 * The flag decides what `unitAmount` *is* (D-35), so switching it does not convert the
 * prices already entered — it reprices the document by reading the same numbers the other
 * way. That is surprising enough to state at the control rather than to leave the user to
 * discover in the totals.
 */
export const TAX_MODE_LABELS: Readonly<Record<TaxMode, string>> = {
  exclusive: 'Prices exclude tax',
  inclusive: 'Prices include tax',
};

export const TAX_MODE_EXPLANATIONS: Readonly<Record<TaxMode, string>> = {
  exclusive: 'Each unit price is a net amount, and its tax is added on top.',
  inclusive: 'Each unit price already contains its tax, and the net is extracted from within.',
};
