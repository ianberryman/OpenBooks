import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { runDueWorkNow } from '../../modules/scheduling';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
} from './support';

/**
 * `/v1/scheduling` — the manual trigger for the daily background work (OB-127, transport for
 * `modules/scheduling`).
 *
 * The scheduler runs its recurring and dunning sweeps once a day on its own; this is the one
 * request a person makes about it — "run the due work now" — for an org that has just set up a
 * recurring template or wants its overdue invoices chased this minute rather than at the next
 * midnight. The handler holds no logic: it enqueues the same fan-out the clock does, so the work
 * runs through the identical handlers under the identical automation authority.
 */
const runDueWorkResultSchema = z
  .strictObject({
    runDate: z.iso.date().meta({
      description: 'The calendar date the sweeps were enqueued for — the process’s own today.',
    }),
  })
  .meta({
    id: 'RunDueWorkResult',
    description: 'The outcome of a manual scheduler run: the date its sweeps were enqueued for.',
  });

export function registerSchedulingRoutes(app: App): void {
  app.post(
    '/v1/scheduling/run-due-work',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'runDueScheduledWork',
        summary: 'Run due background work now',
        description:
          'Enqueues the recurring-invoice and dunning sweeps for today, the same fan-out the daily ' +
          'tick performs at midnight. Idempotent: a recurring cycle guards on its last run date and ' +
          'a dunning stage on the send record, so a second run in the same day does nothing new.',
        tags: ['scheduling'],
        headers: idempotencyKeyHeaderSchema,
        response: { 200: runDueWorkResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withIdempotency(
        { endpoint: 'runDueScheduledWork', request: request.body ?? {}, successStatus: 200 },
        () => runDueWorkNow(getContext()),
      );
      return reply.status(result.status).send(idempotentBody<{ runDate: string }>(result));
    },
  );
}
