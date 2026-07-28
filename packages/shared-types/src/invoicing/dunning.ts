import { z } from 'zod';

import { minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

/**
 * Dunning policies (OB-129, Phase 4): the ordered ladder of reminders the sweep
 * (`modules/invoicing/dunning/engine.ts`) walks against every overdue invoice.
 *
 * See `accounts/accounts.ts` for the `id`-placement rule this file follows: an
 * `id` goes on a request-body or response schema a route references, and on
 * nothing else. `dunningStageSchema` is nested inside both directions and is
 * referenced by no route on its own, so it carries none.
 */

/**
 * `dunning_stages.stage_number` is `SMALLINT UNSIGNED` (`0008_recurring_dunning`);
 * the upper bound restates the column width so an out-of-range value is a
 * `validation_failed` naming the field rather than a driver error.
 */
const STAGE_NUMBER_MAX = 65_535;

/**
 * `offset_days` is a signed `INT` in the schema, but nothing about a reminder
 * ladder needs a range that wide — ten years either side of the due date is
 * already an implausible policy. The bound exists so a typo (an extra digit)
 * fails as a validation error instead of scheduling a reminder for the year 4026.
 */
const OFFSET_DAYS_BOUND = 3_650;

const STAGE_SUBJECT_MAX_LENGTH = 255;
/**
 * `dunning_stages.body` is `TEXT` (up to 65,535 bytes) — this is a sanity bound on
 * the message a reminder carries, not a restatement of the column width.
 */
const STAGE_BODY_MAX_LENGTH = 20_000;
const POLICY_NAME_MAX_LENGTH = 255;

/**
 * One rung of a dunning ladder: when it fires, relative to the invoice's due
 * date, and what it sends.
 *
 * `offsetDays` follows `0008_recurring_dunning`'s convention exactly: negative is
 * a courtesy reminder before the due date, zero is on it, positive is a chase
 * after. `lateFeeMinor` is the optional punitive stage — set, it names a fee this
 * stage would post; `null`/absent is the ordinary reminder that costs nothing.
 * Posting the fee is not implemented in v1 (see `engine.ts`); the field is
 * accepted and stored so a policy authored today does not need re-entry once it
 * is.
 */
export const dunningStageSchema = z.strictObject({
  stageNumber: z
    .int()
    .min(1)
    .max(STAGE_NUMBER_MAX)
    .meta({
      description:
        'The rung’s position in the ladder. The engine sends at most one stage per sweep per ' +
        'invoice — the highest-numbered stage that has come due and has not already sent.',
    }),
  offsetDays: z
    .int()
    .min(-OFFSET_DAYS_BOUND)
    .max(OFFSET_DAYS_BOUND)
    .meta({
      description:
        'Days relative to the invoice’s due date this stage triggers on: negative is before the ' +
        'due date, zero is on it, positive is a chase after it.',
    }),
  subject: z.string().trim().min(1).max(STAGE_SUBJECT_MAX_LENGTH).meta({
    description: 'The reminder email’s subject line.',
  }),
  body: z.string().min(1).max(STAGE_BODY_MAX_LENGTH).meta({
    description: 'The reminder email’s body.',
  }),
  lateFeeMinor: minorUnitsSchema.nullish().meta({
    description:
      'An optional late fee this stage would post, in minor units. `null`/absent is the ordinary ' +
      'case of a reminder that costs nothing. Not yet posted by the engine (a follow-up).',
  }),
});

export type DunningStage = z.infer<typeof dunningStageSchema>;

export const createDunningPolicyRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(POLICY_NAME_MAX_LENGTH).meta({
      description: 'Display name for the policy, e.g. `Standard 30/60/90`.',
    }),
    stages: z
      .array(dunningStageSchema)
      .min(1)
      .meta({
        description:
          'The ladder, in any order — `stageNumber` carries the order, not array position. Stage ' +
          'numbers must be unique within the policy (`uq_dunning_stages_policy_stage`).',
      }),
  })
  .meta({
    id: 'CreateDunningPolicyRequest',
    description: 'Creates a dunning policy with its full ladder of stages, active by default.',
  });

export type CreateDunningPolicyRequest = z.infer<typeof createDunningPolicyRequestSchema>;

/**
 * Every field optional; an absent field is left alone. `stages`, when present,
 * replaces the whole ladder — there is no per-stage patch, matching
 * `updateInvoiceRequestSchema`'s `lines` for the same reason: a ladder edited one
 * rung at a time can end up with two stages claiming the same number with no
 * single request responsible for the collision.
 */
export const updateDunningPolicyRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(POLICY_NAME_MAX_LENGTH).optional(),
    isActive: z
      .boolean()
      .optional()
      .meta({
        description:
          'Prefer `POST …/deactivate` to retire a policy — this field exists for the same ' +
          'request to also change other fields, not as the primary way to flip it.',
      }),
    stages: z.array(dunningStageSchema).min(1).optional(),
  })
  .meta({
    id: 'UpdateDunningPolicyRequest',
    description: 'Updates a dunning policy. An absent field is left unchanged.',
  });

export type UpdateDunningPolicyRequest = z.infer<typeof updateDunningPolicyRequestSchema>;

/**
 * A dunning policy as the API returns it, with its stages.
 *
 * `orgId` is absent for `accountSchema`'s reason: every policy the caller can
 * reach belongs to the context's org, so the field would carry no information.
 */
export const dunningPolicySchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    isActive: z.boolean(),
    stages: z.array(dunningStageSchema),
  })
  .meta({ id: 'DunningPolicy', description: 'One dunning policy and its ladder of stages.' });

export type DunningPolicy = z.infer<typeof dunningPolicySchema>;

/**
 * Local and carrying no `id`, for `listAccountsQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for it would
 * be referenced by nothing.
 */
export const listDunningPoliciesQuerySchema = z.strictObject({
  ...pageQueryShape,
});

export type ListDunningPoliciesQuery = z.input<typeof listDunningPoliciesQuerySchema>;

/**
 * Ordered `(created_at, id)` for `contactPageSchema`'s reason: `name` and
 * `isActive` are both editable, and a keyset over a mutable column silently
 * drops a policy that moved behind the cursor.
 */
export const dunningPolicyPageSchema = pageSchema(dunningPolicySchema, {
  id: 'DunningPolicyPage',
  description: 'One page of the org’s dunning policies, ordered by `(created_at, id)`.',
});

export type DunningPolicyPage = z.infer<typeof dunningPolicyPageSchema>;
