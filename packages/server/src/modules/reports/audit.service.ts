import type {
  AuditActor,
  AuditEntry,
  AuditReport,
  AuditReportQueryParams,
} from '@openbooks/shared-types';
import { auditReportQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, orgScope, resolvePageLimit, tenantDb, uuidToBuffer } from '../../db';
import { parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AuditFilter, AuditRow } from './audit.repository';
import { selectActorNames, selectAuditPage } from './audit.repository';

/**
 * The audit trail (initiative P, OB-196; ROADMAP D-98).
 *
 * Surfaces provenance that already exists — it captures nothing new. Every
 * journal already carries who posted it and how (`actor_type`, `actor_id`,
 * `created_at`, `source`); `period_close_events` already records every close and
 * reopen (P4). This is the one place the two are read together, newest first, as
 * a single keyset-paged timeline — `audit.repository.ts` holds the merge and the
 * paging, this file holds the permission and the wire mapping.
 *
 * `audit.read` and not `reports.read`: unlike every other report in this module,
 * the audit trail exposes *who did what*, across the whole org, rather than a
 * figure — the read_only/accountant bundles hold both (`0001_tenancy`'s
 * `%.read` pattern), but a role built to read the books without seeing who
 * touched them is expressible, which `reports.read` alone would not allow.
 */
export async function getAuditReport(
  query: AuditReportQueryParams,
  ctx: RequestContext = getContext('getAuditReport()'),
): Promise<AuditReport> {
  await requirePermission(ctx, 'audit.read');

  // Re-parsed at the service boundary (`parseInput`'s own reason): an MCP or
  // workflow caller reaches this function with no Fastify schema in front of it.
  const request = parseInput(auditReportQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filter: AuditFilter = {
    from: request.from === undefined ? null : startOfDay(request.from),
    to: request.to === undefined ? null : endOfDay(request.to),
    actorId: request.actorId === undefined ? null : uuidToBuffer(request.actorId),
  };

  const db = tenantDb(orgScope(ctx.orgId));
  const page = await selectAuditPage(db, filter, limit, request.cursor);
  const names = await selectActorNames(distinctUserActorIds(page.rows));

  return {
    entries: page.rows.map((row) => toAuditEntry(row, names)),
    nextCursor: page.nextCursor,
  };
}

/**
 * `from`/`to` are calendar dates (D-98 bounds the *event* date, matching how the
 * general ledger bounds a range) over an instant column, so each end of the
 * window is expanded to the full UTC day it names — `created_at` is `DATETIME(3)`
 * and the connection pool runs at `timezone: 'Z'` (`src/db/connection.ts`), so a
 * plain string bound would compare a date against an instant under an implicit
 * and untested coercion instead of an explicit one.
 */
function startOfDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

function distinctUserActorIds(rows: readonly AuditRow[]): readonly Buffer[] {
  const seen = new Map<string, Buffer>();
  for (const row of rows) {
    if (row.actor_id === null) continue;
    seen.set(row.actor_id.toString('hex'), row.actor_id);
  }
  return [...seen.values()];
}

function toAuditEntry(row: AuditRow, names: ReadonlyMap<string, string>): AuditEntry {
  return {
    id: bufferToUuid(row.id),
    kind: row.kind,
    action: row.action,
    occurredAt: row.occurred_at.toISOString(),
    actor: toActor(row, names),
    summary: row.summary,
    reference: row.reference,
    source: row.source,
  };
}

function toActor(row: AuditRow, names: ReadonlyMap<string, string>): AuditActor {
  if (row.actor_id === null) return { type: row.actor_type, id: null, name: null };

  return {
    type: row.actor_type,
    id: bufferToUuid(row.actor_id),
    // A miss is a removed user, not a malformed report — `auditActorSchema`
    // documents null as exactly that case.
    name: names.get(row.actor_id.toString('hex')) ?? null,
  };
}
