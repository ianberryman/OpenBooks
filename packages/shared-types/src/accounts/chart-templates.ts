import { z } from 'zod';

import { accountSchema } from './accounts';

/**
 * The wire contract for starter charts of accounts (OB-039, D-23).
 *
 * Only the *identity* of a template is on the wire. The accounts a template
 * contains are application content and live on the server
 * (`src/modules/accounts/chart-templates.ts`), because D-23 makes a template a
 * copy rather than a link: once applied there is no versioning, no upgrade path
 * and no relationship, so a client has nothing to diff its chart against and no
 * reason to hold the source. What it gets back is the accounts that were created,
 * which are ordinary accounts from that moment on.
 *
 * The ids follow the rule stated at the top of `accounts.ts`: one on each body and
 * response a route references, and none on `chartTemplateIdSchema`, which is a
 * field rather than a message. OB-039 left them off because it shipped no routes;
 * OB-045 built `/v1/chart-templates` and added them, exactly as OB-023 added
 * OB-018's.
 */

/**
 * The templates that ship, as stable tokens.
 *
 * `snake_case` and not a uuid: a template is not a row, it is a constant in the
 * source tree, and an integrator naming `general_small_business` in a setup script
 * should be able to read what they wrote. Removing or renaming one is therefore a
 * breaking change to the same degree a route path is — see `src/errors/codes.ts`
 * on why the tokens in this system are never renamed.
 */
export const CHART_TEMPLATE_IDS = ['general_small_business'] as const;

export type ChartTemplateId = (typeof CHART_TEMPLATE_IDS)[number];

const chartTemplateIdSchema = z.enum(CHART_TEMPLATE_IDS).meta({
  description:
    'Which starter chart to copy. An unknown id is a `validation_failed`, not a `not_found`: ' +
    'the set of templates is fixed at build time and is the same for every organization, so ' +
    'naming one that does not exist is a malformed request rather than a missed lookup.',
});

/**
 * What a picker needs, and nothing else.
 *
 * `accountCount` rather than the accounts themselves. The number is what makes the
 * choice — a chart of fifty-odd accounts is a different proposition from one of
 * five — while shipping the full list would invite a client to render it as a
 * preview, and a preview is the first step towards treating the template as
 * something the org stays related to.
 */
export const chartTemplateSummarySchema = z
  .strictObject({
    id: chartTemplateIdSchema,
    name: z.string(),
    description: z.string(),
    accountCount: z.int().nonnegative(),
  })
  .meta({
    id: 'ChartTemplateSummary',
    description:
      'What a picker needs to choose a starter chart, and deliberately not its accounts.',
  });

export type ChartTemplateSummary = z.infer<typeof chartTemplateSummarySchema>;

/**
 * An envelope rather than a bare array, for the reason `orgMembershipListSchema`
 * gives: a top-level object has somewhere to put a later addition. Unpaginated, and
 * it will stay so — the templates are constants in the source tree, so the list's
 * length is a build-time fact rather than a tenant's data.
 */
export const chartTemplateListSchema = z
  .strictObject({
    templates: z.array(chartTemplateSummarySchema),
  })
  .meta({
    id: 'ChartTemplateList',
    description: 'Every starter chart this build ships.',
  });

export type ChartTemplateList = z.infer<typeof chartTemplateListSchema>;

/**
 * Applying a template is one field, and the absence of a second is deliberate.
 *
 * There is no `merge`, `overwrite`, or `skipExisting` flag. A template collides
 * with an existing chart only through `code`, and every answer a flag could give to
 * a collision is worse than refusing: overwriting rewrites accounts that may
 * already carry postings, and skipping silently produces a chart that is neither
 * the org's nor the template's while reporting success. The service therefore
 * refuses the whole application and names every colliding code, which is a request
 * the caller can fix — see `applyChartTemplate`.
 */
export const applyChartTemplateRequestSchema = z
  .strictObject({
    templateId: chartTemplateIdSchema,
  })
  .meta({
    id: 'ApplyChartTemplateRequest',
    description:
      'Copies a starter chart of accounts into this organization. Opt-in: no organization ' +
      'receives one unless this is called (D-23). The accounts created are ordinary accounts ' +
      'with no further relationship to the template.',
  });

export type ApplyChartTemplateRequest = z.infer<typeof applyChartTemplateRequestSchema>;

/**
 * Every account the application created, in the order it created them.
 *
 * The whole chart rather than a count, because this is the one moment the caller
 * can learn the ids without paging the list back — and a parent's id is what a
 * follow-up create needs in order to extend the tree the template just laid down.
 */
export const appliedChartTemplateSchema = z
  .strictObject({
    templateId: chartTemplateIdSchema,
    accounts: z.array(accountSchema),
  })
  .meta({
    id: 'AppliedChartTemplate',
    description:
      'Every account the application created, in the order it created them — the one moment a ' +
      'caller learns their ids without paging the chart back.',
  });

export type AppliedChartTemplate = z.infer<typeof appliedChartTemplateSchema>;
