import { z } from 'zod';

/**
 * The period-close workflow wire contract (initiative P, OB-193; ROADMAP D-97).
 *
 * Close is a workflow *over* the M1 period lock, not a new lock: the transition
 * itself is still `POST /v1/fiscal-periods/:id/close` (`periods.close`) flipping
 * `fiscal_periods.status`. What P adds is the checklist the workflow runs first and
 * the sign-off it records. The checklist is **advisory** — the ledger kernel already
 * guarantees every journal balances, and the lock is the hard mechanism — so a
 * warning never blocks the close; its value is that the recorded sign-off names what
 * was outstanding when it was given (`period_close_events`, append-only).
 */

/**
 * A check either passes or warns. There is no `fail`: nothing here blocks the close
 * (D-97), so the strongest verdict a check reaches is a warning the accountant signs
 * over.
 */
export const PERIOD_CLOSE_CHECK_STATUSES = ['pass', 'warn'] as const;

export type PeriodCloseCheckStatus = (typeof PERIOD_CLOSE_CHECK_STATUSES)[number];

/**
 * One computed completeness signal. `key` is stable (the report and the recorded
 * snapshot both key off it); `count` is the number of outstanding items when the
 * check is about a count (unposted drafts, unreconciled lines) and absent otherwise
 * (the prior-period-open check is a yes/no).
 */
export const periodCloseCheckSchema = z
  .strictObject({
    key: z.string().meta({
      description: 'Stable identifier, e.g. `unposted_drafts`, `unreconciled_bank_lines`.',
    }),
    label: z.string().meta({ description: 'Human sentence describing the check.' }),
    status: z.enum(PERIOD_CLOSE_CHECK_STATUSES),
    detail: z.string().meta({ description: 'What was found, in words.' }),
    count: z.int().nonnegative().optional().meta({
      description: 'Number of outstanding items, when the check counts. Absent for a yes/no check.',
    }),
  })
  .meta({ id: 'PeriodCloseCheck', description: 'One advisory completeness check.' });

export type PeriodCloseCheck = z.infer<typeof periodCloseCheckSchema>;

/**
 * The checklist as `GET /v1/fiscal-periods/:id/close-checklist` returns it, computed
 * fresh on read. A side-effect-free preview of what a close would record.
 */
export const periodCloseChecklistSchema = z
  .strictObject({
    periodId: z.uuid(),
    checks: z.array(periodCloseCheckSchema),
  })
  .meta({
    id: 'PeriodCloseChecklist',
    description: 'The advisory checks the close workflow surfaces for a period (P3).',
  });

export type PeriodCloseChecklist = z.infer<typeof periodCloseChecklistSchema>;

/**
 * The close body. A sign-off note is optional — the who-and-when is the audit, the
 * note is the human context. The checklist itself is recomputed server-side at close
 * time and stored, never trusted from the client.
 */
export const closePeriodRequestSchema = z
  .strictObject({
    note: z.string().max(1000).optional().meta({
      description: 'An optional sign-off note recorded with the close.',
    }),
  })
  .meta({ id: 'ClosePeriodRequest', description: 'Sign off and lock a fiscal period (P3).' });

export type ClosePeriodRequest = z.infer<typeof closePeriodRequestSchema>;

/**
 * The reopen body. A reason is optional and recorded on the reopen event — reopening
 * withdraws a statement that may already have been relied on (D-97), so the reason is
 * worth capturing, but the audited fact is the event itself.
 */
export const reopenPeriodRequestSchema = z
  .strictObject({
    note: z.string().max(1000).optional().meta({
      description: 'An optional reason recorded with the reopen.',
    }),
  })
  .meta({ id: 'ReopenPeriodRequest', description: 'Reopen a closed fiscal period (P3).' });

export type ReopenPeriodRequest = z.infer<typeof reopenPeriodRequestSchema>;
