import {
  journalLineDimensionListSchema,
  setJournalLineDimensionsRequestSchema,
} from '@openbooks/shared-types';
import type { JournalLineDimensionList } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { getJournalLineDimensions, setJournalLineDimensions } from '../../modules/dimensions';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/journal-lines/{lineId}/dimensions` — retagging a posted line (OB-037,
 * ROADMAP D-18, D-32).
 *
 * ## Why this is the only mutable thing hanging off a posted journal
 *
 * `journals.ts` states that a posted journal is never edited and that the app user
 * holds no `UPDATE` or `DELETE` to do it with. A tag is not part of the entry: it
 * is an analysis dimension laid over the ledger, which is why
 * `journal_line_dimensions` is in `0004_app_grants`'s allowlist and why
 * `openbooks/no-journal-writes` names `journals` and `journal_lines` and
 * deliberately not that table. Retagging cannot move an amount — nothing in the
 * dimensions module writes one — so the append-only guarantee is untouched. A
 * closed period does not stop a retag either (D-32): closing stops the books
 * moving, and a tag is not part of what the books say.
 *
 * ## `PUT` rather than `POST` or `PATCH`
 *
 * The request is the *complete* set of values the line carries afterwards, so the
 * operation is idempotent by construction and replaces a resource that always
 * exists — a line with no tags is the empty set rather than a missing one. `PATCH`
 * would imply an add-and-remove pair, which the shared-types commentary rules out:
 * a line holds at most one value per axis, so tagging is always a replacement on
 * some axis and never an append, and an empty list is how a caller clears them.
 *
 * ## Why the line id is not validated to a pattern here
 *
 * `journal_lines.id` is a `BIGINT` and crosses the wire as a decimal string. The
 * service resolves it through `journalLineIdOrUndefined`, which routes a malformed
 * id to the same `404` a nonexistent one gets — A7's rule that no class of ids
 * earns a distinguishable answer. A `z.regex` here would answer `400` for a
 * malformed id and hand back exactly the distinction the module removed, so the
 * pattern below is published as documentation and enforced by nothing.
 */

const TAG = 'dimensions';

/**
 * A restatement, in the sense `MINOR_UNITS_WIRE_PATTERN` uses: the authority is
 * `journalLineIdOrUndefined` in the dimensions module, and declaring the shape here
 * is what puts it in `openapi.json` for a generated client to read.
 */
const LINE_ID_WIRE_PATTERN = '^[1-9][0-9]{0,19}$';

const journalLineParamsSchema = z.strictObject({
  lineId: z
    .string()
    .min(1)
    .meta({
      pattern: LINE_ID_WIRE_PATTERN,
      description:
        'A posted journal line’s id, as a decimal string — the column is a `BIGINT` and a JSON ' +
        'number cannot carry one past 2^53. A value that is not one answers `404`, not `400`.',
    }),
});

export function registerJournalLineRoutes(app: App): void {
  app.get(
    '/v1/journal-lines/:lineId/dimensions',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getJournalLineDimensions',
        summary: 'The dimension values one posted line carries',
        description: 'At most one value per axis, which is what makes acceptance B6 true.',
        tags: [TAG],
        params: journalLineParamsSchema,
        response: { 200: journalLineDimensionListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<JournalLineDimensionList> => ({
      dimensions: wireList(await getJournalLineDimensions(request.params.lineId, getContext())),
    }),
  );

  app.put(
    '/v1/journal-lines/:lineId/dimensions',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'setJournalLineDimensions',
        summary: 'Retag a posted journal line',
        description:
          'Replaces the whole set: an axis absent from `valueIds` is untagged afterwards, and an ' +
          'empty list clears every tag. Two values on one axis is a `precondition_failed`, not a ' +
          'last-one-wins. A tag already present passes even if its value has since been ' +
          'archived — otherwise archiving one value would make the line untaggable on every ' +
          'other axis — while a new or moved tag must name a live value on a live axis.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: journalLineParamsSchema,
        body: setJournalLineDimensionsRequestSchema,
        response: { 200: journalLineDimensionListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { lineId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'setJournalLineDimensions',
          request: { lineId, tags: request.body },
          successStatus: 200,
        },
        async () => ({
          dimensions: wireList(await setJournalLineDimensions(lineId, request.body, ctx)),
        }),
      );

      return reply.status(result.status).send(idempotentBody<JournalLineDimensionList>(result));
    },
  );
}
