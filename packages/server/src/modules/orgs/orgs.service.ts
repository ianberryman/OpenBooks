import { randomBytes } from 'node:crypto';

import { getContext } from '../../context';
import type { DB } from '../../db';
import { newUuid, systemDb, uuidToBuffer } from '../../db';
import { InternalError, NotFoundError, UnauthenticatedError, ValidationError } from '../../errors';
import { resolveMembership } from '../permissions';
import type { Kysely } from 'kysely';
import type { OrgRow } from './orgs.repository';
import {
  insertMembership,
  insertOrg,
  isDuplicateEntryError,
  selectMemberOrgs,
  selectOrg,
} from './orgs.repository';

/**
 * Orgs and the `org_members` many-to-many (spec §5, OB-015).
 *
 * Nothing here reads `sessions`. An org switch mutates the session row and
 * therefore lives in `src/modules/auth/`; this module answers the two questions
 * that switch is made of — "which orgs is this user in" and "what does this user
 * hold in that one" — and owns the A7 conversion for the second.
 */

/**
 * The Owner role's reserved id, seeded by migration `0001_tenancy`.
 *
 * A literal rather than a lookup by `code = 'owner'`. The ids are fixed precisely so
 * that `org_members.role_id` is stable across environments (see the
 * `seedSystemRoles` commentary), and a lookup would make the first membership of
 * every org depend on a row whose `code` column nothing enforces the spelling of.
 */
export const OWNER_ROLE_ID = '00000000-0000-4000-8000-000000000001';

/** The same role's `code`, as seeded. */
export const OWNER_ROLE_CODE = 'owner';

/** `orgs.name` is `VARCHAR(255)`. */
const MAX_ORG_NAME_LENGTH = 255;

/**
 * `orgs.slug` is `VARCHAR(120)`; the base is kept shorter so a disambiguating
 * suffix always fits.
 */
const MAX_SLUG_BASE_LENGTH = 100;

/**
 * Attempts at a unique slug: the derived one, then four with random suffixes.
 *
 * Bounded rather than a `while (true)`: exhausting it means five collisions in a row
 * against 24 bits of entropy, which is not contention but a fault, and a caller
 * hearing about a fault beats a request that never returns.
 */
const MAX_SLUG_ATTEMPTS = 5;

export type OrgSummary = OrgRow;

export interface OrgMembership {
  readonly org: OrgSummary;
  readonly roleId: string;
  /** The role's stable `code` (`owner`, `bookkeeper`, …), not its display name. */
  readonly roleCode: string;
}

export interface OrgCreationInput {
  readonly name: string;
  /** 1–12, defaulting to January (ROADMAP D-17). */
  readonly fiscalYearStartMonth?: number;
}

/**
 * Creates an org with the calling user as Owner.
 *
 * No `requirePermission` call, and there is no permission that would fit: every
 * permission in the catalog is a statement about authority *within* an org, and this
 * operation runs before the org it would be checked against exists. The only gate is
 * that the caller is a real user, which is why it reads the context rather than
 * taking a user id — an org created on behalf of someone else is not a thing this
 * surface should be able to express.
 */
export async function createOrg(input: OrgCreationInput): Promise<OrgMembership> {
  const { userId } = getContext('createOrg()');
  if (userId === null) throw new UnauthenticatedError();

  return systemDb()
    .transaction()
    .execute((trx) => createOrgIn(trx, input, uuidToBuffer(userId)));
}

/**
 * The org write itself, on a transaction the caller owns.
 *
 * Separate from `createOrg` because registration creates the user in the same
 * transaction, so at that point there is no context to read a user id from — the
 * user is being invented.
 */
export async function createOrgIn(
  executor: Kysely<DB>,
  input: OrgCreationInput,
  ownerUserId: Buffer,
): Promise<OrgMembership> {
  const name = normalizeOrgName(input.name);
  const fiscalYearStartMonth = normalizeFiscalYearStartMonth(input.fiscalYearStartMonth);
  const uuid = newUuid();
  const id = uuidToBuffer(uuid);
  const base = slugify(name);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
    try {
      await insertOrg(executor, { id, name, slug, fiscalYearStartMonth });
    } catch (error) {
      if (isDuplicateEntryError(error)) continue;
      throw error;
    }

    await insertMembership(executor, id, ownerUserId, uuidToBuffer(OWNER_ROLE_ID));
    return {
      org: { id: uuid, name, slug, fiscalYearStartMonth },
      roleId: OWNER_ROLE_ID,
      roleCode: OWNER_ROLE_CODE,
    };
  }

  throw new InternalError(
    `Could not allocate a unique orgs.slug for ${JSON.stringify(name)} in ${MAX_SLUG_ATTEMPTS} ` +
      'attempts. The suffix carries 24 bits of entropy, so this is a fault rather than ' +
      'contention — look for a broken unique index or a truncating collation.',
  );
}

/**
 * Every org the user holds a membership in, with the role that membership carries.
 *
 * One query for the org list and then one `resolveMembership` per org, rather than a
 * single join. `resolveMembership` owns the predicate that keeps another org's custom
 * role from resolving here, and it is also the function that must be the authority on
 * membership everywhere (the `sessions` commentary in `0001_tenancy.ts`); a join
 * written here would be a second answer to the same question. The cost is bounded by
 * how many orgs one login belongs to, which spec §5's motivating case — an accountant
 * with a handful of clients — puts in single digits.
 *
 * A membership whose role does not resolve is dropped rather than reported. That is
 * the fail-closed direction: it means the row points at a role that is invisible from
 * its own org, and presenting it would offer the user an org they cannot act in.
 */
export async function listMemberships(userId: string): Promise<readonly OrgMembership[]> {
  const orgs = await selectMemberOrgs(userId);
  const resolved = await Promise.all(
    orgs.map(async (org) => {
      const membership = await resolveMembership(userId, org.id);
      return membership.isMember
        ? { org, roleId: membership.roleId, roleCode: membership.roleCode }
        : undefined;
    }),
  );

  return resolved.filter((entry): entry is OrgMembership => entry !== undefined);
}

/**
 * The membership a user holds in one org, or a `404`.
 *
 * This is the A7 conversion, and the reason it is one function: "you are not a member
 * of that org" and "there is no such org" must be the same answer, byte for byte, or
 * the org switcher enumerates every tenant in the system. `resolveMembership` returns
 * a discriminated union rather than throwing so that this decision is made here, and
 * `NotFoundError('org')` has no channel for anything that could tell the two apart —
 * see the A7 commentary in `src/errors/errors.ts`.
 *
 * Order matters: membership is resolved *before* the org row is read. Reading the org
 * first and reporting a miss differently would reintroduce the oracle one line above
 * the code that exists to prevent it.
 */
export async function resolveOrgMembership(userId: string, orgId: string): Promise<OrgMembership> {
  const membership = await resolveMembership(userId, orgId);
  if (!membership.isMember) throw new NotFoundError('org');

  const org = await selectOrg(orgId);
  // A membership whose org row is gone is a broken foreign key, not a caller error.
  // It is still answered as a miss, because there is nothing here the caller may see.
  if (org === undefined) throw new NotFoundError('org');

  return { org, roleId: membership.roleId, roleCode: membership.roleCode };
}

function normalizeOrgName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_ORG_NAME_LENGTH) {
    throw new ValidationError('Organization name must be 1–255 characters.', [
      { path: 'name', message: `must be between 1 and ${MAX_ORG_NAME_LENGTH} characters` },
    ]);
  }
  return name;
}

/**
 * Checked here as well as by `chk_orgs_fiscal_year_start_month`.
 *
 * The database constraint is the guarantee; this is what makes a bad value a `400`
 * naming the field instead of a driver error surfacing as a `500`.
 */
function normalizeFiscalYearStartMonth(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new ValidationError('Fiscal year start month must be an integer from 1 to 12.', [
      { path: 'fiscalYearStartMonth', message: 'must be an integer from 1 to 12' },
    ]);
  }
  return value;
}

/**
 * Derives the slug from the name; never accepts one from the client.
 *
 * `uq_orgs_slug` is global, not per-org, so a client-chosen slug plus a "that slug is
 * taken" response is a probe for whether any tenant in the system is called something
 * — the same existence oracle A7 forbids for object ids, applied to names. Deriving
 * it and disambiguating collisions with entropy means a collision is never reported
 * at all, so there is nothing to probe.
 *
 * A name with no ASCII alphanumerics at all — which is an ordinary name in most of the
 * world's scripts — reduces to the placeholder and gets a random suffix. The slug is a
 * URL convenience, not an identity; `orgs.id` is the identity.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/g, '');

  return slug.length === 0 ? 'org' : slug;
}
