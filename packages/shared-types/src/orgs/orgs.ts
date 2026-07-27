import { z } from 'zod';

import { CHART_TEMPLATE_IDS } from '../accounts';

/**
 * The org and membership wire contract (OB-023; spec §5).
 *
 * ## What is deliberately absent
 *
 * **`slug` is a response field only.** Nothing here accepts one. `uq_orgs_slug` is
 * global rather than per-org, so a client-chosen slug plus a "that slug is taken"
 * answer is a probe for whether any tenant in the system is called something — the
 * existence oracle A7 forbids for object ids, applied to names. The server derives
 * the slug and disambiguates collisions with entropy, so a collision is never
 * reported and there is nothing to probe (see `slugify` in `orgs.service.ts`).
 *
 * **There is no org-update request.** Renaming an org and changing its fiscal year
 * start are M2; the second is not a rename at all — it re-cuts every period
 * boundary — and accepting it before the period-regeneration rules exist would
 * persist a change whose consequences are decided later.
 */

/**
 * The calendar month a fiscal year begins in (ROADMAP D-17).
 *
 * Bounded here as well as by `chk_orgs_fiscal_year_start_month`. The database
 * constraint is the guarantee; this is what makes a bad value a `validation_failed`
 * naming the field rather than a driver error surfacing as a 500. The literal 12 is
 * a fact about months rather than a policy that could be retuned, so restating it
 * carries no drift risk.
 */
const fiscalYearStartMonthSchema = z
  .int()
  .min(1)
  .max(12)
  .meta({
    description:
      'The calendar month the org’s fiscal year begins in, 1–12. April, July, and October are ' +
      'all common. Defaults to January where the field is optional.',
  });

/**
 * An org as the API returns it.
 *
 * `fiscalYearStartMonth` is on the summary and not hidden behind a settings
 * endpoint, because a client cannot render a period picker or explain which year an
 * entry falls in without it (ROADMAP D-17).
 */
export const orgSummarySchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    /**
     * Derived from the name, never accepted from a client — see the file header.
     * A URL convenience; `id` is the identity.
     */
    slug: z.string(),
    fiscalYearStartMonth: fiscalYearStartMonthSchema,
  })
  .meta({ id: 'OrgSummary', description: 'One organization the caller can act in.' });

/**
 * An org plus what the caller holds in it.
 *
 * The role travels with the membership rather than with the user because
 * `org_members` is many-to-many: spec §5's motivating case is one login that is
 * Owner of its own books and Read-only on a client's, so "the user's role" is not a
 * question with an answer.
 *
 * `roleCode` is the stable code (`owner`, `bookkeeper`, …) and not a display name,
 * so a client may branch on it. `roleId` is what `org_members` stores.
 */
export const orgMembershipSchema = z
  .strictObject({
    org: orgSummarySchema,
    roleId: z.uuid(),
    roleCode: z.string(),
  })
  .meta({
    id: 'OrgMembership',
    description: 'One organization together with the role the caller holds in it.',
  });

/**
 * An envelope rather than a bare array, for the reason `errorResponseSchema` gives:
 * a top-level object has somewhere to put a later addition, and one an accountant
 * with many clients will need is pagination.
 */
export const orgMembershipListSchema = z
  .strictObject({
    memberships: z.array(orgMembershipSchema),
  })
  .meta({
    id: 'OrgMembershipList',
    description: 'Every organization the caller is a member of, with the role held in each.',
  });

export type OrgMembershipList = z.infer<typeof orgMembershipListSchema>;

/**
 * The starter chart to copy into the new org, if any (ROADMAP D-23).
 *
 * Optional, and its absence is the status quo rather than a default: an org created
 * without it has no accounts at all, because a chart that arrives uninvited is a
 * chart the user deletes account by account. Naming one applies it inside the same
 * transaction that writes the org, so a template that cannot be applied leaves no
 * org behind either — see `createOrgIn` in the server's `modules/orgs`.
 *
 * The enum is restated from `CHART_TEMPLATE_IDS` rather than reusing the schema in
 * `accounts/chart-templates.ts`, which describes the *apply* operation on an org
 * that already exists. The tokens are the shared thing; the descriptions are not.
 */
const chartTemplateIdSchema = z.enum(CHART_TEMPLATE_IDS).meta({
  description:
    'An optional starter chart of accounts to copy into the new organization. Omit it and the ' +
    'organization is created with no accounts. Applied in the same transaction as the ' +
    'organization: an unknown id is a `validation_failed` and no organization is created.',
});

export const createOrgRequestSchema = z
  .strictObject({
    name: z.string().meta({
      description:
        'Length is bounded by the server (`orgs.name` is `VARCHAR(255)`) and reported as a ' +
        '`validation_failed` naming `name`.',
    }),
    fiscalYearStartMonth: fiscalYearStartMonthSchema.optional(),
    chartTemplateId: chartTemplateIdSchema.optional(),
  })
  .meta({
    id: 'CreateOrgRequest',
    description:
      'Creates an organization with the calling user as its Owner. No slug — it is derived ' +
      'from the name.',
  });

export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

/**
 * Points the caller's session at a different org.
 *
 * An org the caller is not a member of and an org that does not exist both answer
 * `not_found`, from one line inside `resolveOrgMembership` — otherwise the switcher
 * enumerates every tenant in the system (A7).
 */
export const switchActiveOrgRequestSchema = z
  .strictObject({
    orgId: z.uuid(),
  })
  .meta({
    id: 'SwitchActiveOrgRequest',
    description:
      'Switches the session’s active organization. The role returned is the one held in the ' +
      'new org, never carried across the switch.',
  });

export type SwitchActiveOrgRequest = z.infer<typeof switchActiveOrgRequestSchema>;
