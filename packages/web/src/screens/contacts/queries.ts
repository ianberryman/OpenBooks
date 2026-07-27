import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { ApiError, api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-049 asks of `/v1/contacts`: one paged list and the five writes.
 *
 * Types come from `components['schemas'][…]` and are never restated by hand — the
 * rule `src/api/index.ts` states, and the reason the screen cannot describe a field the
 * server does not serve.
 */
export type Contact = components['schemas']['Contact'];
export type ContactPage = components['schemas']['ContactPage'];
export type CreateContactRequest = components['schemas']['CreateContactRequestInput'];
export type UpdateContactRequest = components['schemas']['UpdateContactRequestInput'];

/**
 * `null` is "no filter", not "false".
 *
 * A tri-state per flag rather than a pair of booleans, because `isCustomer=false` is a
 * real and different request from omitting it — the server filters on non-customers —
 * and collapsing the two would make "everyone" unreachable. The three are independent
 * for the reason `listContactsQuerySchema` gives: a contact that is both a customer and
 * a vendor must appear under either filter, which a single `role` enum could not express.
 */
export interface ContactFilters {
  readonly isCustomer: boolean | null;
  readonly isVendor: boolean | null;
  readonly isActive: boolean | null;
}

export const NO_CONTACT_FILTERS: ContactFilters = {
  isCustomer: null,
  isVendor: null,
  isActive: null,
};

/**
 * Query keys, local to this screen by ticket instruction — there is no shared key module.
 *
 * `CONTACTS_SCOPE` is the prefix every write invalidates, so a create made under one set
 * of filters refreshes the list read under another. Nothing in the key names the org: the
 * org is ambient and the switcher clears the cache wholesale instead (`src/query/client.ts`
 * explains why that is a security control rather than a freshness one).
 */
const CONTACTS_SCOPE = ['contacts'] as const;

export function contactListQueryKey(filters: ContactFilters): readonly unknown[] {
  return [...CONTACTS_SCOPE, 'list', filters];
}

/**
 * The querystring takes strings: the route coerces (`z.stringbool()`), because a shared
 * schema that accepted `'false'` would accept it from a JSON body too.
 */
function toWireFilters(filters: ContactFilters): Record<string, string> {
  const wire: Record<string, string> = {};
  if (filters.isCustomer !== null) wire['isCustomer'] = String(filters.isCustomer);
  if (filters.isVendor !== null) wire['isVendor'] = String(filters.isVendor);
  if (filters.isActive !== null) wire['isActive'] = String(filters.isActive);
  return wire;
}

/**
 * The list, keyset-paged over `(created_at, id)` (D-21).
 *
 * `getNextPageParam` returns `nextCursor` **verbatim and nothing else**. Presence is the
 * only signal that more exists — a full page does not imply another — so deriving the
 * answer from `items.length` would ask for a page that does not exist, and inventing a
 * cursor from a row's `createdAt` would page over a column this client does not own the
 * encoding of. TanStack stops when this returns `null`, which is exactly the contract the
 * server states.
 */
export function useContactList(
  filters: ContactFilters,
): UseInfiniteQueryResult<InfiniteData<ContactPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: contactListQueryKey(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/contacts', {
          params: {
            query: {
              ...toWireFilters(filters),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One idempotency key per user intent, and an intent is identified by what it would write.
 *
 * Both neighbouring mistakes are real, which is why this is a hook and not a call to
 * `newIdempotencyKey()` at the submit handler. Minting per *attempt* turns a retry after a
 * dropped response into a second contact — the failure the header exists to prevent
 * (`src/api/idempotency.ts`). Minting once per *dialog* is the opposite failure: the user
 * fixes the field the server rejected and resubmits, the body no longer matches the key,
 * and the form dies on `idempotency_key_conflict` with nothing the user can do about it.
 *
 * So the key is held against a fingerprint of the request. Identical content resubmitted
 * carries the key the first attempt carried; changed content gets a new one.
 */
export function useIntentKey(): (intent: string) => string {
  const held = useRef<{ intent: string; key: string } | null>(null);

  return (intent: string): string => {
    const current = held.current;
    if (current !== null && current.intent === intent) return current.key;

    const key = newIdempotencyKey();
    held.current = { intent, key };
    return key;
  };
}

export function useCreateContact(): UseMutationResult<
  Contact,
  Error,
  IdempotentVariables<CreateContactRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateContactRequest>) =>
      unwrap(
        await api.POST('/v1/contacts', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONTACTS_SCOPE });
    },
  });
}

export interface UpdateContactVariables {
  readonly contactId: string;
  readonly patch: UpdateContactRequest;
}

export function useUpdateContact(): UseMutationResult<
  Contact,
  Error,
  IdempotentVariables<UpdateContactVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ contactId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/contacts/{contactId}', {
          body: patch,
          params: { path: { contactId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONTACTS_SCOPE });
    },
  });
}

export interface SetContactActiveVariables {
  readonly contactId: string;
  readonly active: boolean;
}

/**
 * Deactivate and reactivate as one hook over two routes, because they are one control on
 * screen and the pair only makes sense together: deactivation is the sanctioned removal
 * for a contact the ledger names, so it must not be a one-way door.
 */
export function useSetContactActive(): UseMutationResult<
  Contact,
  Error,
  IdempotentVariables<SetContactActiveVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ contactId, active, idempotencyKey }) =>
      unwrap(
        active
          ? await api.POST('/v1/contacts/{contactId}/reactivate', {
              params: { path: { contactId }, header: idempotencyHeader(idempotencyKey) },
            })
          : await api.POST('/v1/contacts/{contactId}/deactivate', {
              params: { path: { contactId }, header: idempotencyHeader(idempotencyKey) },
            }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONTACTS_SCOPE });
    },
  });
}

export function useDeleteContact(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly contactId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ contactId, idempotencyKey }) => {
      const result = await api.DELETE('/v1/contacts/{contactId}', {
        params: { path: { contactId }, header: idempotencyHeader(idempotencyKey) },
      });

      /**
       * `unwrap` deliberately refuses a 2xx with no body and says a 204 route needs a
       * different helper (`src/api/errors.ts`). That helper belongs to `src/api/`, which
       * this ticket may not touch, so the two lines it would hold are here — the same
       * throw, from the same static, so a delete failure presents like every other one.
       */
      if (!result.response.ok || result.error !== undefined) {
        throw ApiError.from(result.response, result.error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONTACTS_SCOPE });
    },
  });
}

/**
 * The refusal tokens `deleteContact` answers with, and the two remedies that differ.
 *
 * `contact_has_postings` is permanent — `fk_journal_lines_contact` is `RESTRICT`, so the
 * row can never be deleted and deactivation is the whole of the remedy.
 * `contact_on_draft` is a reference the user can remove in one edit. The server made them
 * two tokens rather than one message precisely so a client can tell them apart; a screen
 * that showed one red box for both would throw that away.
 */
export const CONTACT_HAS_POSTINGS = 'contact_has_postings';
export const CONTACT_ON_DRAFT = 'contact_on_draft';

/**
 * `details.precondition`, narrowed rather than cast — `details` is
 * `{ [key: string]: unknown }` in the generated types, so trusting its shape would be
 * trusting a description. Anything unexpected reads as "no token", and the caller falls
 * back to the generic error surface. Same construction as `fieldErrorsFrom` in
 * `src/api/presentation.ts`.
 */
export function preconditionOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return null;
  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null || !('precondition' in details)) return null;

  const precondition: unknown = details.precondition;
  return typeof precondition === 'string' ? precondition : null;
}
