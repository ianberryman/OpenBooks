import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';

/**
 * Everything the purchases screen reads, and the keys it reads it under (OB-069).
 *
 * The keys are local and namespaced under `purchases`, following `journal-entry/
 * queries.ts`: a shared key module would make one screen's invalidation another
 * screen's problem, and the org switch already clears the cache wholesale
 * (`src/query/client.ts`), so nothing depends on two screens agreeing about a key.
 */
export type Account = components['schemas']['Account'];
export type Contact = components['schemas']['Contact'];
export type TaxRate = components['schemas']['TaxRate'];

export type Bill = components['schemas']['Bill'];
export type BillSummary = components['schemas']['BillSummary'];
export type BillsSummary = components['schemas']['BillsSummary'];
export type VendorCredit = components['schemas']['VendorCredit'];
export type VendorCreditSummary = components['schemas']['VendorCreditSummary'];

export type Allocation = components['schemas']['Allocation'];
export type DocumentLine = components['schemas']['DocumentLine'];
export type DocumentLineRequest = components['schemas']['DocumentLineRequestInput'];
export type DocumentSettlement = components['schemas']['DocumentSettlement'];
export type DocumentTaxSummaryRow = components['schemas']['DocumentTaxSummaryRow'];
export type DocumentTotals = components['schemas']['DocumentTotals'];

export type DocumentStatus = Bill['status'];
export type TaxMode = Bill['taxMode'];

export const purchasesKeys = {
  vendors: ['purchases', 'vendors'] as const,
  accounts: ['purchases', 'accounts'] as const,
  taxRates: ['purchases', 'tax-rates'] as const,
  bills: (contactId: string | null, status: DocumentStatus | null, reference: string) =>
    ['purchases', 'bills', contactId ?? '', status ?? '', reference] as const,
  billsSummary: ['purchases', 'bills-summary'] as const,
  bill: (billId: string) => ['purchases', 'bill', billId] as const,
  vendorCredits: (contactId: string | null, status: DocumentStatus | null) =>
    ['purchases', 'vendor-credits', contactId ?? '', status ?? ''] as const,
  vendorCredit: (vendorCreditId: string) => ['purchases', 'vendor-credit', vendorCreditId] as const,
};

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `journal-entry/queries.ts`'s bound, for its reason: a paging loop needs an exit that
 * does not depend only on the server saying `nextCursor: null`. */
const MAX_PAGES = 50;

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
  // Spread rather than `cursor: undefined`: `exactOptionalPropertyTypes` makes an absent
  // property and an explicitly-undefined one different types.
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

/**
 * Vendors only, and archived ones included.
 *
 * `isVendor` is the server's filter and it is used rather than fetching the whole
 * directory: an AP document's `contactId` "must be a vendor — `contact_is_not_a_vendor`
 * otherwise" (`transport/routes/bills.ts`), so a picker offering customers would offer a
 * choice the service refuses. Inactive vendors arrive and are offered disabled, for
 * `fetchAccounts`' reason: a bill entered before a vendor was archived still names it.
 */
async function fetchVendors(): Promise<Contact[]> {
  return collect(async (cursor) =>
    unwrap(
      await api.GET('/v1/contacts', {
        params: { query: { ...pageQuery(cursor), isVendor: 'true' } },
      }),
    ),
  );
}

async function fetchAccounts(): Promise<Account[]> {
  return collect(async (cursor) =>
    unwrap(await api.GET('/v1/accounts', { params: { query: pageQuery(cursor) } })),
  );
}

/**
 * The rates a purchase document may cite.
 *
 * `appliesTo: 'purchases'` is a usability predicate on the server, not an equality — it
 * returns the unrestricted `both` rates as well — so this is the whole set a bill line may
 * name, and filtering further here would hide a rate the service accepts. D-35 gives a
 * line at most one rate and no default, which is why the picker's empty choice is a real
 * option rather than a placeholder.
 */
async function fetchPurchaseTaxRates(): Promise<TaxRate[]> {
  return collect(async (cursor) =>
    unwrap(
      await api.GET('/v1/tax-rates', {
        params: { query: { ...pageQuery(cursor), appliesTo: 'purchases' } },
      }),
    ),
  );
}

export interface ReferenceData {
  readonly vendors: readonly Contact[];
  readonly accounts: readonly Account[];
  readonly taxRates: readonly TaxRate[];
  readonly vendorsById: ReadonlyMap<string, Contact>;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly taxRatesById: ReadonlyMap<string, TaxRate>;
}

export interface ReferenceDataResult {
  /** `null` until all three have arrived — a half-loaded picker reads as missing data. */
  readonly data: ReferenceData | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

export function useReferenceData(): ReferenceDataResult {
  const vendors = useQuery({ queryKey: purchasesKeys.vendors, queryFn: fetchVendors });
  const accounts = useQuery({ queryKey: purchasesKeys.accounts, queryFn: fetchAccounts });
  const taxRates = useQuery({ queryKey: purchasesKeys.taxRates, queryFn: fetchPurchaseTaxRates });

  const data = useMemo<ReferenceData | null>(() => {
    if (vendors.data === undefined || accounts.data === undefined || taxRates.data === undefined) {
      return null;
    }
    return {
      vendors: vendors.data,
      accounts: accounts.data,
      taxRates: taxRates.data,
      vendorsById: index(vendors.data),
      accountsById: index(accounts.data),
      taxRatesById: index(taxRates.data),
    };
  }, [vendors.data, accounts.data, taxRates.data]);

  return {
    data,
    isPending: vendors.isPending || accounts.isPending || taxRates.isPending,
    error: vendors.error ?? accounts.error ?? taxRates.error,
    refetch: () => {
      void vendors.refetch();
      void accounts.refetch();
      void taxRates.refetch();
    },
  };
}

export interface BillFilters {
  readonly contactId: string | null;
  readonly status: DocumentStatus | null;
  /** The **vendor's** own invoice number (D-36) — see `useBills`. */
  readonly reference: string;
}

export interface ListResult<T> {
  readonly items: readonly T[];
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/** One page, and the screen says so when there is another — see `ListResult.truncated`. */
const LIST_LIMIT = 100;

/**
 * The bill list, filterable by the vendor's own invoice number.
 *
 * That filter exists on bills and on nothing else, and the asymmetry is D-36's point about
 * the field: "have we already entered this bill" is a question someone asks with the
 * vendor's number in their hand, several times a week. It is also the recovery this screen
 * offers when an approval is refused for a duplicate — the refusal names the colliding
 * bill's number, and this is how the user gets to it.
 */
export function useBills(filters: BillFilters): ListResult<BillSummary> {
  const reference = filters.reference.trim();

  const query = useQuery({
    queryKey: purchasesKeys.bills(filters.contactId, filters.status, reference),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/bills', {
          params: {
            query: {
              limit: LIST_LIMIT,
              ...(filters.contactId === null ? {} : { contactId: filters.contactId }),
              ...(filters.status === null ? {} : { status: filters.status }),
              ...(reference === '' ? {} : { reference }),
            },
          },
        }),
      ),
  });

  return {
    items: query.data?.items ?? [],
    truncated: query.data?.nextCursor != null,
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface BillsSummaryResult {
  readonly data: BillsSummary | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The bills-list headline figures — total owed, total overdue, paid in the last 30 days.
 *
 * `asOf` is left off so the server answers as at today: this is the live snapshot the
 * cards show, not a reproducible report (the endpoint defaults the date for exactly that
 * reason). The figures are the server's — outstanding is total minus allocations,
 * computed on read (D-34) — so nothing here sums the bill page, which is capped and would
 * be wrong past the first hundred rows anyway.
 */
export function useBillsSummary(): BillsSummaryResult {
  const query = useQuery({
    queryKey: purchasesKeys.billsSummary,
    queryFn: async () => unwrap(await api.GET('/v1/bills/summary', { params: { query: {} } })),
  });

  return {
    data: query.data ?? null,
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useVendorCredits(
  contactId: string | null,
  status: DocumentStatus | null,
): ListResult<VendorCreditSummary> {
  const query = useQuery({
    queryKey: purchasesKeys.vendorCredits(contactId, status),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/vendor-credits', {
          params: {
            query: {
              limit: LIST_LIMIT,
              ...(contactId === null ? {} : { contactId }),
              ...(status === null ? {} : { status }),
            },
          },
        }),
      ),
  });

  return {
    items: query.data?.items ?? [],
    truncated: query.data?.nextCursor != null,
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface DocumentResult<T> {
  readonly document: T | null;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

export function useBill(billId: string | null): DocumentResult<Bill> {
  const query = useQuery({
    queryKey: purchasesKeys.bill(billId ?? ''),
    queryFn: async () =>
      unwrap(await api.GET('/v1/bills/{billId}', { params: { path: { billId: billId ?? '' } } })),
    enabled: billId !== null,
  });

  return {
    document: query.data ?? null,
    isPending: billId !== null && query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useVendorCredit(vendorCreditId: string | null): DocumentResult<VendorCredit> {
  const query = useQuery({
    queryKey: purchasesKeys.vendorCredit(vendorCreditId ?? ''),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/vendor-credits/{vendorCreditId}', {
          params: { path: { vendorCreditId: vendorCreditId ?? '' } },
        }),
      ),
    enabled: vendorCreditId !== null,
  });

  return {
    document: query.data ?? null,
    isPending: vendorCreditId !== null && query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
