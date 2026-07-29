import { z } from 'zod';

/**
 * The org's accounting settings (OB-066a; ROADMAP D-23, D-34, D-40).
 *
 * Which of the org's own accounts the subledger posts through. An approved invoice
 * debits *the* receivables control account and an approved bill credits *the*
 * payables one, and C2 and C8 — the subledger agreeing with the ledger, the aging
 * buckets tying to a balance — are statements about those two accounts
 * specifically. Nothing else on the wire names them: a document request carries
 * line accounts, never the control account, deliberately, because it is a property
 * of the books rather than of the document.
 *
 * ## Why the setting exists at all
 *
 * Because [D-23](#d-23) makes chart templates opt-in and unenforced. Resolving the
 * control account by the code the shipped template uses — `1100`, `2010` — is
 * correct for the orgs that took the template and leaves every other org unable to
 * approve anything, with nowhere to say what the account should have been. An
 * account nomination is the smallest thing that answers that: the org names an
 * account it already has.
 *
 * ## What changing one means, which is the part worth reading
 *
 * A posted journal names the account it posted to, by id, and journals cannot be
 * updated (spec §2.2, §12). So repointing a control account moves **future**
 * postings and cannot restate a past one; there is no operation anywhere that
 * rewrites a posted document's journal, and the database grant would refuse it if
 * there were.
 *
 * The consequence is real and is the reason this is not a free-form edit: while
 * documents posted to the previous account are still outstanding, what the
 * subledger owes is split across two accounts, and neither one alone ties to the
 * aging total. It reconverges as those documents settle. Changing the setting is
 * therefore a setup act — the answer to "we nominated the wrong account" — and not
 * a way to reorganize a chart that is already in use, for which the answer is a
 * journal moving the balance.
 *
 * The `.meta({ id })` on the schemas below arrived with OB-067's routes, which is
 * OB-061's rule for every M3 contract: the OpenAPI component id and the route that
 * references it land in one diff, because the transform publishes a component
 * whether or not anything can reach it.
 */

/**
 * The nominations, either of which may be absent.
 *
 * Separately nullable because the two sides are separately usable: an org that only
 * invoices never needs a payables control account, and requiring one before it
 * could record the other would invent a prerequisite. `null` means "not nominated",
 * which is the state every org is created in — not a defaulted value that happens
 * to be missing.
 */
export const controlAccountsSchema = z
  .strictObject({
    receivableControlAccountId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The account an approved invoice debits and an approved credit note credits. Null until ' +
          'the org nominates one; approving an AR document without it is a `precondition_failed`.',
      }),
    payableControlAccountId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The account an approved bill credits and an approved vendor credit debits. Null until ' +
          'the org nominates one.',
      }),
  })
  .meta({
    id: 'ControlAccounts',
    description:
      'Which of the org’s own accounts its subledger posts through. Either may be null — the two ' +
      'sides are separately usable, and an org that only invoices never needs a payables control ' +
      'account.',
  });

export type ControlAccounts = z.infer<typeof controlAccountsSchema>;

/**
 * A partial update, in which `null` is a value and absence is not.
 *
 * The distinction is load-bearing here in a way it is not in most patches in this
 * API: omitting `payableControlAccountId` leaves the payables nomination alone,
 * while sending `null` clears it. Collapsing the two would make "set only the
 * receivable one" impossible to express without restating a value the caller may
 * not have read, which is the lost-update shape every partial update exists to
 * avoid.
 *
 * Clearing is permitted rather than forbidden once posting has happened, for the
 * file header's reason: the postings that already exist name their account and are
 * unaffected. What a cleared setting costs is the next approval, loudly and
 * immediately.
 */
export const updateControlAccountsRequestSchema = z
  .strictObject({
    receivableControlAccountId: z.uuid().nullable().optional(),
    payableControlAccountId: z.uuid().nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateControlAccountsRequest',
    description:
      'Partial update. An omitted field is left as it is; an explicit `null` clears the ' +
      'nomination. Changing a nomination moves future postings only — journals already posted ' +
      'name the account they were posted to and are never restated.',
  });

export type UpdateControlAccountsRequest = z.infer<typeof updateControlAccountsRequestSchema>;

/**
 * The org's early-pay discount nominations (initiative I, Cash application; ROADMAP
 * D-106, D-107).
 *
 * `discountGivenAccountId`/`discountReceivedAccountId` live in this same
 * `org_accounting_settings` row, beside the two control accounts above, for the
 * reason `0005_subledger`'s migration gives: an early-pay discount is real P&L and
 * posts to an account the org nominates rather than one guessed from a chart
 * template (D-23), exactly as the control accounts are. `discountGivenAccountId` is
 * the expense side of a discount this org gives a customer for paying early;
 * `discountReceivedAccountId` is the income side of a discount a vendor gives this
 * org — the AP mirror. Separately nullable for `controlAccountsSchema`'s own
 * reason: an org that only invoices never gives a vendor discount.
 *
 * No `.meta({ id })` yet, matching `payment-terms.ts`'s rule: OB-139's routes are
 * the later leaf that references this shape, and an unreferenced component would
 * fail A10.
 */
export const discountAccountsSchema = z.strictObject({
  discountGivenAccountId: z
    .uuid()
    .nullable()
    .meta({
      description:
        'The account an early-pay discount debits when this org gives one to a customer. Null ' +
        'until nominated; confirming a discount without it is a `precondition_failed`.',
    }),
  discountReceivedAccountId: z
    .uuid()
    .nullable()
    .meta({
      description:
        'The account an early-pay discount credits when a vendor gives one to this org. Null until ' +
        'nominated.',
    }),
});

export type DiscountAccounts = z.infer<typeof discountAccountsSchema>;

/**
 * A partial update, following `updateControlAccountsRequestSchema`'s own two rules:
 * an omitted field is left as it is, and an explicit `null` clears the nomination.
 */
export const updateDiscountAccountsRequestSchema = z
  .strictObject({
    discountGivenAccountId: z.uuid().nullable().optional(),
    discountReceivedAccountId: z.uuid().nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdateDiscountAccountsRequest = z.infer<typeof updateDiscountAccountsRequestSchema>;
