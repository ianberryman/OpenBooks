import { ApiError, api, idempotencyHeader, unwrap } from '../../api';
import type { components } from '../../api';

/**
 * Everything OB-048 calls, and the query keys it calls it under.
 *
 * The keys are declared here rather than in a shared module on purpose: six M2 screens
 * were built in parallel, and a single `query-keys.ts` is the one file all six would have
 * edited. Nothing outside this folder reads them, and the only cross-screen concern —
 * "someone else created an account" — is served by the root key below, which any screen
 * may invalidate without knowing this screen's filters.
 */

export type Account = components['schemas']['Account'];
export type AccountPage = components['schemas']['AccountPage'];
export type AccountType = Account['type'];
export type NormalBalance = Account['normalBalance'];
export type CashBasisRole = NonNullable<Account['cashBasisRole']>;
export type CreateAccountBody = components['schemas']['CreateAccountRequestInput'];
export type UpdateAccountBody = components['schemas']['UpdateAccountRequestInput'];
export type ChartTemplateSummary = components['schemas']['ChartTemplateSummary'];
export type ChartTemplateId = ChartTemplateSummary['id'];

/**
 * A filter set, with `null` meaning "no filter" rather than an absent key.
 *
 * `null` and not `undefined` because this object is part of a query key, and
 * `JSON.stringify` — which is how TanStack hashes a key — drops an `undefined` member
 * while keeping a `null` one. Two filter sets that differ only in which one they used
 * would otherwise share a cache entry.
 */
export interface AccountFilters {
  readonly type: AccountType | null;
  readonly isActive: boolean | null;
}

const ROOT = 'accounts';

export const accountsQueryKeys = {
  /** Everything this screen caches. What a write invalidates. */
  everything: [ROOT] as const,
  list: (filters: AccountFilters) => [ROOT, 'list', filters.type, filters.isActive] as const,
  chartTemplates: [ROOT, 'chart-templates'] as const,
};

/**
 * One page of the chart, and the number is a compromise rather than a maximum.
 *
 * The hierarchy on this screen is only as complete as the pages that have been fetched —
 * a child whose parent is on a later page has to render somewhere, and the honest place
 * is the top level with a note (see `buildAccountTree`). A larger page makes that rarer.
 * It is not `PAGE_SIZE_MAX`, which is 200 and lives in `@openbooks/shared-types` where
 * this package cannot reach it: asking for exactly the server's ceiling means a later
 * ticket lowering it turns this screen's every request into a `validation_failed`. A
 * hundred sits above the shipped starter chart, so the common org pages once.
 */
const PAGE_LIMIT = 100;

export async function fetchAccountsPage(
  filters: AccountFilters,
  cursor: string | undefined,
): Promise<AccountPage> {
  return unwrap(
    await api.GET('/v1/accounts', {
      params: {
        query: {
          limit: PAGE_LIMIT,
          ...(filters.type === null ? {} : { type: filters.type }),
          // The route coerces this one with `z.stringbool()`; the generated parameter is
          // therefore a string, and `String(false)` is `'false'` rather than omitted.
          ...(filters.isActive === null ? {} : { isActive: String(filters.isActive) }),
          // Verbatim, never parsed or rebuilt (D-21): the cursor's contents are the
          // server's ordering columns and are free to change under us.
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
    }),
  );
}

export async function fetchChartTemplates(): Promise<readonly ChartTemplateSummary[]> {
  return unwrap(await api.GET('/v1/chart-templates')).templates;
}

export async function createAccount(
  body: CreateAccountBody,
  idempotencyKey: string,
): Promise<Account> {
  return unwrap(
    await api.POST('/v1/accounts', {
      body,
      params: { header: idempotencyHeader(idempotencyKey) },
    }),
  );
}

export async function updateAccount(
  accountId: string,
  body: UpdateAccountBody,
  idempotencyKey: string,
): Promise<Account> {
  return unwrap(
    await api.PATCH('/v1/accounts/{accountId}', {
      body,
      params: { path: { accountId }, header: idempotencyHeader(idempotencyKey) },
    }),
  );
}

/**
 * Deactivation and reactivation are two routes, not a flag, and this helper keeps them
 * two calls rather than collapsing them into a boolean at the transport edge — the two
 * mean different things to a reader of the books and the screen says so in two places.
 */
export async function setAccountActive(
  accountId: string,
  isActive: boolean,
  idempotencyKey: string,
): Promise<Account> {
  const path = isActive
    ? ('/v1/accounts/{accountId}/reactivate' as const)
    : ('/v1/accounts/{accountId}/deactivate' as const);

  return unwrap(
    await api.POST(path, {
      params: { path: { accountId }, header: idempotencyHeader(idempotencyKey) },
    }),
  );
}

/**
 * `unwrap` is deliberately unusable here: it refuses a 2xx with no body, and this route
 * answers 204. Its own header says the sibling helper for the no-content routes lands
 * with the first screen that calls one — this is that screen, and this ticket may not
 * edit `src/api/`, so the four lines live here until a second caller justifies moving
 * them.
 */
export async function deleteAccount(accountId: string, idempotencyKey: string): Promise<void> {
  const result = await api.DELETE('/v1/accounts/{accountId}', {
    params: { path: { accountId }, header: idempotencyHeader(idempotencyKey) },
  });

  if (!result.response.ok || result.error !== undefined) {
    throw ApiError.from(result.response, result.error);
  }
}

export async function applyChartTemplate(
  templateId: ChartTemplateId,
  idempotencyKey: string,
): Promise<readonly Account[]> {
  const applied = unwrap(
    await api.POST('/v1/chart-templates/apply', {
      body: { templateId },
      params: { header: idempotencyHeader(idempotencyKey) },
    }),
  );

  return applied.accounts;
}
