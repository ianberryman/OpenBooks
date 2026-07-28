import { createRequestContext, runInContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../db';
import { InternalError } from '../../errors';
import { OWNER_ROLE_ID } from '../orgs';

/**
 * Runs `fn` as the org's scheduled automation (H9; ROADMAP D-76/D-77).
 *
 * A scheduled job has no request and no user, but a thing it does — post an invoice, send a
 * reminder — must still be **authorized** and **attributed**, or the ledger kernel's own gates
 * (spec §2.4: `postJournal` checks the caller's `journals.post`) would refuse it and a journal
 * would carry no provenance.
 *
 * ## Why the Owner role
 *
 * Authorization resolves from `ctx.roleId` alone (`permissionsForContext`), so an automation
 * needs a real role, and there is no seeded "automation" role. It runs under the **Owner**
 * role — the fixed system role (`0001_tenancy`, reserved id) that holds every permission — so
 * `requirePermission` answers exactly as it does for a human owner and no capability has to be
 * special-cased for the scheduler. The authority is the org's own; nothing is escalated across
 * orgs, because the context is opened per `orgId` and every read stays `tenantDb(orgId)`-scoped.
 *
 * ## Why `automation` / `scheduled`, and a null user
 *
 * The provenance is the point of not simply reusing a human's context: every journal and every
 * send this produces records `actor_type = 'automation'` and `invocation_mode = 'scheduled'`
 * (plugin-api `ActorProvenance`), so an automated posting is distinguishable from an interactive
 * one forever after. `actorId` names *what* the automation is — the recurring template or dunning
 * policy the caller passes — so the trail leads back to the standing instruction that caused it.
 *
 * ## Why `userId` is the owner and not null
 *
 * A tidier story would set `userId` to null — no person did this. But `ar_documents` (and the
 * documents the recurring engine raises through `createInvoice`) has a NOT NULL
 * `created_by_user_id`: a subledger document must name the person accountable for it, and
 * "nobody" is not a person the schema admits. So an automated run is attributed to the org's
 * **owner** — the user under whose standing authority it runs — while `actor_type = 'automation'`
 * keeps it honestly distinguished from something the owner did at a keyboard. The role and the
 * user are the same principal, resolved once per run.
 */
export async function runAsAutomation<T>(
  orgId: string,
  actorId: string,
  fn: (ctx: RequestContext) => Promise<T>,
): Promise<T> {
  const ctx = createRequestContext({
    orgId,
    userId: await resolveOwnerUserId(orgId),
    roleId: OWNER_ROLE_ID,
    actorType: 'automation',
    actorId,
    invocationMode: 'scheduled',
  });
  return runInContext(ctx, () => fn(ctx));
}

/**
 * The user id of the org's owner — the earliest membership holding the Owner role.
 *
 * A cross-org read on `systemDb()`, because the scheduler runs outside any tenant scope and is
 * resolving which principal to *enter* one as. Earliest wins so the attribution is stable as
 * co-owners are added later. An org with no owner is not a state registration can produce
 * (`createOrg` seeds one), so its absence is an invariant violation rather than a not-found.
 */
async function resolveOwnerUserId(orgId: string): Promise<string> {
  const row = await systemDb()
    .selectFrom('org_members')
    .select('user_id')
    .where('org_id', '=', uuidToBuffer(orgId))
    .where('role_id', '=', uuidToBuffer(OWNER_ROLE_ID))
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();

  if (row === undefined) {
    throw new InternalError(`Org ${orgId} has no owner to attribute scheduled work to.`);
  }
  return bufferToUuid(row.user_id);
}
