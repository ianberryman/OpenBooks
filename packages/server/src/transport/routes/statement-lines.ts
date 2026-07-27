import {
  bankLineClearingSchema,
  bankLineDirectionSchema,
  bankMatchProposalListSchema,
  bankMatchProposalsRequestSchema,
  bankStatementLinePageSchema,
  bankStatementLineSchema,
  calendarDateSchema,
  clearBankStatementLineRequestSchema,
  pageCursorSchema,
  removeBankLineClearingRequestSchema,
} from '@openbooks/shared-types';
import type {
  BankLineClearing,
  BankMatchProposalList,
  BankStatementLine,
  BankStatementLinePage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  clearBankStatementLine,
  getStatementLine,
  listStatementLines,
  proposeMatchesWithRules,
  removeBankLineClearing,
} from '../../modules/banking';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/statement-lines`, the match proposals over them, and clearing — the matching
 * screen's whole surface (OB-084, for OB-086; ROADMAP D-42, D-43, D-45; acceptance
 * E3, E4).
 *
 * ## Matching proposes; clearing writes; the two are separate requests (D-43)
 *
 * `proposeBankMatches` is a read — `banking.read`, no ledger write — that answers “what
 * does this page of lines look like” for the lines a screen is showing (E10). Accepting
 * a proposal is a *different* request, `clearBankStatementLine`, made by a person and
 * taking `banking.match`: there is no `proposalId` the server must honour and no batch
 * accept, because a bulk accept is the auto-poster D-43 refuses. The client sends what
 * it wants done, whether a proposal suggested it or someone typed it.
 *
 * Proposals is a `POST` for `bank-imports.ts`'s reason — the line-id set is a body, not
 * a querystring — so it carries an `Idempotency-Key` like every non-`GET` here even
 * though it writes nothing and claims none.
 *
 * ## Clearing is a sub-resource of the line, and `DELETE` carries the reversal
 *
 * A line has at most one clearing (`uq_blc_line`), so it reads as one:
 * `POST …/clearing` creates it, `DELETE …/clearing` removes it. The `DELETE` carries a
 * body because undoing is not a plain delete — where the clearing posted a journal,
 * that journal is *reversed*, never deleted (D-16), and the reversal takes its own entry
 * date, which must fall in an open period (by the time a mis-accept is noticed the line's
 * own month is often closed). A `link_entry` that posted nothing leaves `date` unused
 * rather than forbidden, so a client need not look up the method before undoing.
 */

const LINE_TAG = 'statement-lines';
const PROPOSAL_TAG = 'bank-match-proposals';

const lineParamsSchema = z.strictObject({ lineId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listStatementLinesWireQuerySchema = z.strictObject({
  bankAccountId: z.uuid().optional(),
  importId: z.uuid().optional(),
  direction: bankLineDirectionSchema.optional(),
  cleared: z
    .stringbool()
    .optional()
    .meta({
      description:
        'The matching screen’s whole filter — the uncleared lines are the work. Accepts ' +
        '`true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`).',
    }),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  limit: pageLimitQuery('statement lines'),
  cursor: pageCursorSchema.optional(),
});

export function registerStatementLineRoutes(app: App): void {
  app.get(
    '/v1/statement-lines',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listStatementLines',
        summary: 'List statement lines',
        description:
          'One page, in `(posted_date, id)` order — a statement is read by date, and a line is ' +
          'never modified (D-42), so its date cannot move under a cursor. Each line carries its ' +
          'clearing, or null.',
        tags: [LINE_TAG],
        querystring: listStatementLinesWireQuerySchema,
        response: { 200: bankStatementLinePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankStatementLinePage> => {
      const { bankAccountId, importId, direction, cleared, from, to, limit, cursor } =
        request.query;
      return listStatementLines(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(bankAccountId === undefined ? {} : { bankAccountId }),
          ...(importId === undefined ? {} : { importId }),
          ...(direction === undefined ? {} : { direction }),
          ...(cleared === undefined ? {} : { cleared }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/statement-lines/:lineId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getStatementLine',
        summary: 'One statement line, with its clearing',
        description:
          'The line and its clearing (or null). Useful after clearing a line — the clear endpoint ' +
          'returns the clearing, and this returns the line as it now stands.',
        tags: [LINE_TAG],
        params: lineParamsSchema,
        response: { 200: bankStatementLineSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankStatementLine> =>
      getStatementLine(request.params.lineId, getContext()),
  );

  app.post(
    '/v1/bank-match-proposals',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'proposeBankMatches',
        summary: 'Propose matches for a set of statement lines',
        description:
          'Ranked candidates for the named lines — the page a screen is showing (E10). A read ' +
          '(`banking.read`) that posts nothing: a proposal is computed, not stored (D-43), and ' +
          'accepting one is a separate `POST …/clearing`. A `POST` because the line-id set is a ' +
          'body, so it carries an `Idempotency-Key` without claiming one.',
        tags: [PROPOSAL_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: bankMatchProposalsRequestSchema,
        response: { 200: bankMatchProposalListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankMatchProposalList> =>
      proposeMatchesWithRules(request.body, getContext()),
  );

  app.post(
    '/v1/statement-lines/:lineId/clearing',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'clearBankStatementLine',
        summary: 'Clear a statement line',
        description:
          'Accepting: the one write on the matching path (D-43). `method` chooses one of three — ' +
          'code the line (`post_entry`), link an existing entry (`link_entry`), or settle an ' +
          'invoice or bill (`allocate_document`). E4 holds by construction: ' +
          '`clearedAmount + differenceAmount === line.amount`, and a difference must have an ' +
          'account to post to (`clearing_difference_unaccounted`). A line already cleared is ' +
          '`statement_line_already_cleared`.',
        tags: [LINE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: lineParamsSchema,
        body: clearBankStatementLineRequestSchema,
        response: { 201: bankLineClearingSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { lineId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'clearBankStatementLine',
          request: { lineId, body: request.body },
          successStatus: 201,
        },
        () => clearBankStatementLine(lineId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankLineClearing>(result));
    },
  );

  app.delete(
    '/v1/statement-lines/:lineId/clearing',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'removeBankLineClearing',
        summary: 'Undo a statement line’s clearing',
        description:
          'Removes the clearing and, where it posted a journal, reverses that journal — never ' +
          'deletes it (D-16). `date` is the reversal’s own entry date and must fall in an open ' +
          'period. Undoing a clearing counted by a finalised session is ' +
          '`reconciliation_session_already_finalised`; the way in is a reopen (E6). A line with no ' +
          'clearing is `statement_line_not_cleared`.',
        tags: [LINE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: lineParamsSchema,
        body: removeBankLineClearingRequestSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { lineId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'removeBankLineClearing',
          request: { lineId, body: request.body },
          successStatus: 204,
        },
        () => removeBankLineClearing(lineId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
