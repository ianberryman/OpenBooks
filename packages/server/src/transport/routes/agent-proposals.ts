import {
  journalDraftPageSchema,
  listDraftsQuerySchema,
  postedJournalSchema,
} from '@openbooks/shared-types';
import type { JournalDraftPage, PostedJournalResponse } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { approveProposal, listProposals, rejectProposal } from '../../modules/agents';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
} from './support';

/**
 * `/v1/agent-proposals` — the agent review queue (OB-103, OB-104; ROADMAP D-60;
 * spec §6). What finally routes `agents.review`, seeded and latent since M1.
 *
 * Every proposal here **is** an ordinary `journal_drafts` row — `journal.propose`
 * (the MCP tool, `modules/mcp/tools.ts`) lands one through the same `createDraft`
 * a person's own form uses, and this file is a thin, differently-permissioned
 * wrapper over `modules/drafts` (`review.service.ts`'s header explains why the
 * queue is every pending draft, not an agent-authored subset). That is also why
 * there is no `POST /v1/agent-proposals` here: a proposal is created by
 * `journal.propose` over MCP, never by an HTTP client of this route file, and
 * `journal_drafts` carries no origin column to distinguish one from a draft a
 * person typed by hand.
 *
 * Approving and rejecting both reach a **second** gate after this file's own —
 * `postDraft`/`discardDraft` re-check `journals.post`, so turning a proposal into
 * a posting takes `agents.review` *and* `journals.post` together, held by the
 * seeded Approver role for exactly that reason.
 */

const TAG = 'agent-proposals';

const proposalParamsSchema = z.strictObject({ draftId: z.uuid() });

export function registerAgentProposalRoutes(app: App): void {
  app.get(
    '/v1/agent-proposals',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listProposals',
        summary: 'List pending proposals',
        description:
          'One page of pending proposals, oldest first — every draft not yet posted or ' +
          'discarded, the same collection `GET /v1/journal-drafts` lists, gated on ' +
          '`agents.review` instead of `journals.read`.',
        tags: [TAG],
        querystring: listDraftsQuerySchema,
        response: { 200: journalDraftPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<JournalDraftPage> => {
      const { createdByUserId, limit, cursor } = request.query;
      return listProposals(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(createdByUserId === undefined ? {} : { createdByUserId }),
        },
        getContext(),
      );
    },
  );

  app.post(
    '/v1/agent-proposals/:draftId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveProposal',
        summary: 'Approve a proposal, posting it to the ledger',
        description:
          'Posts the draft and discards it, in one transaction, exactly once (D-19) — the same ' +
          'operation `POST /v1/journal-drafts/{draftId}/post` performs, reached through the ' +
          'review queue instead. Provenance on the resulting journal is the *approver’s*, not ' +
          'the proposing agent’s.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: proposalParamsSchema,
        response: { 201: postedJournalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { draftId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveProposal', request: { draftId }, successStatus: 201 },
        () => approveProposal(draftId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PostedJournalResponse>(result));
    },
  );

  app.post(
    '/v1/agent-proposals/:draftId/reject',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'rejectProposal',
        summary: 'Reject a proposal, discarding it',
        description:
          'Discards the proposal outright — the same operation a person discarding their own ' +
          'unfinished draft performs (D-16). Nothing about a rejected proposal is recorded ' +
          'anywhere.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: proposalParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { draftId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'rejectProposal', request: { draftId }, successStatus: 204 },
        async () => {
          await rejectProposal(draftId, ctx);
          return null;
        },
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
