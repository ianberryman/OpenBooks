import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  createDraftRequestSchema,
  journalDraftPageSchema,
  journalDraftSchema,
  pageCursorSchema,
  postedJournalSchema,
  updateDraftRequestSchema,
} from '@openbooks/shared-types';
import type {
  JournalDraft,
  JournalDraftPage,
  PostedJournalResponse,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  postDraft,
  updateDraft,
} from '../../modules/drafts';
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
 * `/v1/journal-drafts` — entries on their way to the ledger (OB-038; D-16, D-19).
 *
 * ## Why this is a collection of its own and not a mode of `/v1/journals`
 *
 * A draft is not a weaker journal. It is in no report, in no trial balance, has no
 * sequence number and no period, and no invariant applies to it, because it has not
 * happened yet. `POST /v1/journals` with a `status` field would have made the two
 * one resource with a flag deciding whether the ledger's rules apply — which is the
 * shape that eventually posts something unbalanced. Separate paths mean the ledger
 * routes keep their unconditional guarantees and the draft routes keep their
 * unconditional permissiveness.
 *
 * The corollary is the thing to get right, and it is the third of the ticket's
 * questions: **"post this draft" must not be confusable with "post a journal"**.
 * They differ in every way that matters — one names an existing row and destroys it,
 * the other carries a body — so they are different methods on different paths with
 * different operation ids: `postJournal` is `POST /v1/journals` with the entry in
 * the body, `postDraft` is `POST /v1/journal-drafts/{draftId}/post` with an empty
 * one. A `POST /v1/journals` that accepted a `draftId` instead of lines would be
 * the same operation wearing two shapes, and a client that sent both would have to
 * be told which won.
 *
 * ## The permission is `journals.post` on every write here, including create
 *
 * Reads take `journals.read`. D-30 declines a `journals.draft` code and the module
 * header gives the argument: the catalog is fixed and the six system roles are set
 * operations over it, so a new code would land in Owner and Bookkeeper by
 * construction and miss Approver — whose bundle is `%.read` plus a named few
 * including `journals.post`, precisely so it can turn a proposal into a posting. M2
 * would have shipped a role that can post an entry but not compose one.
 *
 * ## Idempotency on the post, which is the one that has to hold
 *
 * `withIdempotency` fingerprints the draft id, so a double-clicked Post button
 * replays the first journal rather than posting a second — and underneath it the
 * service takes the draft's row lock as its first statement, so two callers who
 * chose *different* keys still produce one journal and one 404. The two are not
 * redundant: the claim answers a retry of the same request, the lock answers two
 * different requests racing, and a draft posted twice cannot be undeleted.
 *
 * A failed post leaves the draft intact, which is the whole value of a draft
 * surviving a rejected post: the transaction rolls back and the user sees the entry
 * they were editing plus the reason it was refused.
 */

const TAG = 'journal-drafts';

const draftParamsSchema = z.strictObject({ draftId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listDraftsWireQuerySchema = z.strictObject({
  createdByUserId: z
    .uuid()
    .optional()
    .meta({
      description:
        'Only this author’s drafts. Omitted lists every draft in the org — drafts are visible to ' +
        'anyone who can read journals, and are not private to their author.',
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    .meta({
      description:
        'How many drafts to return, at most. Over the maximum is refused rather than clamped, ' +
        'so a short page always means the list is short.',
    }),
  cursor: pageCursorSchema.optional(),
});

export function registerDraftRoutes(app: App): void {
  app.post(
    '/v1/journal-drafts',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createDraft',
        summary: 'Create a journal draft',
        description:
          'Nothing is required — not a date, not an account, not a line, not a balance. A form ' +
          'that cannot be saved until it is already correct is not a draft. The one rule applied ' +
          'now is that an amount may not be negative, because the side carries the sign; ' +
          'everything else is checked when the draft is posted. An account, contact or dimension ' +
          'value that does not exist in this org is a `not_found`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createDraftRequestSchema,
        response: { 201: journalDraftSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createDraft', request: request.body, successStatus: 201 },
        () => createDraft(request.body, ctx),
      );

      const draft = idempotentBody<JournalDraft>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/journal-drafts/${draft.id}`)
        .send(draft);
    },
  );

  app.get(
    '/v1/journal-drafts',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listDrafts',
        summary: 'List journal drafts',
        description:
          'One page of headers, oldest first by creation, with no lines — the argument ' +
          '`journalSummarySchema` makes: embedding them would make one page’s size depend on how ' +
          'many lines an org’s drafts happen to carry. Ordered by `(created_at, id)` because ' +
          'neither of the journal list’s columns exists on a draft: there is no sequence number ' +
          'by construction, and `entryDate` is nullable.',
        tags: [TAG],
        querystring: listDraftsWireQuerySchema,
        response: { 200: journalDraftPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<JournalDraftPage> => {
      const { createdByUserId, limit, cursor } = request.query;
      return listDrafts(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(createdByUserId === undefined ? {} : { createdByUserId }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/journal-drafts/:draftId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDraft',
        summary: 'One journal draft, with its lines',
        tags: [TAG],
        params: draftParamsSchema,
        response: { 200: journalDraftSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<JournalDraft> => getDraft(request.params.draftId, getContext()),
  );

  app.patch(
    '/v1/journal-drafts/:draftId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDraft',
        summary: 'Update a journal draft',
        description:
          'An absent header field is unchanged and `null` clears it. `lines`, when present, ' +
          'replaces the **whole** set — send every line the draft should have, including the ' +
          'unchanged ones, and `[]` to clear them. Replacement rather than per-line patching ' +
          'because the client is a form that holds every line already, and patching would need ' +
          'line identities stable across an edit that inserts a line in the middle.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: draftParamsSchema,
        body: updateDraftRequestSchema,
        response: { 200: journalDraftSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { draftId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'updateDraft', request: { draftId, patch: request.body }, successStatus: 200 },
        () => updateDraft(draftId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<JournalDraft>(result));
    },
  );

  /**
   * `DELETE`, and it is the one delete in this API that describes what actually
   * happens. A draft has not reached the ledger, so discarding it removes nothing
   * an auditor could ask about and restates no report — which is exactly why D-16
   * could keep the ledger append-only without making a typo cost three entries.
   */
  app.delete(
    '/v1/journal-drafts/:draftId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardDraft',
        summary: 'Discard a journal draft',
        description:
          'Deletes the draft and its lines. Nothing in the ledger changes, because nothing about ' +
          'this draft ever reached it.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: draftParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { draftId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardDraft', request: { draftId }, successStatus: 204 },
        () => discardDraft(draftId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  /**
   * 201, and the body is a `PostedJournal` rather than the draft — the draft does
   * not exist any more, because posting it and deleting it are one transaction
   * (D-19). No `Location`: there is no `GET /v1/journals/{id}`, and the body already
   * carries the new `journalId`.
   *
   * No request body at all. Everything the posting needs is on the draft, and a
   * body here would be a second place to say what is being posted — the first edit
   * of an entry the user thought they had finished, made at the moment they pressed
   * Post.
   */
  app.post(
    '/v1/journal-drafts/:draftId/post',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'postDraft',
        summary: 'Post a draft to the ledger',
        description:
          'Posts the draft and discards it, in one transaction, exactly once. The entry number ' +
          'is allocated now rather than reserved at draft time, or the gapless guarantee (D-14) ' +
          'is not gapless. Everything a journal requires is checked here and not before: a ' +
          'missing date, a line with no account or no side, unbalanced debits and credits, an ' +
          'inactive account, a closed period. A refused post leaves the draft intact and ' +
          'editable. The actor recorded is the caller, not the draft’s author — who posted is ' +
          'the fact an auditor asks about.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: draftParamsSchema,
        response: { 201: postedJournalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { draftId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'postDraft', request: { draftId }, successStatus: 201 },
        () => postDraft(draftId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PostedJournalResponse>(result));
    },
  );
}
