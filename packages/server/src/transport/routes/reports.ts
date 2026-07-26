import { trialBalanceQuerySchema, trialBalanceSchema } from '@openbooks/shared-types';
import type { z } from 'zod';

import { getTrialBalance } from '../../modules/ledger';
import type { TrialBalance } from '../../modules/ledger';
import type { App } from '../types';
import { ERROR_RESPONSES, requireOrgScope, wireList } from './support';

/**
 * `/v1/reports/trial-balance` — acceptance **A2**.
 *
 * A read, so no `Idempotency-Key` and no `withIdempotency`: there is nothing to
 * execute at most once. That also means the response is typed end to end rather than
 * cast — the service's `TrialBalance` is checked against the schema by the compiler,
 * which is the assertion the write routes have to make by hand.
 *
 * Every amount is already a cents-only string when it arrives here. The service
 * normalizes MySQL's `SUM`-over-`BIGINT` (which the driver returns as a DECIMAL
 * string) through `BigInt` and renders with `.toString()`, so nothing on this path
 * ever holds a `number` — a `Number()` anywhere in it would reintroduce exactly the
 * precision loss the money design exists to prevent.
 *
 * `difference` is reported and not asserted. This endpoint says what the ledger
 * contains; a non-zero difference is a fact an operator needs to see rather than an
 * exception to swallow, and turning it into an alert belongs to the property tests
 * and the integrity job (spec §11).
 */

const TAG = 'reports';

export function registerReportRoutes(app: App): void {
  app.get(
    '/v1/reports/trial-balance',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTrialBalance',
        summary: 'Trial balance',
        description:
          'Debit and credit totals per account plus the org-wide totals, which must be equal. ' +
          'A direct aggregation over journal lines — there is no balance cache in M1, because a ' +
          'stale one produces books that balance on screen and not in the data.',
        tags: [TAG],
        querystring: trialBalanceQuerySchema,
        response: { 200: trialBalanceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<z.infer<typeof trialBalanceSchema>> => {
      const { asOf } = request.query;
      // No context argument: `getTrialBalance` defaults it from the ambient scope, and
      // spec §4 is explicit that the org must not travel as a parameter.
      const balance: TrialBalance = await getTrialBalance(asOf === undefined ? {} : { asOf });

      return { ...balance, rows: wireList(balance.rows) };
    },
  );
}
