import { changeFeedPageSchema, changeFeedQuerySchema } from '@openbooks/shared-types';
import type { ChangeFeedPage } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { readChangeFeed } from '../../modules/change-feed';
import type { App } from '../types';
import { ERROR_RESPONSES, requireOrgScope } from './support';

/**
 * `GET /v1/change-feed` — a resumable, tenant-scoped read over the `event_log`
 * outbox (OB-101, OB-104; ROADMAP D-56, D-57). A projection, not a second store:
 * every call re-reads the same append-only rows `modules/events/outbox.ts`
 * writes, so replay is just reading from an earlier `cursor` again (F8).
 *
 * One route, and no id path: an event is never addressed on its own, only walked
 * forward from a cursor — `changeFeedPageSchema`'s own header says `events` and
 * not `items` for the same reason.
 */

const TAG = 'change-feed';

export function registerChangeFeedRoutes(app: App): void {
  app.get(
    '/v1/change-feed',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'readChangeFeed',
        summary: 'Read the change feed',
        description:
          'One page of the org’s change feed, oldest first. Send back the previous page’s ' +
          '`nextCursor` verbatim to resume — there is no page number, only forward motion ' +
          'through the log (D-57).',
        tags: [TAG],
        querystring: changeFeedQuerySchema,
        response: { 200: changeFeedPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ChangeFeedPage> => readChangeFeed(request.query, getContext()),
  );
}
