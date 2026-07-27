import { api, expectNoContent, idempotencyHeader, unwrap } from '../../api';
import type {
  Allocation,
  Bill,
  BillSummary,
  DocumentLine,
  DocumentLineRequest,
  DocumentSettlement,
  DocumentStatus,
  DocumentTaxSummaryRow,
  DocumentTotals,
  TaxMode,
  VendorCredit,
  VendorCreditSummary,
} from './queries';

/**
 * The two AP documents as one shape, and the four routes that write each of them
 * (OB-069; ROADMAP D-34, D-36, D-38, D-39).
 *
 * ## Why one shape rather than two editors
 *
 * A vendor credit is **a document, not a negative bill** (D-39) — its own sequence, its
 * own journal, its own lifecycle — and that is a statement about the ledger, not about
 * the form. On screen the two differ in exactly three places: a vendor credit has no
 * `dueDate` because nothing about it falls due, only a bill's `reference` carries the
 * duplicate-approval refusal, and only a vendor credit allocates. Everything else — the
 * lines, the tax mode, draft/approve/void — is one editor, so the two cannot drift into
 * two answers to "what does approving do".
 *
 * What is deliberately *not* unified is the wire call. Each function below names a
 * literal path, because `openapi-fetch` types a call from the path string: a helper that
 * took the path as a parameter would type the body as the union of every route's, and the
 * compiler would stop being able to tell a bill's request from a vendor credit's.
 *
 * ## Nothing here computes anything
 *
 * `status`, `settlement` and the three totals arrive computed (D-34, D-38) and are copied
 * across untouched. There is no place in this file — or in this screen — where a status is
 * derived from allocations or a total is derived from lines: the server owns both, and a
 * second implementation of either would disagree first at the rounding (D-35) and then in
 * front of a user who cannot tell which number is the real one.
 */
export type DocumentKind = 'bill' | 'vendor_credit';

export interface ApDocument {
  readonly id: string;
  /** Our own gapless number (D-36), or `null` while this is a draft. */
  readonly documentNumber: string | null;
  /** On a bill, the **vendor's** own invoice number (D-36). See `VENDOR_REFERENCE_LABEL`. */
  readonly reference: string | null;
  readonly contactId: string;
  readonly issueDate: string;
  /** `null` on a vendor credit: nothing about one falls due, and aging never ages one. */
  readonly dueDate: string | null;
  readonly taxMode: TaxMode;
  readonly status: DocumentStatus;
  readonly memo: string | null;
  readonly lines: readonly DocumentLine[];
  readonly totals: DocumentTotals;
  readonly taxSummary: readonly DocumentTaxSummaryRow[];
  readonly settlement: DocumentSettlement;
  readonly allocations: readonly Allocation[];
  readonly journalId: string | null;
  readonly voidJournalId: string | null;
}

export interface ApDocumentSummary {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly reference: string | null;
  readonly contactId: string;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly status: DocumentStatus;
  readonly totals: DocumentTotals;
  readonly settlement: DocumentSettlement;
}

export function billAsDocument(bill: Bill): ApDocument {
  return { ...bill, dueDate: bill.dueDate };
}

export function vendorCreditAsDocument(credit: VendorCredit): ApDocument {
  return { ...credit, dueDate: null };
}

export function billSummaryAsDocument(bill: BillSummary): ApDocumentSummary {
  return { ...bill, dueDate: bill.dueDate };
}

export function vendorCreditSummaryAsDocument(credit: VendorCreditSummary): ApDocumentSummary {
  return { ...credit, dueDate: null };
}

/**
 * What a save sends. `lines` replaces the whole set on both routes, so the editor holds
 * every line already and sends every line — per-line patching would need line identities
 * that survive an edit inserting a row in the middle.
 */
export interface DocumentInput {
  readonly contactId: string;
  readonly issueDate: string;
  /** Sent only on a bill; a vendor credit has no such field to send. */
  readonly dueDate: string | null;
  readonly taxMode: TaxMode;
  readonly reference: string | null;
  readonly memo: string | null;
  readonly lines: readonly DocumentLineRequest[];
}

export interface VoidInput {
  readonly date: string;
  readonly memo: string | null;
}

export interface DocumentApi {
  /** A fresh read, for after an allocation: settlement exists nowhere but a read (D-34). */
  readonly get: (id: string) => Promise<ApDocument>;
  readonly create: (input: DocumentInput, key: string) => Promise<ApDocument>;
  readonly update: (id: string, input: DocumentInput, key: string) => Promise<ApDocument>;
  readonly discard: (id: string, key: string) => Promise<void>;
  readonly approve: (id: string, key: string) => Promise<ApDocument>;
  readonly voidDocument: (id: string, input: VoidInput, key: string) => Promise<ApDocument>;
}

/** `lines` is a mutable `DocumentLineRequest[]` on the wire type; copy rather than hand
 * the serializer the array the editor is still holding. */
function lines(input: DocumentInput): DocumentLineRequest[] {
  return [...input.lines];
}

const billApi: DocumentApi = {
  get: async (billId) =>
    billAsDocument(unwrap(await api.GET('/v1/bills/{billId}', { params: { path: { billId } } }))),

  create: async (input, key) =>
    billAsDocument(
      unwrap(
        await api.POST('/v1/bills', {
          body: {
            contactId: input.contactId,
            issueDate: input.issueDate,
            ...(input.dueDate === null ? {} : { dueDate: input.dueDate }),
            taxMode: input.taxMode,
            reference: input.reference,
            memo: input.memo,
            lines: lines(input),
          },
          params: { header: idempotencyHeader(key) },
        }),
      ),
    ),

  update: async (billId, input, key) =>
    billAsDocument(
      unwrap(
        await api.PATCH('/v1/bills/{billId}', {
          body: {
            contactId: input.contactId,
            issueDate: input.issueDate,
            ...(input.dueDate === null ? {} : { dueDate: input.dueDate }),
            taxMode: input.taxMode,
            reference: input.reference,
            memo: input.memo,
            lines: lines(input),
          },
          params: { path: { billId }, header: idempotencyHeader(key) },
        }),
      ),
    ),

  discard: async (billId, key) => {
    expectNoContent(
      await api.DELETE('/v1/bills/{billId}', {
        params: { path: { billId }, header: idempotencyHeader(key) },
      }),
    );
  },

  /**
   * `POST …/approve`, and never a `PATCH` writing `status` (D-38). Status is derived from
   * the journal columns and the arithmetic; the API refuses a client writing it, and a
   * screen that tried would be asking for a field that does not exist to be set to a value
   * the server computes.
   */
  approve: async (billId, key) =>
    billAsDocument(
      unwrap(
        await api.POST('/v1/bills/{billId}/approve', {
          params: { path: { billId }, header: idempotencyHeader(key) },
        }),
      ),
    ),

  voidDocument: async (billId, input, key) =>
    billAsDocument(
      unwrap(
        await api.POST('/v1/bills/{billId}/void', {
          body: { date: input.date, memo: input.memo },
          params: { path: { billId }, header: idempotencyHeader(key) },
        }),
      ),
    ),
};

const vendorCreditApi: DocumentApi = {
  get: async (vendorCreditId) =>
    vendorCreditAsDocument(
      unwrap(
        await api.GET('/v1/vendor-credits/{vendorCreditId}', {
          params: { path: { vendorCreditId } },
        }),
      ),
    ),

  create: async (input, key) =>
    vendorCreditAsDocument(
      unwrap(
        await api.POST('/v1/vendor-credits', {
          body: {
            contactId: input.contactId,
            issueDate: input.issueDate,
            taxMode: input.taxMode,
            reference: input.reference,
            memo: input.memo,
            lines: lines(input),
          },
          params: { header: idempotencyHeader(key) },
        }),
      ),
    ),

  update: async (vendorCreditId, input, key) =>
    vendorCreditAsDocument(
      unwrap(
        await api.PATCH('/v1/vendor-credits/{vendorCreditId}', {
          body: {
            contactId: input.contactId,
            issueDate: input.issueDate,
            taxMode: input.taxMode,
            reference: input.reference,
            memo: input.memo,
            lines: lines(input),
          },
          params: { path: { vendorCreditId }, header: idempotencyHeader(key) },
        }),
      ),
    ),

  discard: async (vendorCreditId, key) => {
    expectNoContent(
      await api.DELETE('/v1/vendor-credits/{vendorCreditId}', {
        params: { path: { vendorCreditId }, header: idempotencyHeader(key) },
      }),
    );
  },

  approve: async (vendorCreditId, key) =>
    vendorCreditAsDocument(
      unwrap(
        await api.POST('/v1/vendor-credits/{vendorCreditId}/approve', {
          params: { path: { vendorCreditId }, header: idempotencyHeader(key) },
        }),
      ),
    ),

  voidDocument: async (vendorCreditId, input, key) =>
    vendorCreditAsDocument(
      unwrap(
        await api.POST('/v1/vendor-credits/{vendorCreditId}/void', {
          body: { date: input.date, memo: input.memo },
          params: { path: { vendorCreditId }, header: idempotencyHeader(key) },
        }),
      ),
    ),
};

export function documentApi(kind: DocumentKind): DocumentApi {
  return kind === 'bill' ? billApi : vendorCreditApi;
}

/**
 * Applying a vendor credit to bills — a **separate fact** from approving it (D-39).
 *
 * Approving makes the credit available; this is what reduces a particular bill. One call
 * for the whole batch rather than a call per bill, because "this credit settles three
 * bills" is one decision that has to succeed or fail as one.
 */
export async function allocateVendorCredit(
  vendorCreditId: string,
  allocations: readonly { readonly targetId: string; readonly amount: string }[],
  key: string,
): Promise<void> {
  unwrap(
    await api.POST('/v1/vendor-credits/{vendorCreditId}/allocations', {
      body: {
        allocations: allocations.map((allocation) => ({
          targetId: allocation.targetId,
          targetType: 'bill' as const,
          amount: allocation.amount,
        })),
      },
      params: { path: { vendorCreditId }, header: idempotencyHeader(key) },
    }),
  );
}

/**
 * The words this screen uses for each document, in one place.
 *
 * `referenceLabel` differs and it is the difference the ticket turns on: on a bill the
 * free-text reference holds the **vendor's** own invoice number (D-36) — we did not issue
 * it, and our `documentNumber` is only our internal handle. A user who types our number
 * into that box has recorded the wrong thing and nothing downstream will complain, which
 * is why the label names the owner of the number rather than saying "Reference".
 */
export interface DocumentVocabulary {
  readonly singular: string;
  readonly plural: string;
  readonly ourNumberLabel: string;
  readonly referenceLabel: string;
  readonly referenceHint: string;
  readonly outstandingLabel: string;
}

const VOCABULARY: Readonly<Record<DocumentKind, DocumentVocabulary>> = {
  bill: {
    singular: 'bill',
    plural: 'Bills',
    ourNumberLabel: 'Our bill number',
    referenceLabel: 'Vendor’s invoice number',
    referenceHint:
      'The number the vendor printed on their invoice — not ours. Our own bill number is ' +
      'assigned at approval and shown above. Approving two live bills from one vendor under ' +
      'one of their numbers is refused (D-36).',
    outstandingLabel: 'Still owed',
  },
  vendor_credit: {
    singular: 'vendor credit',
    plural: 'Vendor credits',
    ourNumberLabel: 'Our credit number',
    referenceLabel: 'Vendor’s credit note number',
    referenceHint:
      'The number the vendor printed on their credit note, where they issued one — not ours.',
    outstandingLabel: 'Credit still available',
  },
};

export function vocabularyFor(kind: DocumentKind): DocumentVocabulary {
  return VOCABULARY[kind];
}

export const STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  part_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};
