import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything this screen asks of `/v1/customer-statements` (OB-220 part 1).
 *
 * A statement is the aging report scoped to one customer, rendered to a PDF the customer
 * can be handed or emailed. Rendering it is a write — it stores an artifact and records a
 * row — so `create` carries an `Idempotency-Key` exactly as `statement-packages/queries.ts`'s
 * `useCreateStatementPackage` does, and a replayed request returns the same statement
 * rather than rendering a second one. The list is unpaginated in v1, same reasoning as that
 * module: a plain `useQuery` rather than the keyset pattern the paged lists use.
 */

export type CustomerStatement = components['schemas']['CustomerStatement'];
export type CustomerStatementList = components['schemas']['CustomerStatementList'];
export type CreateCustomerStatementRequest =
  components['schemas']['CreateCustomerStatementRequestInput'];

const CUSTOMER_STATEMENTS_QUERY_KEY = ['customer-statements', 'list'] as const;

function listQueryKey(contactId: string | undefined): readonly unknown[] {
  return [...CUSTOMER_STATEMENTS_QUERY_KEY, contactId ?? null];
}

/**
 * Every statement this org has generated, newest first, optionally scoped to one customer.
 * Like `useStatementPackages`, each `downloadUrl` is a freshly signed URL minted on this
 * read, which is why a create refetches this list rather than merely revalidating it.
 */
export function useCustomerStatements(
  contactId?: string,
): UseQueryResult<CustomerStatementList, Error> {
  return useQuery({
    queryKey: listQueryKey(contactId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/customer-statements', {
          params: { query: contactId === undefined ? {} : { contactId } },
        }),
      ),
  });
}

export function useCreateCustomerStatement(): UseMutationResult<
  CustomerStatement,
  Error,
  IdempotentVariables<CreateCustomerStatementRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreateCustomerStatementRequest>) =>
      unwrap(
        await api.POST('/v1/customer-statements', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CUSTOMER_STATEMENTS_QUERY_KEY });
    },
  });
}
