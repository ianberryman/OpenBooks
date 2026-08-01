/**
 * Infrastructure the host supplies and modules consume.
 *
 * D-07: M1 ships the interfaces and env-driven selection (OB-003); concrete
 * adapters land with the first feature that actually sends an email or enqueues a
 * job, because an adapter with no consumer is an adapter with no test. Spec §3
 * requires both a hosted and a self-host implementation of each, and these shapes
 * are the narrowest surface both can satisfy — anything richer would encode one
 * provider's semantics into the contract.
 */

export interface QueueProvider {
  enqueue<T>(queue: string, payload: T, opts?: { delaySeconds?: number }): Promise<void>;
  subscribe<T>(queue: string, handler: (payload: T) => Promise<void>): Promise<void>;
}

export interface StorageProvider {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface SecretsProvider {
  get(name: string): Promise<string>;
  /**
   * The first write path for a secret in this codebase (D-101). A per-org
   * processor key (PAY, initiative J) is handed straight to this and never
   * echoed back by any response — `get` is the only read, and only the
   * service that called `put` has a reason to call it.
   *
   * `name` is an opaque, globally-unique handle — an org id and a connection
   * id folded together, never a value with meaning of its own — so a hosted
   * adapter that namespaces by prefix (AWS Secrets Manager) and a self-host
   * adapter that namespaces by table row share the exact same shape: neither
   * has to be told which org or which processor a name belongs to.
   */
  put(name: string, value: string): Promise<void>;
}

export interface EmailProvider {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

/**
 * Which live-feed backend a `bank_feed_connections` row and a `BankFeedProvider`
 * instance both name (OB-227, ROADMAP D-126). `fake` is the third, real,
 * deterministic implementation the gate exercises in place of a network call to
 * Stripe Financial Connections (the D-102 pattern PAY set) — not a test double
 * bolted onto the union; see `createFakeBankFeed` in
 * `packages/server/src/providers/bankfeed/fake.ts`. `stripe_financial_connections`
 * is a *data* surface (a transaction feed), a distinct Stripe product from PAY's
 * charge/payout use, and must never share a `processor_connections` row.
 */
export type BankFeedSource = 'stripe_financial_connections' | 'fake';

/**
 * One account the connected credential can pull, surfaced by the link/setup flow
 * so a human picks which linked account this connection feeds (OB-227). `category`
 * is the provider's own classification (Stripe FC reports `'cash'` for a bank
 * account, `'credit'` for a card) — v1 feeds asset accounts only (D-130), so it is
 * advisory here and the credit-card follow-on (OB-227b) is what acts on it.
 */
export interface BankFeedAccountRef {
  readonly externalAccountId: string;
  readonly institution: string | null;
  readonly displayName: string;
  readonly category: string | null;
}

/**
 * One transaction off a live feed, normalised the way `ExtractedBill` and
 * `NormalizedProcessorEvent` are — Stripe FC (and any later aggregator) reports on
 * its own schema, and this is the single shape the ingest maps onto so the
 * fingerprint dedup, the matching engine and reconciliation are written once.
 *
 * `externalId` is the provider's own stable transaction id, and it is load-bearing
 * for idempotency (D-127): the ingest carries it into `bank_statement_lines.bank_reference`,
 * so `computeFingerprint` makes a re-synced overlap collapse on the unique key
 * rather than double-post. `amountMinor` is a signed cents string (D-13) in the
 * asset frame — positive is money *into* the account, the same frame a statement
 * line's signed amount already uses — never a decimal or a float.
 */
export interface BankFeedTransaction {
  readonly externalId: string;
  readonly postedDate: string;
  readonly valueDate: string | null;
  readonly amountMinor: string;
  readonly description: string;
  readonly counterparty: string | null;
}

/**
 * A live bank feed (OB-227, ROADMAP D-126…D-131) — the concrete shape the M4
 * placeholder deferred to. Behind it, Stripe Financial Connections' session and
 * transaction-refresh calls are normalised to one contract, so the ingest is
 * written against `BankFeedTransaction` and never against a Stripe SDK.
 *
 * Constructed per `bank_feed_connections` **row**, not once per process — each
 * connection carries its own restricted key and linked account, and an org holds
 * one per bank account. So it does not belong in the `Providers` bag below, for
 * the same reason `PaymentProcessorProvider` does not; see `bankFeedProviderFor`
 * in `packages/server/src/providers/bankfeed/`.
 */
export interface BankFeedProvider {
  /** Identifies the backing feed in logs and stored connection records. */
  readonly name: string;
  /** The linked accounts this credential can pull — the setup flow's picker (BYO, D-131). */
  listLinkedAccounts(): Promise<readonly BankFeedAccountRef[]>;
  /**
   * Transactions since `cursor` (`null` for the first pull), the next cursor to
   * persist, and whether more remain. The cursor lives in its own column
   * (D-128) — advanced only on a successful sync — so a live feed never reuses a
   * timestamp as a cursor the way PAY's poll mistakenly did.
   */
  fetchTransactions(input: { readonly cursor: string | null }): Promise<{
    readonly transactions: readonly BankFeedTransaction[];
    readonly cursor: string;
    readonly hasMore: boolean;
  }>;
}

/**
 * Which e-file backend a `ten99_form_runs` row and a `Form1099Provider` both name
 * (OB-228, D-228-7). `manual` is the real, deterministic default the gate exercises: it
 * emits the IRS IRIS-format transmission the org files itself and transmits nothing — no
 * network call, no credential (the D-102 `fake` pattern, applied to a compliance export).
 * `iris` is the deferred real transmitter (IRS IRIS A2A / a vendor like Tax1099), proven
 * only in a manual sandbox.
 */
export type Form1099ProviderKind = 'manual' | 'iris';

/**
 * One recipient's form as the transmitter needs it (OB-228). `amountMinor` is a cents
 * string (D-13) — never a decimal or a float — and `taxIdLast4` is all the TIN the
 * transmission layer sees from this side; the full TIN lives encrypted in
 * `vendor_tax_profiles.tax_id_ciphertext` and is decrypted only at the boundary that
 * hands it to a real e-file vendor, never surfaced to a module or the wire (D-228-2).
 */
export interface Ten99FormData {
  readonly formType: '1099_nec' | '1099_misc';
  readonly boxCode: string;
  readonly amountMinor: string;
  readonly recipientLegalName: string;
  readonly recipientTin: string | null;
  readonly recipientAddress: string | null;
}

/** A built, not-yet-submitted transmission — the IRS-format bytes plus its form count. */
export interface Ten99Transmission {
  readonly taxYear: number;
  readonly formCount: number;
  readonly artifact: Uint8Array;
}

/** The outcome of a submit — a provider ref to poll on and the status it reports. */
export interface Ten99SubmitResult {
  readonly providerRef: string;
  readonly status: Ten99FilingStatus;
}

/** Where a submitted run stands with the transmitter; `ready_to_file` is `manual`'s terminal state. */
export type Ten99FilingStatus = 'ready_to_file' | 'submitted' | 'accepted' | 'rejected';

/** Already-decrypted per-connection settings the caller hands in, never read from a row here. */
export interface Form1099AdapterDeps {
  readonly apiKey: string | null;
  readonly environment: 'sandbox' | 'production';
  readonly appBaseUrl?: string;
}

/**
 * The 1099 e-file seam (OB-228, D-228-7) — the same per-selection adapter idiom as
 * `PaymentProcessorProvider` / `BankFeedProvider`, so `form1099ProviderFor(kind, deps)`
 * picks the backend and a new vendor id does not compile until it has an adapter. The
 * `manual` adapter drives the gate and transmits nothing; a real one calls its vendor over
 * global `fetch`, never an SDK.
 */
export interface Form1099Provider {
  /** Identifies the backing transmitter in logs and stored run records. */
  readonly name: string;
  /** Serialise the year's forms into the transmitter's upload format (IRIS for `manual`). */
  buildTransmission(input: {
    readonly taxYear: number;
    readonly forms: readonly Ten99FormData[];
  }): Promise<Ten99Transmission>;
  /** Submit a built transmission. `manual` is a no-op returning `ready_to_file` + the artifact. */
  submit(transmission: Ten99Transmission): Promise<Ten99SubmitResult>;
  /** Poll a prior submission by its provider ref. */
  getStatus(providerRef: string): Promise<Ten99FilingStatus>;
}

/**
 * OCR bill capture (initiative O, OB-185…191). One line of a document extraction —
 * everything the deterministic parser or a real OCR/LLM call can read off an item
 * row, and nothing it has to compute. `unitAmountMinor` is a string of minor units
 * (D-13) even before it reaches a schema: the provider boundary is where a decimal
 * amount would first be invented, so the contract refuses the shape from its own
 * return type rather than trusting every future adapter to remember.
 */
export interface ExtractedBillLine {
  readonly description: string | null;
  readonly quantity: string;
  readonly unitAmountMinor: string;
}

/**
 * The structured read of one uploaded or emailed bill (D-13's money and D-17's
 * date conventions carried into the provider boundary). This is a *proposal*, not
 * a posting — nothing here creates a bill on its own; `document_captures` stages
 * it for a human to review (see the capture service contract, `modules/bills/capture`).
 * Every field is nullable except `lines` for the reason `document_captures`'
 * extracted columns are nullable: extraction routinely fails to read a field, and
 * "unknown" has to be representable rather than forcing an adapter to guess.
 */
export interface ExtractedBill {
  readonly vendorName: string | null;
  readonly issueDate: string | null;
  readonly reference: string | null;
  readonly totalMinor: string | null;
  readonly taxMinor: string | null;
  readonly lines: readonly ExtractedBillLine[];
}

/**
 * Turns the bytes of an uploaded or emailed document into a structured proposal.
 * The narrowest surface a deterministic self-host parser and a hosted LLM call can
 * both satisfy (D-07's rule, restated at the top of this file): `extract` takes
 * only what every implementation needs — the bytes and their declared content
 * type — and returns only what the review screen needs to hydrate a form.
 */
export interface DocumentExtractionProvider {
  extract(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<ExtractedBill>;
}

/** One file carried by an inbound email message (initiative O). */
export interface InboundEmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

/**
 * An inbound email, normalized from whatever the receiving provider's webhook
 * shape was. `to` is what resolves the org — see `orgs.inbound_email_token`
 * (`0001_tenancy`) — and is carried here rather than resolved by the provider
 * itself, because address-to-org resolution is application data the provider has
 * no business holding.
 */
export interface InboundEmailMessage {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly attachments: readonly InboundEmailAttachment[];
}

/**
 * Parses and verifies a raw inbound-mail webhook into a normalized message. The
 * hosted adapter (`ses-inbound`) verifies the request actually came from the mail
 * receiver before trusting it; the self-host `dev` adapter does not, because there
 * is no receiver in front of it to spoof (see `providers/inbound-mail/dev.ts`).
 * Throwing on an unverified or unparsable payload, rather than returning null, is
 * deliberate: the inbound route has no session to fall back to, so a bad webhook
 * is a request failure, not a value the caller has to remember to check.
 */
export interface InboundMailProvider {
  parse(raw: {
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body: Uint8Array;
  }): Promise<InboundEmailMessage>;
}

/**
 * Which processor a `processor_connections` row and a `PaymentProcessorProvider`
 * instance both name (initiative J). `fake` is not a test double bolted onto
 * the union — it is the third, real, deterministic implementation the gate
 * exercises in place of a network call to Stripe or Square (D-102); see
 * `createFakePaymentProcessor` in `packages/server/src/providers/payment/fake.ts`.
 */
export type ProcessorKind = 'stripe' | 'square' | 'fake';

/**
 * One normalized event off a payment processor's webhook or poll feed
 * (initiative J, ROADMAP D-82…D-86). Stripe and Square each report charges,
 * fees, refunds, disputes and payouts on their own divergent schemas; this is
 * the shape every adapter normalises onto, so the clearing-account posting
 * model (D-82) and the webhook receiver (D-85) are written once, against one
 * contract, the way `ExtractedBill` is one shape two extraction adapters both
 * produce.
 *
 * Two ids and two reasons, not one: `externalEventId` is the delivery — a
 * webhook redelivers, so an idempotency check keyed on it collapses a replay
 * to one write (F9). `externalObjectId` is the charge/refund/payout itself —
 * a poll and a webhook can both report the *same object*, arriving as two
 * different deliveries, so the object id is what `external_refs` correlates
 * to an OpenBooks entity. Money is always a cents string end to end (D-13);
 * nothing at this boundary is ever a decimal or a float.
 */
export interface NormalizedProcessorEvent {
  readonly kind: 'charge' | 'fee' | 'refund' | 'dispute' | 'payout';
  /** The processor's own event/delivery id — event-level idempotency (F9). */
  readonly externalEventId: string;
  /** The charge/refund/payout object id — object-level idempotency (`external_refs`). */
  readonly externalObjectId: string;
  /**
   * The invoice this event pays, read from the checkout session's own
   * metadata (D-83) — certain identity, not a guess, which is what makes
   * auto-allocation legitimate here and nowhere else in the system. `null`
   * for a payout or a dispute, neither of which names one invoice.
   */
  readonly invoiceId: string | null;
  /** Cents string (D-13). */
  readonly grossMinor: string;
  /** Cents string, the processor's per-charge fee (D-104/D-84); `null` where none applies. */
  readonly feeMinor: string | null;
  /** Cents string, a payout's net amount; `null` outside a payout event. */
  readonly netMinor: string | null;
  /** ISO-8601 instant, when the processor recorded the event. */
  readonly occurredAt: string;
}

/** A hosted-checkout link (D-83): where the pay-link on the hosted invoice page redirects. */
export interface ProcessorCheckoutLink {
  readonly url: string;
  readonly sessionId: string;
}

/**
 * The reporting categories a payout breaks down into (OB-237, D-237-6) — the
 * account-mapping key. Stripe reports each underlying balance transaction with a
 * `reporting_category`; an adapter buckets the many raw values Stripe uses into
 * these six the summary-journal builder knows how to place. `charge` credits
 * revenue, `fee` debits the fee account, `refund` debits contra-revenue, `tax`
 * credits Sales Tax Payable (only present when the org uses Stripe Tax), `dispute`
 * debits a loss account, `adjustment` is the catch-all.
 */
export type PayoutReportingCategory =
  'charge' | 'refund' | 'fee' | 'tax' | 'dispute' | 'adjustment';

/** One reporting-category total within a payout — a non-negative magnitude (D-237-4). */
export interface PayoutCategoryAmount {
  readonly reportingCategory: PayoutReportingCategory;
  /** Non-negative magnitude for this category, a cents string (D-13) — the builder assigns the side. */
  readonly amountMinor: string;
  /** How many underlying balance transactions rolled into this total. */
  readonly count: number;
}

/**
 * One payout's grossed-up breakdown (OB-237). The bare Payout object carries only
 * the net `amount`; this is the aggregation an adapter builds from the underlying
 * balance transactions (`GET /v1/balance_transactions?payout=po_…`, D-237-4). The
 * summary-journal builder turns it into one balanced draft: `netMinor` is the
 * clearing-account plug (what the deposit will later reconcile against), and each
 * category is a line whose side the builder knows. Money is always a cents string
 * (D-13); nothing here is a decimal or a float.
 */
export interface PayoutBreakdown {
  readonly payoutId: string;
  /** The payout's net transfer amount — the clearing plug. Cents string (D-13). */
  readonly netMinor: string;
  readonly currency: string;
  /** ISO-8601 instant the payout was made. */
  readonly occurredAt: string;
  readonly categories: readonly PayoutCategoryAmount[];
}

/**
 * The AR inbound-rail mirror of the AP disbursement rails (D-67, D-86) — the
 * new D-07 provider for initiative J. Behind it, Stripe's and Square's
 * divergent checkout and webhook shapes are normalised to one contract, so
 * the clearing-account posting model and the webhook receiver are written
 * against `NormalizedProcessorEvent` and never against a processor SDK.
 *
 * Constructed per processor **connection**, not once per process — see the
 * comment on `Providers` below for why it does not belong in that bag.
 */
export interface PaymentProcessorProvider {
  /**
   * Opens a hosted-checkout session for one invoice (D-83). The invoice id
   * travels in `metadata` so the processor hands it back on the resulting
   * webhook event — the certain identity `NormalizedProcessorEvent.invoiceId`
   * carries.
   */
  createCheckoutLink(input: {
    readonly invoiceId: string;
    readonly amountMinor: string;
    readonly currency: string;
    readonly returnUrl: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<ProcessorCheckoutLink>;
  /**
   * Verifies the inbound webhook's signature and normalises its body.
   * Throws on a signature that does not verify — the caller has no session to
   * fall back to, so an unverified webhook is a request failure, not a value
   * to remember to check (the same contract `InboundMailProvider.parse` keeps).
   */
  verifyAndParseWebhook(input: {
    readonly rawBody: Uint8Array;
    readonly signatureHeader: string;
  }): Promise<NormalizedProcessorEvent>;
  /** The processor's own reported available balance — the D-85 poll's reconciliation target. */
  fetchBalanceMinor(): Promise<string>;
  /**
   * The D-85 polling backstop: events since `cursor` (`null` for the
   * beginning), and the next cursor.
   */
  listEventsSince(cursor: string | null): Promise<{
    readonly events: readonly NormalizedProcessorEvent[];
    readonly cursor: string;
  }>;
  /**
   * One payout's grossed-up breakdown (OB-237, D-237-4): the underlying
   * balance transactions, aggregated by `reporting_category`. The bare payout
   * object carries only the net `amount`, so a summary-sales journal that
   * grossed up sales, fees and refunds cannot be built from a `payout` event
   * alone — this is the follow-up fetch that supplies the detail. Money is
   * always a cents string (D-13).
   */
  fetchPayoutBreakdown(payoutId: string): Promise<PayoutBreakdown>;
}

export interface Providers {
  readonly queue: QueueProvider;
  readonly storage: StorageProvider;
  readonly secrets: SecretsProvider;
  readonly email: EmailProvider;
  // `BankFeedProvider` is deliberately not a member here (OB-227). Like
  // `PaymentProcessorProvider` below, a live feed is constructed per
  // `bank_feed_connections` row — each carries its own restricted key and linked
  // account — not resolved once at process start; see `bankFeedProviderFor` in
  // `packages/server/src/providers/bankfeed/`.
  /** Absent before initiative O. */
  readonly documentExtraction?: DocumentExtractionProvider;
  /** Absent before initiative O. */
  readonly inboundMail?: InboundMailProvider;
  // `PaymentProcessorProvider` is deliberately not a member here (initiative J).
  // Every provider above is process-wide — one storage adapter, one queue —
  // but a processor connection carries its own secret key, webhook secret and
  // clearing/fee accounts, and an org can hold more than one (Stripe and
  // Square at once). So it is constructed per `processor_connections` row,
  // not resolved once at process start; see `paymentProcessorFor` in
  // `packages/server/src/providers/payment/`.
}
