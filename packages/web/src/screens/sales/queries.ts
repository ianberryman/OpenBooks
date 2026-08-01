import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, expectNoContent, idempotencyHeader, unwrap } from '../../api';
import type { components } from '../../api';

/**
 * Everything the sales screen reads and writes, and the keys it reads it under (OB-068).
 *
 * The keys are local and namespaced under `sales`, for `journal-entry/queries.ts`'
 * reason: a shared key module would make one screen's invalidation another screen's
 * problem, and the org switch already clears the cache wholesale
 * (`src/query/client.ts`), so nothing depends on two screens agreeing about a key.
 *
 * ## Why an adapter per document kind rather than a `kind` string threaded into one call
 *
 * A credit note is a document, not a negative invoice (D-39): its own list, its own
 * gapless series, its own routes. The screen is nevertheless one screen, because the two
 * documents are edited, approved and voided identically and duplicating the editor would
 * give the same lifecycle two implementations to drift between.
 *
 * The seam is here. `openapi-fetch` resolves its types from a **literal** path, so a
 * generic `` `/v1/${kind}` `` would type as `never` and take the whole surface's
 * type-safety with it. Each adapter below therefore spells its paths out, and everything
 * above this file takes a `SalesDocumentApi` and never names a URL.
 */

export type Invoice = components['schemas']['Invoice'];
export type CreditNote = components['schemas']['CreditNote'];
export type InvoiceSummary = components['schemas']['InvoiceSummary'];
export type CreditNoteSummary = components['schemas']['CreditNoteSummary'];
export type InvoicesSummary = components['schemas']['InvoicesSummary'];
export type DocumentLine = components['schemas']['DocumentLine'];
export type DocumentLineRequest = components['schemas']['DocumentLineRequestInput'];
export type DocumentStatus = components['schemas']['Invoice']['status'];
export type TaxMode = components['schemas']['Invoice']['taxMode'];
export type Allocation = components['schemas']['Allocation'];
export type DocumentSettlement = components['schemas']['DocumentSettlement'];
export type VoidDocumentRequest = components['schemas']['VoidDocumentRequestInput'];
export type CreateAllocationsRequest = components['schemas']['CreateAllocationsRequestInput'];
export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];
export type TaxRate = components['schemas']['TaxRate'];

/**
 * The two AR documents as one type.
 *
 * They differ in exactly one field — an invoice falls due and a credit note does not
 * (D-39) — so the union is discriminated by that field's presence rather than by a tag
 * this client would have to invent and keep true.
 */
export type SalesDocument = Invoice | CreditNote;
export type SalesDocumentSummary = InvoiceSummary | CreditNoteSummary;

export function dueDateOf(document: SalesDocument | SalesDocumentSummary): string | null {
  return 'dueDate' in document ? document.dueDate : null;
}

/** Which of the two series a view is looking at. Never sent anywhere — it picks an adapter. */
export type SalesDocumentKind = 'invoice' | 'credit_note';

export interface SalesDocumentPage {
  readonly items: readonly SalesDocumentSummary[];
  readonly nextCursor: string | null;
}

export interface CreateDocumentBody {
  readonly contactId: string;
  readonly issueDate: string;
  /** Invoices only; the credit-note adapter drops it, because nothing about one falls due. */
  readonly dueDate?: string;
  readonly taxMode: TaxMode;
  readonly reference?: string | null;
  readonly memo?: string | null;
  readonly lines?: readonly DocumentLineRequest[];
}

export interface UpdateDocumentBody {
  readonly contactId?: string;
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly taxMode?: TaxMode;
  readonly reference?: string | null;
  readonly memo?: string | null;
  readonly lines?: readonly DocumentLineRequest[];
}

export interface ListDocumentsQuery {
  readonly contactId?: string;
  readonly status?: DocumentStatus;
  readonly limit: number;
  readonly cursor?: string;
}

/**
 * The operations the lifecycle is made of, per document kind.
 *
 * **There is no `setStatus`, and there cannot be.** Status is derived from the journals
 * and the allocations on every read (D-38), so there is no column to write and the API
 * publishes no field for one. Approving is `POST …/approve` and voiding is `POST …/void`;
 * `update` is a draft edit that touches no ledger. A client that patched a status would
 * be writing a value the server computes.
 */
export interface SalesDocumentApi {
  readonly kind: SalesDocumentKind;
  list(query: ListDocumentsQuery): Promise<SalesDocumentPage>;
  get(documentId: string): Promise<SalesDocument>;
  create(body: CreateDocumentBody, idempotencyKey: string): Promise<SalesDocument>;
  update(
    documentId: string,
    patch: UpdateDocumentBody,
    idempotencyKey: string,
  ): Promise<SalesDocument>;
  discard(documentId: string, idempotencyKey: string): Promise<void>;
  approve(documentId: string, idempotencyKey: string): Promise<SalesDocument>;
  void(
    documentId: string,
    request: VoidDocumentRequest,
    idempotencyKey: string,
  ): Promise<SalesDocument>;
}

/**
 * Spread rather than assigned, because `exactOptionalPropertyTypes` makes an absent
 * property and an explicitly-`undefined` one different types — and because a
 * querystring serializer that received `status: undefined` would emit `status=`.
 */
function listParams(query: ListDocumentsQuery): {
  limit: number;
  contactId?: string;
  status?: DocumentStatus;
  cursor?: string;
} {
  return {
    limit: query.limit,
    ...(query.contactId === undefined ? {} : { contactId: query.contactId }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}

export const invoiceApi: SalesDocumentApi = {
  kind: 'invoice',

  async list(query) {
    return unwrap(await api.GET('/v1/invoices', { params: { query: listParams(query) } }));
  },

  async get(documentId) {
    return unwrap(
      await api.GET('/v1/invoices/{invoiceId}', { params: { path: { invoiceId: documentId } } }),
    );
  },

  async create(body, idempotencyKey) {
    return unwrap(
      await api.POST('/v1/invoices', {
        body: {
          contactId: body.contactId,
          issueDate: body.issueDate,
          taxMode: body.taxMode,
          ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(body.memo === undefined ? {} : { memo: body.memo }),
          ...(body.lines === undefined ? {} : { lines: [...body.lines] }),
        },
        params: { header: idempotencyHeader(idempotencyKey) },
      }),
    );
  },

  async update(documentId, patch, idempotencyKey) {
    return unwrap(
      await api.PATCH('/v1/invoices/{invoiceId}', {
        body: {
          ...(patch.contactId === undefined ? {} : { contactId: patch.contactId }),
          ...(patch.issueDate === undefined ? {} : { issueDate: patch.issueDate }),
          ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
          ...(patch.taxMode === undefined ? {} : { taxMode: patch.taxMode }),
          ...(patch.reference === undefined ? {} : { reference: patch.reference }),
          ...(patch.memo === undefined ? {} : { memo: patch.memo }),
          ...(patch.lines === undefined ? {} : { lines: [...patch.lines] }),
        },
        params: {
          path: { invoiceId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async discard(documentId, idempotencyKey) {
    expectNoContent(
      await api.DELETE('/v1/invoices/{invoiceId}', {
        params: {
          path: { invoiceId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async approve(documentId, idempotencyKey) {
    return unwrap(
      await api.POST('/v1/invoices/{invoiceId}/approve', {
        params: {
          path: { invoiceId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async void(documentId, request, idempotencyKey) {
    return unwrap(
      await api.POST('/v1/invoices/{invoiceId}/void', {
        body: request,
        params: {
          path: { invoiceId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },
};

export const creditNoteApi: SalesDocumentApi = {
  kind: 'credit_note',

  async list(query) {
    return unwrap(await api.GET('/v1/credit-notes', { params: { query: listParams(query) } }));
  },

  async get(documentId) {
    return unwrap(
      await api.GET('/v1/credit-notes/{creditNoteId}', {
        params: { path: { creditNoteId: documentId } },
      }),
    );
  },

  async create(body, idempotencyKey) {
    // `dueDate` is deliberately dropped rather than passed through: the credit-note
    // request is a `strictObject` that rejects the field, and D-39's reason is that
    // nothing about a credit note falls due and aging never ages one.
    return unwrap(
      await api.POST('/v1/credit-notes', {
        body: {
          contactId: body.contactId,
          issueDate: body.issueDate,
          taxMode: body.taxMode,
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(body.memo === undefined ? {} : { memo: body.memo }),
          ...(body.lines === undefined ? {} : { lines: [...body.lines] }),
        },
        params: { header: idempotencyHeader(idempotencyKey) },
      }),
    );
  },

  async update(documentId, patch, idempotencyKey) {
    return unwrap(
      await api.PATCH('/v1/credit-notes/{creditNoteId}', {
        body: {
          ...(patch.contactId === undefined ? {} : { contactId: patch.contactId }),
          ...(patch.issueDate === undefined ? {} : { issueDate: patch.issueDate }),
          ...(patch.taxMode === undefined ? {} : { taxMode: patch.taxMode }),
          ...(patch.reference === undefined ? {} : { reference: patch.reference }),
          ...(patch.memo === undefined ? {} : { memo: patch.memo }),
          ...(patch.lines === undefined ? {} : { lines: [...patch.lines] }),
        },
        params: {
          path: { creditNoteId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async discard(documentId, idempotencyKey) {
    expectNoContent(
      await api.DELETE('/v1/credit-notes/{creditNoteId}', {
        params: {
          path: { creditNoteId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async approve(documentId, idempotencyKey) {
    return unwrap(
      await api.POST('/v1/credit-notes/{creditNoteId}/approve', {
        params: {
          path: { creditNoteId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },

  async void(documentId, request, idempotencyKey) {
    return unwrap(
      await api.POST('/v1/credit-notes/{creditNoteId}/void', {
        body: request,
        params: {
          path: { creditNoteId: documentId },
          header: idempotencyHeader(idempotencyKey),
        },
      }),
    );
  },
};

export function apiFor(kind: SalesDocumentKind): SalesDocumentApi {
  return kind === 'invoice' ? invoiceApi : creditNoteApi;
}

/**
 * Applying a credit note to invoices — D-39's mechanism, and the only way a credit note
 * reduces what is owed.
 *
 * A batch, because "this credit settles two invoices" is one decision by one person and
 * has to succeed or fail as one (`CreateAllocationsRequest`).
 */
export async function allocateCreditNote(
  creditNoteId: string,
  request: CreateAllocationsRequest,
  idempotencyKey: string,
): Promise<void> {
  unwrap(
    await api.POST('/v1/credit-notes/{creditNoteId}/allocations', {
      body: request,
      params: {
        path: { creditNoteId },
        header: idempotencyHeader(idempotencyKey),
      },
    }),
  );
}

/**
 * Un-applying one allocation, which is the recovery the `document_has_allocations` refusal
 * names.
 *
 * A plain delete and not a reversal, and that is not an exception to D-16: an allocation
 * posted no journal, so removing it restates no financial statement. What it changes is
 * what is outstanding, and that is computed on read (D-34).
 */
export async function deleteAllocation(
  allocationId: string,
  idempotencyKey: string,
): Promise<void> {
  expectNoContent(
    await api.DELETE('/v1/allocations/{allocationId}', {
      params: {
        path: { allocationId },
        header: idempotencyHeader(idempotencyKey),
      },
    }),
  );
}

export const salesKeys = {
  contacts: ['sales', 'contacts'] as const,
  accounts: ['sales', 'accounts'] as const,
  taxRates: ['sales', 'tax-rates'] as const,
  list: (kind: SalesDocumentKind) => ['sales', 'list', kind] as const,
  document: (kind: SalesDocumentKind, documentId: string) =>
    ['sales', 'document', kind, documentId] as const,
  /** The customer's open invoices, read by the "apply this credit" picker. */
  openInvoices: (contactId: string) => ['sales', 'open-invoices', contactId] as const,
  invoicesSummary: ['sales', 'invoices-summary'] as const,
};

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `journal-entry/queries.ts`' bound, and for its reason: a picker that pages forever
 * hangs the tab, and listing part of a set as though it were all of it is worse. */
const MAX_PAGES = 50;

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

async function collect<T>(load: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }

  throw new Error(
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} rows behind one picker. Refusing to keep ` +
      `paging rather than list part of the set as though it were all of it.`,
  );
}

function pageQuery(cursor: string | undefined): { limit: number; cursor?: string } {
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

export interface SalesReferenceData {
  readonly contacts: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly taxRates: readonly TaxRate[];
  readonly contactsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly taxRatesById: ReadonlyMap<string, TaxRate>;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Contacts, accounts and sales tax rates, as one thing that is either loaded or not.
 *
 * All three arrive unfiltered by their active flag, for the reason the account picker
 * gives in `journal-entry/queries.ts`: a document written before a contact, an account or
 * a rate was archived still names it, and a picker that had never heard of it would show
 * an empty box where the user's own choice is. They are offered disabled instead.
 *
 * `appliesTo: 'sales'` is the one filter applied, and it is not cosmetic — it is a
 * usability predicate the server implements (`both` rates come back too). A purchases-only
 * rate on a customer invoice would post reclaimable input tax against a sale.
 */
export function useSalesReferenceData(): {
  readonly data: SalesReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const contacts = useQuery({
    queryKey: salesKeys.contacts,
    queryFn: async () =>
      collect<Contact>(async (cursor) =>
        unwrap(await api.GET('/v1/contacts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const accounts = useQuery({
    queryKey: salesKeys.accounts,
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
      ),
  });

  const taxRates = useQuery({
    queryKey: salesKeys.taxRates,
    queryFn: async () =>
      collect<TaxRate>(async (cursor) =>
        unwrap(
          await api.GET('/v1/tax-rates', {
            params: { query: { ...pageQuery(cursor), appliesTo: 'sales' } },
          }),
        ),
      ),
  });

  const data = useMemo<SalesReferenceData | null>(() => {
    if (contacts.data === undefined || accounts.data === undefined || taxRates.data === undefined) {
      return null;
    }
    return {
      contacts: contacts.data,
      accounts: accounts.data,
      taxRates: taxRates.data,
      contactsById: index(contacts.data),
      accountsById: index(accounts.data),
      taxRatesById: index(taxRates.data),
    };
  }, [contacts.data, accounts.data, taxRates.data]);

  return {
    data,
    error: contacts.error ?? accounts.error ?? taxRates.error,
    refetch: () => {
      void contacts.refetch();
      void accounts.refetch();
      void taxRates.refetch();
    },
  };
}

export interface InvoicesSummaryResult {
  readonly data: InvoicesSummary | null;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The invoices-list headline figures — total unpaid, total overdue, paid in the last 30
 * days.
 *
 * `asOf` is left off so the server answers as at today: this is the live snapshot the
 * cards show, not a reproducible report (the endpoint defaults the date for exactly that
 * reason). The figures are the server's — outstanding is total minus allocations, computed
 * on read (D-34) — so nothing here sums the invoice page, which is capped and would be
 * wrong past the first page anyway.
 */
export function useInvoicesSummary(): InvoicesSummaryResult {
  const query = useQuery({
    queryKey: salesKeys.invoicesSummary,
    queryFn: async () => unwrap(await api.GET('/v1/invoices/summary', { params: { query: {} } })),
  });

  return {
    data: query.data ?? null,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useDocumentList(
  kind: SalesDocumentKind,
  filters: { readonly contactId?: string; readonly status?: DocumentStatus } = {},
): {
  readonly items: readonly SalesDocumentSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly truncated: boolean;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: [...salesKeys.list(kind), filters.contactId ?? null, filters.status ?? null],
    queryFn: async () =>
      apiFor(kind).list({
        limit: PAGE_LIMIT,
        ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
      }),
  });

  return {
    items: query.data?.items ?? [],
    isPending: query.isPending,
    error: query.error,
    truncated: query.data?.nextCursor != null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useDocument(
  kind: SalesDocumentKind,
  documentId: string | null,
): {
  readonly document: SalesDocument | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: salesKeys.document(kind, documentId ?? ''),
    queryFn: async () => apiFor(kind).get(documentId ?? ''),
    enabled: documentId !== null,
  });

  return {
    document: query.data ?? null,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * The invoices a credit can be applied to: this customer's, still carrying something
 * outstanding.
 *
 * Two statuses rather than a client-side filter on `settlement.outstanding`, because the
 * server owns what "still owed" means (D-34) — `approved` is untouched and `part_paid` is
 * partly settled, and those are exactly the two the server will accept as targets. A
 * `paid` invoice has nothing left and a `draft` one is not in the ledger at all.
 */
export function useOpenInvoices(contactId: string | null): {
  readonly invoices: readonly InvoiceSummary[];
  readonly isPending: boolean;
  readonly error: unknown;
} {
  const query = useQuery({
    queryKey: salesKeys.openInvoices(contactId ?? ''),
    queryFn: async () => {
      const statuses: readonly DocumentStatus[] = ['approved', 'part_paid'];
      const pages = await Promise.all(
        statuses.map(async (status) =>
          invoiceApi.list({ limit: PAGE_LIMIT, contactId: contactId ?? '', status }),
        ),
      );
      return pages
        .flatMap((page) => page.items)
        .filter((item): item is InvoiceSummary => 'dueDate' in item);
    },
    enabled: contactId !== null,
  });

  return {
    invoices: query.data ?? [],
    isPending: contactId !== null && query.isPending,
    error: query.error,
  };
}
