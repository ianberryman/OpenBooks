import {
  calendarDateSchema,
  createReconciliationSessionRequestSchema,
  pageCursorSchema,
  reconciliationReportSchema,
  reconciliationSessionPageSchema,
  reconciliationSessionSchema,
  reconciliationSessionStateSchema,
  reopenReconciliationSessionRequestSchema,
  updateReconciliationSessionRequestSchema,
} from '@openbooks/shared-types';
import type {
  ReconciliationReport,
  ReconciliationSession,
  ReconciliationSessionPage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationReport,
  getReconciliationSession,
  listReconciliationSessions,
  reopenReconciliationSession,
  updateReconciliationSession,
} from '../../modules/banking';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/reconciliation-sessions` and the report over each — the moment the books and
 * the bank are stated to agree (OB-084, for OB-086/087; ROADMAP D-45, D-46, D-50, D-51;
 * acceptance E5, E6, E7, E9).
 *
 * ## `finalise` and `reopen` are `POST`s on their own paths, not a `PATCH { state }`
 *
 * The same shape decision `invoices.ts` made about approve/void, and for the same
 * reason: `state` is a fact about what has happened, not a field a client sets.
 * Finalising records an assertion and takes *no body* — the date, the closing balance
 * and the cleared lines are all on the session already, and the actor comes from the
 * session context, never the request; a body with nothing in it would only invite the
 * field that lets a client finalise against a balance the session was not built from.
 * Reopening is the opposite — it takes exactly one field, `reason`, and it is required
 * (E6): who and when are known without asking, why is not. It is gated by `banking.reopen`
 * where everything else here is `banking.reconcile`, because reopening a finalised
 * assertion is the privileged act.
 *
 * ## The lock is not the fiscal period's (E7)
 *
 * Nothing on a session names a fiscal period, and finalising asserts nothing about one.
 * The two meet in exactly one place, and it is not here: clearing a line posts a journal,
 * and a journal must land in an open period (D-17) — the period lock doing its own job to
 * a posting, not to a session.
 *
 * ## The report is a read, and it is `banking.read` (not `reconcile`)
 *
 * `getReconciliationReport` explains the `unclearedAmount` gap by itemising it (D-50), and
 * it takes the plain read permission because reading a finalised reconciliation is not the
 * privileged act reconciling is. It reflects a finalised session's frozen membership
 * (D-51), so a past reconciliation reads the same tomorrow as the day it was made.
 */

const SESSION_TAG = 'reconciliation-sessions';

const sessionParamsSchema = z.strictObject({ sessionId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listSessionsWireQuerySchema = z.strictObject({
  bankAccountId: z.uuid().optional(),
  state: reconciliationSessionStateSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  limit: pageLimitQuery('sessions'),
  cursor: pageCursorSchema.optional(),
});

export function registerReconciliationRoutes(app: App): void {
  app.post(
    '/v1/reconciliation-sessions',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createReconciliationSession',
        summary: 'Open a reconciliation session',
        description:
          'Opens a session against a bank account, an end date and the statement’s closing ' +
          'balance. `startDate` is derived (carry on from the last session) and accepted only as ' +
          'an assertion — a value disagreeing with the derived start is ' +
          '`reconciliation_session_overlaps`. At most one session is open per account.',
        tags: [SESSION_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createReconciliationSessionRequestSchema,
        response: { 201: reconciliationSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createReconciliationSession', request: request.body, successStatus: 201 },
        () => createReconciliationSession(request.body, ctx),
      );

      const session = idempotentBody<ReconciliationSession>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/reconciliation-sessions/${session.id}`)
        .send(session);
    },
  );

  app.get(
    '/v1/reconciliation-sessions',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listReconciliationSessions',
        summary: 'List reconciliation sessions',
        description:
          'One page, by end date — a statement history read newest last. Each carries its balances ' +
          'but not its event log. A malformed `bankAccountId` filters to an empty page (E9).',
        tags: [SESSION_TAG],
        querystring: listSessionsWireQuerySchema,
        response: { 200: reconciliationSessionPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ReconciliationSessionPage> => {
      const { bankAccountId, state, from, to, limit, cursor } = request.query;
      return listReconciliationSessions(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(bankAccountId === undefined ? {} : { bankAccountId }),
          ...(state === undefined ? {} : { state }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/reconciliation-sessions/:sessionId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getReconciliationSession',
        summary: 'One reconciliation session, with its event log',
        tags: [SESSION_TAG],
        params: sessionParamsSchema,
        response: { 200: reconciliationSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ReconciliationSession> =>
      getReconciliationSession(request.params.sessionId, getContext()),
  );

  app.patch(
    '/v1/reconciliation-sessions/:sessionId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateReconciliationSession',
        summary: 'Correct an open session’s inputs',
        description:
          'The end date and the closing balance it is tested against — the two things a person ' +
          'types. Both are refused once finalised (`reconciliation_session_already_finalised`); ' +
          'the way back is a reopen.',
        tags: [SESSION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: sessionParamsSchema,
        body: updateReconciliationSessionRequestSchema,
        response: { 200: reconciliationSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { sessionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateReconciliationSession',
          request: { sessionId, patch: request.body },
          successStatus: 200,
        },
        () => updateReconciliationSession(sessionId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ReconciliationSession>(result));
    },
  );

  /** No body: `{ sessionId }` *is* the request, so a double-clicked Finalise replays. */
  app.post(
    '/v1/reconciliation-sessions/:sessionId/finalise',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'finaliseReconciliationSession',
        summary: 'Finalise a reconciliation session',
        description:
          'Records the assertion. Refused unless the cleared balance equals the statement’s ' +
          'closing balance at the end date (`reconciliation_session_balance_mismatch`, E5) — the ' +
          'refusal the whole milestone exists to be able to make. Freezes the covered set (D-51) ' +
          'and takes no body: everything it needs is on the session.',
        tags: [SESSION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: sessionParamsSchema,
        response: { 200: reconciliationSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { sessionId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'finaliseReconciliationSession', request: { sessionId }, successStatus: 200 },
        () => finaliseReconciliationSession(sessionId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ReconciliationSession>(result));
    },
  );

  app.post(
    '/v1/reconciliation-sessions/:sessionId/reopen',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'reopenReconciliationSession',
        summary: 'Reopen a finalised session',
        description:
          'Reverts a finalised session to open, thawing its membership so its clearings can be ' +
          'changed again (E6). Takes a required `reason`, kept on the event — the one part of the ' +
          'record a later reader cannot reconstruct. A session that is already open is ' +
          '`reconciliation_session_not_finalised`.',
        tags: [SESSION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: sessionParamsSchema,
        body: reopenReconciliationSessionRequestSchema,
        response: { 200: reconciliationSessionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { sessionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'reopenReconciliationSession',
          request: { sessionId, body: request.body },
          successStatus: 200,
        },
        () => reopenReconciliationSession(sessionId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ReconciliationSession>(result));
    },
  );

  app.get(
    '/v1/reconciliation-sessions/:sessionId/report',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getReconciliationReport',
        summary: 'The reconciliation report for a session',
        description:
          'The gap between the ledger and the bank, itemised. `reconcilingItems` sum to ' +
          '`balances.unclearedAmount` exactly (D-50); `unclearedStatementLines` is the ' +
          'statement-side backlog, shown alongside but outside that sum.',
        tags: [SESSION_TAG],
        params: sessionParamsSchema,
        response: { 200: reconciliationReportSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ReconciliationReport> =>
      getReconciliationReport(request.params.sessionId, getContext()),
  );
}
