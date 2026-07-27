import type { PermissionKey } from '../permissions';

/**
 * What distinguishes an invoice from a credit note (D-39).
 *
 * A credit note is a document, not a negative invoice: its own gapless series, its
 * own journal, and it reduces what a customer owes by *allocating* against invoices
 * through the mechanism payments use. Everything else about the two is the same —
 * the same table, the same draft lifecycle, the same pricing, the same approval
 * transaction — so the difference is carried as data rather than as two copies of a
 * service.
 *
 * The four fields are exactly the four differences, and it is worth reading them as
 * the statement of D-39 they are:
 *
 *  - `documentType` selects the series (D-36 counts each type separately) and is
 *    part of the resource's identity, so an invoice id handed to `getCreditNote` is
 *    a miss.
 *  - `controlSide` is the *only* sign in this module. Every amount stored is
 *    non-negative and the direction lives here: an invoice debits the receivables
 *    control account, a credit note credits it. That is what makes a credit note the
 *    exact mirror of the invoice it credits rather than an invoice with minus signs
 *    on its lines.
 *  - `allocationColumn` is which end of `ar_allocations` this document is. An
 *    invoice is the target of its allocations; a credit note is the source of its
 *    own. One mechanism, read from two directions.
 *  - the permissions differ because the catalog says so (spec §5).
 *
 * ## Why voiding a credit note takes `credit_notes.write`
 *
 * The catalog holds `invoices.void` and `bills.void` and no counterpart for the two
 * credit documents. That is not an oversight to route around: `invoices.void` is the
 * power to reverse a document that *carries an amount owed*, and requiring it to
 * void a credit note would mean a role granted credit notes and nothing else could
 * not correct one — while a role granted invoices could reverse a document it has no
 * permission to read. Both are worse than treating the void of a credit note as the
 * strongest thing `credit_notes.write` can do, which is what it already is.
 *
 * Adding `credit_notes.void` is three coordinated edits (the seed in `0001_tenancy`,
 * the union in `modules/permissions/catalog.ts`, and the set-equality test) plus a
 * decision about the six system roles, and it belongs with OB-072's enforcement
 * matrix rather than inside this ticket.
 */
export interface ArDocumentKind {
  readonly documentType: 'credit_note' | 'invoice';
  /** The A7 resource token. Validated by `NotFoundError`, so it holds no detail. */
  readonly resource: string;
  /** What the journal's memo calls it when the document carries none of its own. */
  readonly label: string;
  readonly controlSide: 'credit' | 'debit';
  readonly allocationColumn: 'credit_note_id' | 'invoice_id';
  readonly readPermission: PermissionKey;
  readonly writePermission: PermissionKey;
  readonly voidPermission: PermissionKey;
}

export const INVOICE_KIND: ArDocumentKind = {
  documentType: 'invoice',
  resource: 'invoice',
  label: 'Invoice',
  controlSide: 'debit',
  allocationColumn: 'invoice_id',
  readPermission: 'invoices.read',
  writePermission: 'invoices.write',
  voidPermission: 'invoices.void',
};

export const CREDIT_NOTE_KIND: ArDocumentKind = {
  documentType: 'credit_note',
  resource: 'credit_note',
  label: 'Credit note',
  controlSide: 'credit',
  allocationColumn: 'credit_note_id',
  readPermission: 'credit_notes.read',
  writePermission: 'credit_notes.write',
  voidPermission: 'credit_notes.write',
};
