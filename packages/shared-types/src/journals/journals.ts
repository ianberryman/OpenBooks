import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * The journal wire contract (OB-023; spec §7).
 *
 * ## No actor fields on any request
 *
 * A journal records who or what made it (spec §6) and nothing below accepts that.
 * Provenance is taken from the resolved session by the route, because a client that
 * could name the actor could attribute an entry to somebody else — which in an
 * append-only ledger is unamendable. `postJournal` refuses a missing actor as a
 * wiring fault in the caller rather than as a client error, and this is why: the
 * client was never asked.
 *
 * ## No `orgId`, and no `currency`
 *
 * Org scope comes from the request context (spec §4 forbids it as a parameter), so
 * there is no field here through which another org's id could be sent. Multi-currency
 * is out of v1 scope (spec §13) and a field the kernel would ignore is worse than its
 * absence.
 *
 * ## No update, and no delete
 *
 * ROADMAP D-16 and spec §2.2: a posted journal is never edited and never removed —
 * the app user holds no `UPDATE` or `DELETE` grant on `journals` at all (A6). A
 * mistake is corrected by posting a reversal, which is a new journal with every
 * side inverted.
 */

/**
 * A line names one side and a positive amount, rather than carrying separate debit
 * and credit fields as the table does.
 *
 * Two amount fields would make "both sides set" and "neither side set"
 * constructible, and both are invariant violations that would then have to be caught
 * at runtime. With a side discriminator they are not expressible, and the only thing
 * left to check is that the amount is positive.
 */
export const JOURNAL_SIDES = ['debit', 'credit'] as const;

export type JournalSideWire = (typeof JOURNAL_SIDES)[number];

const journalSideSchema = z.enum(JOURNAL_SIDES).meta({
  description:
    'Which side of the ledger this line moves. The side carries the sign, so `amount` is ' +
    'always positive — a negative credit is not a debit, it is a caller that has confused the ' +
    'two models.',
});

export const journalLineRequestSchema = z
  .strictObject({
    accountId: z.uuid(),
    side: journalSideSchema,
    /**
     * Strictly positive, enforced by the ledger kernel rather than here. The bound
     * is a rule about what a journal line means, and it is checked in the one place
     * that also checks that the lines balance — a schema that refused `"0"` would
     * split that rule across two layers for no gain.
     */
    amount: minorUnitsSchema,
    memo: z.string().optional(),
  })
  .meta({
    id: 'JournalLineRequest',
    description: 'One side of one account, for a positive amount in minor units.',
  });

/**
 * `lines` carries no `minItems` and that is deliberate.
 *
 * A journal needs at least two lines *and* must balance exactly, and both are
 * decided together by the ledger kernel, on `Money`, with no tolerance. Declaring
 * the arity here would answer half the question at the edge and leave the half that
 * matters to the service, so a client would see two different error shapes for two
 * halves of one rule. The kernel answers both as `validation_failed` naming `lines`.
 */
export const postJournalRequestSchema = z
  .strictObject({
    date: calendarDateSchema.meta({
      description:
        'The entry date. It must fall inside an open fiscal period — periods are never created ' +
        'as a side effect of posting (ROADMAP D-17), so the year has to be generated first.',
    }),
    memo: z.string().optional(),
    lines: z.array(journalLineRequestSchema),
  })
  .meta({
    id: 'PostJournalRequest',
    description:
      'Posts one manual journal. At least two lines, and debits must equal credits exactly — ' +
      'there is no tolerance, because in minor units there is nothing for a tolerance to absorb.',
  });

export type PostJournalRequest = z.infer<typeof postJournalRequestSchema>;

/**
 * A reversal takes its own date.
 *
 * The original's period is usually closed by the time an error is found, and the
 * reversal has to land somewhere postable. That is an accounting choice rather than
 * a convenience: correcting a closed period by reopening it restates figures already
 * reported, while a reversal in the current period leaves the closed period's
 * statements intact and shows the correction where it happened.
 */
export const reverseJournalRequestSchema = z
  .strictObject({
    date: calendarDateSchema.meta({
      description: 'The reversal’s own entry date, which must itself fall in an open period.',
    }),
    memo: z.string().optional(),
  })
  .meta({
    id: 'ReverseJournalRequest',
    description:
      'Posts the reversal of an existing journal: a new journal with every line’s side ' +
      'inverted. A journal may be reversed once.',
  });

export type ReverseJournalRequest = z.infer<typeof reverseJournalRequestSchema>;

export const postedJournalLineSchema = z
  .strictObject({
    /**
     * `journal_lines.id` is a `BIGINT` and internal (spec §4), stringified for the
     * same reason money is a string: a JSON number cannot carry it past 2^53.
     */
    lineId: z.string(),
    accountId: z.uuid(),
    side: journalSideSchema,
    amount: minorUnitsSchema,
    memo: z.string().nullable(),
  })
  .meta({
    id: 'PostedJournalLine',
    description:
      'One stored line. `side` is read back from which amount column is non-zero rather than ' +
      'echoed from the request, so this reports what the ledger holds.',
  });

/**
 * What the ledger stored, read back inside the same transaction that wrote it.
 *
 * Not the input echoed with an id attached: a value assembled in memory would report
 * what the server *intended* to write, and the only claim worth making about a
 * ledger is what the database accepted.
 *
 * Outputs use `| null` where inputs use an optional key. A persisted row either
 * holds a value or holds NULL — the property is never absent.
 */
export const postedJournalSchema = z
  .strictObject({
    journalId: z.uuid(),
    orgId: z.uuid(),
    date: calendarDateSchema,
    memo: z.string().nullable(),
    postedAt: z.iso.datetime().meta({
      description: 'When the journal was written. An instant, not an accounting date.',
    }),
    actorType: z.enum(['user', 'automation', 'agent']).meta({
      description:
        'Who or what made the posting (spec §6). Taken from the session, never from the ' +
        'request.',
    }),
    actorId: z.uuid(),
    invocationMode: z
      .enum(['interactive', 'scheduled'])
      .nullable()
      .meta({
        description:
          'Whether a human was present. Null means unrecorded, which is not the same as ' +
          '`interactive`. Set for agent callers only.',
      }),
    reversesJournalId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'Set when this journal reverses another. The link lives on the reversing journal ' +
          'because the original cannot be updated (ROADMAP D-02).',
      }),
    lines: z.array(postedJournalLineSchema),
  })
  .meta({
    id: 'PostedJournal',
    description: 'A journal as the ledger stored it, read back from the same transaction.',
  });

export type PostedJournalResponse = z.infer<typeof postedJournalSchema>;
