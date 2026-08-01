import type {
  BankFeedAccountRef,
  BankFeedProvider,
  BankFeedTransaction,
} from '@openbooks/plugin-api';

import type { BankFeedAdapterDeps } from './types';

/**
 * The real Stripe Financial Connections `BankFeedProvider` (OB-227, D-126).
 * Financial Connections is a *data* product — a transaction feed — and a
 * distinct Stripe surface from PAY's charge/payout use (D-126); the two must
 * never share a `processor_connections` row. Built against Stripe's documented
 * REST API using global `fetch` and the org's own restricted key (BYO, D-131),
 * no `stripe` npm SDK — the "narrowest surface" discipline the rest of
 * `providers/` keeps (`payment/stripe.ts` is form-encoded `fetch` too, no AWS
 * SDK in `secrets/local.ts`, no Anthropic SDK beside `extraction/`).
 *
 * D-102: this file is **not** exercised by the gate. `yarn test` runs
 * hermetically against real MySQL and no external network (spec §11), so the
 * gate's coverage of `BankFeedProvider` is `./fake.ts` — a third, real,
 * deterministic implementation, not a stub. This adapter is proven correct by
 * matching Stripe's published API shapes and is network-exercised only in a
 * manual sandbox run. Treat every field name and endpoint below as "believed
 * correct from the docs, confirm against the sandbox," not "proven."
 */
export function createStripeFinancialConnectionsBankFeed(
  deps: BankFeedAdapterDeps,
): BankFeedProvider {
  return {
    name: 'stripe_financial_connections',

    async listLinkedAccounts(): Promise<readonly BankFeedAccountRef[]> {
      // TODO(manual-sandbox): verify against live Stripe FC — the accounts list
      // endpoint and its `has_more`/`starting_after` pagination shape.
      const accounts: StripeFcAccount[] = [];
      let startingAfter: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter !== null) query.set('starting_after', startingAfter);

        const page = await stripeRequest<StripeFcAccountList>(
          deps,
          'GET',
          `/financial_connections/accounts?${query.toString()}`,
        );
        accounts.push(...page.data);
        const last = page.data.length > 0 ? page.data[page.data.length - 1] : undefined;
        startingAfter = page.has_more && last !== undefined ? last.id : null;
      } while (startingAfter !== null);

      return accounts.map(mapAccount);
    },

    async fetchTransactions({ cursor }): Promise<{
      readonly transactions: readonly BankFeedTransaction[];
      readonly cursor: string;
      readonly hasMore: boolean;
    }> {
      // Ask Stripe to pull the latest data for this account before reading it —
      // FC serves cached transactions otherwise, so a sync without a refresh
      // would silently lag the bank (D-128's "advanced only on a successful
      // sync" assumes the read saw fresh data).
      // TODO(manual-sandbox): verify against live Stripe FC — the refresh
      // endpoint path and the `features[]=transactions` param name.
      const refreshParams = new URLSearchParams();
      refreshParams.set('features[]', 'transactions');
      await stripeRequest<StripeFcAccount>(
        deps,
        'POST',
        `/financial_connections/accounts/${deps.externalAccountId}/refresh`,
        refreshParams,
      );

      // TODO(manual-sandbox): verify against live Stripe FC — the transactions
      // list endpoint, its `account` filter param, and `starting_after` cursor.
      const query = new URLSearchParams({ account: deps.externalAccountId, limit: '100' });
      if (cursor !== null) query.set('starting_after', cursor);

      const page = await stripeRequest<StripeFcTransactionList>(
        deps,
        'GET',
        `/financial_connections/transactions?${query.toString()}`,
      );

      const transactions = page.data.map(mapTransaction);

      // The cursor advances to the last **raw** transaction id even if a row
      // mapped to something the ingest later drops — otherwise the next poll
      // would re-fetch it forever (`payment/stripe.ts`'s reason, restated).
      const last = page.data.length > 0 ? page.data[page.data.length - 1] : undefined;
      return {
        transactions,
        cursor: last?.id ?? cursor ?? '0',
        hasMore: page.has_more,
      };
    },
  };
}

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** One FC account, the fields `mapAccount` reads off the list response. */
interface StripeFcAccount {
  readonly id: string;
  readonly display_name?: string | null;
  readonly institution_name?: string | null;
  readonly category?: string | null;
  readonly subcategory?: string | null;
  readonly last4?: string | null;
}

interface StripeFcAccountList {
  readonly data: readonly StripeFcAccount[];
  readonly has_more: boolean;
}

/**
 * One FC transaction, narrowed to the fields `mapTransaction` reads (D-07's
 * "narrowest surface" applied to a third-party response). `amount` is integer
 * minor units on Stripe's own wire (D-13); `transacted_at`/`transaction_refresh`
 * are unix seconds.
 */
interface StripeFcTransaction {
  readonly id: string;
  readonly amount: number;
  readonly description?: string | null;
  readonly transacted_at?: number | null;
  readonly transaction_refresh?: number | null;
  readonly status?: string | null;
}

interface StripeFcTransactionList {
  readonly data: readonly StripeFcTransaction[];
  readonly has_more: boolean;
}

interface StripeErrorPayload {
  readonly error: { readonly message: string };
}

function isStripeErrorPayload(value: unknown): value is StripeErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  );
}

function mapAccount(account: StripeFcAccount): BankFeedAccountRef {
  return {
    externalAccountId: account.id,
    institution: account.institution_name ?? null,
    displayName: account.display_name ?? `Account ${account.last4 ?? account.id}`,
    // Stripe FC reports `category` (`'cash'` for a bank account, `'credit'`
    // for a card); advisory in v1 since D-130 feeds asset accounts only.
    category: account.category ?? account.subcategory ?? null,
  };
}

function mapTransaction(txn: StripeFcTransaction): BankFeedTransaction {
  const postedUnix = txn.transacted_at ?? txn.transaction_refresh ?? 0;
  return {
    externalId: txn.id,
    postedDate: toIsoDate(postedUnix),
    // Stripe FC exposes no distinct settlement/value date on the transaction —
    // only `transacted_at` — so there is no honest second date to report.
    valueDate: null,
    // Sign inversion (D-13, asset frame): our contract is positive = money
    // *into* the account, but Stripe FC's `amount` is positive for an outflow
    // (a debit) and negative for an inflow, so the sign is flipped here.
    // TODO(manual-sandbox): verify Stripe FC's amount sign convention live
    // before trusting this negation.
    amountMinor: (-BigInt(txn.amount)).toString(),
    description: txn.description ?? '',
    // FC transactions carry no structured counterparty field, only a free-text
    // description; best-effort `null` rather than parsing the string.
    counterparty: null,
  };
}

/** Unix seconds → 'YYYY-MM-DD' (D-17), the UTC calendar day of the instant. */
function toIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * The one HTTP call every FC operation goes through: bearer auth with the org's
 * restricted key, and a form-encoded body for a POST (GET carries its query
 * string in `path` already). Mirrors `payment/stripe.ts`'s `stripeRequest`.
 */
async function stripeRequest<T>(
  deps: BankFeedAdapterDeps,
  method: 'GET' | 'POST',
  path: string,
  body?: URLSearchParams,
): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${deps.restrictedKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    ...(body === undefined ? {} : { body: body.toString() }),
  });

  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isStripeErrorPayload(payload)
      ? payload.error.message
      : `HTTP ${response.status}`;
    throw new Error(`stripe FC API error on ${method} ${path}: ${message}`);
  }
  return payload as T;
}
