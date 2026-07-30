import { z } from 'zod';

import { calendarDateSchema, pageCursorSchema, pageQueryShape } from '../wire';

/**
 * The audit-trail wire contract (initiative P, OB-196; ROADMAP D-98).
 *
 * The audit report **surfaces** provenance that already exists — it captures
 * nothing new (D-98). Every journal already carries who/when/how (`actor_type`,
 * `actor_id`, `created_at`, `source`), and `period_close_events` records every close
 * and reopen. This report unifies the two into one who-changed-what timeline, newest
 * first, keyset-paged like the general ledger. Gated by `audit.read`, a capability
 * distinct from `reports.read` because it exposes activity across the org rather than
 * a figure.
 */

/** The kinds of thing the timeline shows. */
export const AUDIT_ENTRY_KINDS = ['journal', 'period-close'] as const;

export type AuditEntryKind = (typeof AUDIT_ENTRY_KINDS)[number];

/** Who performed the action. `id`/`name` are null for actors that are not users. */
export const auditActorSchema = z.strictObject({
  type: z.enum(['user', 'automation', 'agent']),
  id: z.uuid().nullable(),
  name: z.string().nullable().meta({
    description: 'The user’s display name, or null for an automation/agent or a removed user.',
  }),
});

export type AuditActor = z.infer<typeof auditActorSchema>;

/**
 * One event in the timeline.
 *
 * `action` names what happened (`posted`, `reversed`, `closed`, `reopened`);
 * `reference` is the human handle (a journal’s sequence number, a period’s name);
 * `source` is the journal origin (`manual`, `adjusting`, `reclassifying`,
 * `reversal`, …) for a journal entry and null for a period-close event, which is
 * how the report flags adjusting/reclassifying entries (D-98) without a second field.
 */
export const auditEntrySchema = z
  .strictObject({
    id: z.uuid().meta({ description: 'The journal id or the close-event id.' }),
    kind: z.enum(AUDIT_ENTRY_KINDS),
    action: z.string(),
    occurredAt: z.iso.datetime(),
    actor: auditActorSchema,
    summary: z.string().meta({
      description: 'A human sentence, e.g. `Adjusting entry #128` or `Closed 2026-03`.',
    }),
    reference: z.string().nullable(),
    source: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry', description: 'One entry in the who-changed-what timeline.' });

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * The query. An optional date window over the event date, an optional actor filter,
 * and the standard keyset page shape. Dates are calendar dates over the entry/close
 * date, matching how the ledger reports bound a range.
 */
export const auditReportQuerySchema = z
  .strictObject({
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    actorId: z.uuid().optional().meta({ description: 'Restrict to one actor’s activity.' }),
    ...pageQueryShape,
  })
  .meta({ id: 'AuditReportQuery' });

export type AuditReportQueryParams = z.infer<typeof auditReportQuerySchema>;
export type AuditReportQueryInput = z.input<typeof auditReportQuerySchema>;

/**
 * The page. `nextCursor` is null (not absent) when exhausted, the same opaque
 * `PageCursor` the general ledger returns.
 */
export const auditReportSchema = z
  .strictObject({
    entries: z.array(auditEntrySchema),
    nextCursor: pageCursorSchema.nullable().meta({
      description: 'Send back verbatim for the next page; null when the timeline is exhausted.',
    }),
  })
  .meta({ id: 'AuditReport', description: 'A page of the who-changed-what timeline (P6).' });

export type AuditReport = z.infer<typeof auditReportSchema>;
