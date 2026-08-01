import { z } from 'zod';

/**
 * Payment-processor connections — an org's own Stripe or Square, wired to a
 * clearing account and a fee account (initiative J, ROADMAP D-82…D-86,
 * D-101…D-104). `pay-link.ts` holds the customer-facing side of the same
 * initiative; this file holds the connection an org's admin sets up once.
 *
 * ## No `.meta({ id })` here yet
 *
 * The routes arrive in a later stream (OB-150/OB-151), and an `id` with no
 * route publishes a `components.schemas` entry nothing can reach — the
 * sequence `delivery/branding.ts` already describes for the same reason.
 * The ids land in the same diff as the routes; until then these carry
 * descriptions and no id.
 *
 * ## Why the request and the response are different shapes
 *
 * `connectProcessorRequestSchema` carries `secretKey` and `webhookSecret`;
 * `processorConnectionSchema` — the DTO returned to the UI — does not, and
 * never will. Both are inbound-only: they are handed to
 * `SecretsProvider.put` (D-101) and the connection row keeps only the
 * *names* it stored them under (`secret_ref`/`webhook_secret_ref` in
 * `0011_payment_processing`), never the values. This is `apiKeySchema` /
 * `apiKeyWithSecretSchema`'s split applied to a credential this API never
 * gets to show even once — unlike an API key, a processor secret is not
 * something OpenBooks minted, so there is no "shown once at creation" case
 * to carve out for it (D-83).
 */

export const PROCESSOR_KINDS = ['stripe', 'square', 'fake'] as const;

export type ProcessorKind = (typeof PROCESSOR_KINDS)[number];

/**
 * How a connection turns processor activity into ledger entries (OB-237, D-237-1),
 * per-connection and mutually exclusive. `apply_payments` is the PAY default — a
 * charge clears one OpenBooks invoice (`recordPayment`). `summary_sales` is for an
 * org whose invoicing lives entirely in the processor: per-charge posting is
 * suppressed and one grossed-up journal is booked per payout instead. Both on one
 * account would double-count revenue.
 */
export const PAYOUT_SYNC_MODES = ['apply_payments', 'summary_sales'] as const;

export type PayoutSyncMode = (typeof PAYOUT_SYNC_MODES)[number];

export const payoutSyncModeSchema = z.enum(PAYOUT_SYNC_MODES).meta({
  description:
    'How this connection posts (D-237-1). `apply_payments`: a charge clears an ' +
    'invoice. `summary_sales`: one grossed-up journal per payout, per-charge posting ' +
    'suppressed. Mutually exclusive — both would double-count revenue.',
});

export const processorKindSchema = z.enum(PROCESSOR_KINDS).meta({
  description:
    'Which processor this connection talks to. `fake` is a real, deterministic ' +
    'implementation the gate exercises in place of a network call (D-102), not a ' +
    'placeholder value.',
});

/**
 * Column widths. The inequality runs the safe way for `accounts.ts`'s reason:
 * MySQL's `VARCHAR(n)` counts characters and `String.length` counts UTF-16
 * code units, so a value these schemas accept cannot be truncated by the
 * column that stores it — see `0011_payment_processing`.
 */
export const PROCESSOR_PUBLISHABLE_KEY_MAX_LENGTH = 255;
export const PROCESSOR_EXTERNAL_ACCOUNT_ID_MAX_LENGTH = 120;

/**
 * Connects a processor to two existing ledger accounts (D-103, extending
 * D-46's "a bank account is a ledger account plus import metadata" to a
 * processor). `clearingAccountId`/`feeAccountId` name accounts the org
 * already has — the chart is the org's, so a connection that invented
 * accounts in it would decide the org's chart on its behalf, exactly
 * `createBankAccountRequestSchema`'s argument.
 *
 * `secretKey` and `webhookSecret` are inbound-only and never appear in any
 * response (D-83): the service hands each straight to
 * `SecretsProvider.put` and persists only the name it stored it under.
 */
export const connectProcessorRequestSchema = z
  .strictObject({
    processor: processorKindSchema,
    clearingAccountId: z.uuid().meta({
      description:
        'The ledger account a charge clears into immediately (D-82) — "invoice paid" ' +
        'happens here, before any payout reaches the bank.',
    }),
    feeAccountId: z.uuid().meta({
      description: 'The ledger account the per-charge fee posts to (D-104/D-84).',
    }),
    publishableKey: z
      .string()
      .trim()
      .min(1)
      .max(PROCESSOR_PUBLISHABLE_KEY_MAX_LENGTH)
      .optional()
      .meta({
        description:
          'The processor’s public, embeddable key, if it has one (Stripe does; not a secret).',
      }),
    secretKey: z
      .string()
      .trim()
      .min(1)
      .meta({
        description:
          'The processor’s secret API key. Inbound-only — stored through the secrets ' +
          'provider (D-101) and never echoed by any response (D-83).',
      }),
    webhookSecret: z
      .string()
      .trim()
      .min(1)
      .meta({
        description:
          'The signing secret the webhook receiver verifies inbound events against (D-85). ' +
          'Inbound-only, for `secretKey`’s reason.',
      }),
    externalAccountId: z
      .string()
      .trim()
      .min(1)
      .max(PROCESSOR_EXTERNAL_ACCOUNT_ID_MAX_LENGTH)
      .optional()
      .meta({
        description: 'The processor’s own id for the connected account, if it assigns one.',
      }),
  })
  .meta({
    description:
      'Connects a processor to two existing ledger accounts (D-103). `secretKey` and ' +
      '`webhookSecret` are inbound-only and never appear in any response (D-83).',
  });

export type ConnectProcessorRequest = z.infer<typeof connectProcessorRequestSchema>;

/**
 * A processor connection as the API returns it — never carrying `secretKey`
 * or `webhookSecret`. See this file's header for why there is no
 * with-secret counterpart: unlike an API key, OpenBooks never minted the
 * value in the first place, so there is no one response that gets to show
 * it once.
 */
export const processorConnectionSchema = z
  .strictObject({
    id: z.uuid(),
    processor: processorKindSchema,
    clearingAccountId: z.uuid(),
    feeAccountId: z.uuid(),
    publishableKey: z.string().nullable(),
    externalAccountId: z.string().nullable(),
    isActive: z.boolean().meta({
      description:
        'An inactive connection stops the webhook and the poll from writing new ' +
        'payments through it, and keeps every payment it already recorded.',
    }),
    syncMode: payoutSyncModeSchema,
    autoPost: z.boolean().meta({
      description:
        'When `summary_sales`: whether each payout’s summary journal is posted ' +
        'automatically (D-237-2) or held as a `pending_review` payout sync for a human ' +
        'to post. Review-first by default.',
    }),
    lastPolledAt: z.iso.datetime().nullable().meta({
      description: 'When the D-85 polling backstop last ran against this connection.',
    }),
    reconciledThrough: z.iso
      .datetime()
      .nullable()
      .meta({
        description:
          'The instant through which the clearing account has been reconciled against the ' +
          'processor’s own reported balance (D-85, J6).',
      }),
  })
  .meta({
    description:
      'A payment-processor connection as the API returns it — never carrying `secretKey` ' +
      'or `webhookSecret` (D-83). See this module’s header for why there is no with-secret ' +
      'counterpart.',
  });

export type ProcessorConnection = z.infer<typeof processorConnectionSchema>;
