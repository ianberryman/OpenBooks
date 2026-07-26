import type { PostedJournal } from '@openbooks/plugin-api';
import {
  fromMinorString,
  postedJournalSchema,
  postJournalRequestSchema,
  reverseJournalRequestSchema,
} from '@openbooks/shared-types';
import type { PostedJournalResponse } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { postJournal, reverseJournal } from '../../modules/ledger';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
} from './support';

/**
 * `/v1/journals` — the two operations that write the ledger (spec §7). This is the
 * route acceptance **A1** runs through.
 *
 * ## Money crosses this boundary as a string and is converted here
 *
 * `fromMinorString` is the whole of the conversion, and it cannot fail at the point it
 * is called: `minorUnitsSchema` already handed each amount to the same function during
 * validation, so a decimal amount, a JSON number, or a value outside the storable
 * `BIGINT` range is a `validation_failed` naming the line before this code runs (D-13).
 * That ordering is the reason the mapping is one expression rather than a `try`.
 *
 * The return trip needs no conversion at all: `normalizeResponseBody` in
 * `src/modules/idempotency/` renders every `bigint` through `toMinorString` on its way
 * into the stored body, so the first response and every replay carry the identical
 * cents string. A route that stringified the amounts itself would produce a first
 * response that differed from its own replay.
 *
 * ## Actor provenance comes from the session, never from the request
 *
 * `PostJournalInput` extends `ActorProvenance` and no schema here accepts those
 * fields. They are read from the request context, which the identity resolver
 * populated — a client that could name the actor could attribute an entry to somebody
 * else, and in an append-only ledger that is unamendable (spec §2.2, §6).
 *
 * `invocationMode` is deliberately not forwarded even when the context carries one.
 * `chk_journals_invocation_mode` requires the column exactly for
 * `actor_type = 'agent'` and forbids it otherwise, so passing an interactive user's
 * mode through would make every posting fail a `CHECK` constraint. The identity
 * resolver leaves it absent for exactly this reason; this route does not put it back.
 *
 * ## No update and no delete route, and none is possible
 *
 * A posted journal is never edited (ROADMAP D-16, spec §2.2) and the app user holds no
 * `UPDATE` or `DELETE` grant on `journals` to do it with (A6). Correction is a
 * reversal, which is a new journal.
 */

const TAG = 'journals';

const journalParamsSchema = z.strictObject({ journalId: z.uuid() });

export function registerJournalRoutes(app: App): void {
  app.post(
    '/v1/journals',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'postJournal',
        summary: 'Post a manual journal',
        description:
          'At least two lines, debits equal to credits exactly, every account active and in this ' +
          'org, and the entry date inside an open fiscal period. All of it in one transaction, ' +
          'so a rejected posting leaves nothing behind.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: postJournalRequestSchema,
        response: { 201: postedJournalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { body } = request;

      const result = await withIdempotency(
        { endpoint: 'postJournal', request: body, successStatus: 201 },
        () =>
          postJournal(
            {
              date: body.date,
              ...(body.memo === undefined ? {} : { memo: body.memo }),
              actorType: ctx.actorType,
              actorId: ctx.actorId,
              lines: body.lines.map((line) => ({
                accountId: line.accountId,
                side: line.side,
                amount: fromMinorString(line.amount),
                ...(line.memo === undefined ? {} : { memo: line.memo }),
              })),
            },
            ctx,
          ),
      );

      return reply.status(result.status).send(idempotentBody<PostedJournalResponse>(result));
    },
  );

  /**
   * `POST …/reverse` rather than `DELETE /v1/journals/{id}`, and the difference is not
   * cosmetic: a reversal is an *insert*. It carries its own date, its own sequence
   * number, and its own actor, and after it both journals exist. A `DELETE` would
   * describe the one thing this system cannot do.
   *
   * 201 with no `Location`: the created journal has no `GET` route in M1 (journal
   * *reads* are M2's general-ledger surface), and the body already carries the new
   * `journalId`.
   */
  app.post(
    '/v1/journals/:journalId/reverse',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'reverseJournal',
        summary: 'Reverse a posted journal',
        description:
          'Posts a new journal with every line’s side inverted and `reversesJournalId` set. The ' +
          'original is untouched. A journal may be reversed once; reversing the reversal ' +
          're-instates the original.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: journalParamsSchema,
        body: reverseJournalRequestSchema,
        response: { 201: postedJournalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { journalId } = request.params;
      const { body } = request;

      const result = await withIdempotency(
        {
          endpoint: 'reverseJournal',
          request: { journalId, reversal: body },
          successStatus: 201,
        },
        () =>
          reverseJournal(
            {
              journalId,
              date: body.date,
              ...(body.memo === undefined ? {} : { memo: body.memo }),
              actorType: ctx.actorType,
              actorId: ctx.actorId,
            },
            ctx,
          ),
      );

      return reply.status(result.status).send(idempotentBody<PostedJournalResponse>(result));
    },
  );
}

/**
 * The compile-time link between the kernel's return type and the wire schema.
 *
 * `idempotentBody` casts, so this is what stops it being a blind cast: every field of
 * `PostedJournal` has to be projected by `postedJournalSchema`, and the money fields
 * have to be projected as *strings* — the shape `normalizeResponseBody` actually
 * produces. A field added to `PostedJournal`, or a `MinorUnits` left as a `bigint` in
 * the schema, fails to compile here instead of serializing to an `internal_error` at
 * runtime.
 *
 * `undefined` is excluded from every member, and that is a quirk rather than a
 * loophole: `PostedJournal.invocationMode` is `ActorProvenance['invocationMode'] | null`
 * and the source property is *optional*, so the union it indexes admits `undefined`
 * too. `readBack` reads the column and can only produce `InvocationMode | null`, and the
 * wire schema says so. Widening the schema to match the declared type would document a
 * value the ledger cannot hold.
 */
type MoneyAsWireString<T> = {
  readonly [K in keyof T]: Exclude<T[K], undefined> extends bigint
    ? string
    : Exclude<T[K], undefined> extends readonly (infer E)[]
      ? MoneyAsWireString<E>[]
      : Exclude<T[K], undefined>;
};

type AssertAssignable<_Narrow extends _Wide, _Wide> = true;
export type _PostedJournalMatchesWire = AssertAssignable<
  MoneyAsWireString<PostedJournal>,
  PostedJournalResponse
>;
