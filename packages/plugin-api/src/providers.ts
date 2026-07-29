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
}

export interface EmailProvider {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

/**
 * M4 owns this (D-07). It is a placeholder rather than a guess: the real shape
 * follows from whichever aggregator the banking phase selects, and inventing
 * methods now would mean M4 either breaking the contract or working around it.
 */
export interface BankFeedProvider {
  /** Identifies the backing aggregator in logs and stored connection records. */
  readonly name: string;
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

export interface Providers {
  readonly queue: QueueProvider;
  readonly storage: StorageProvider;
  readonly secrets: SecretsProvider;
  readonly email: EmailProvider;
  /** Absent before M4. */
  readonly bankFeed?: BankFeedProvider;
  /** Absent before initiative O. */
  readonly documentExtraction?: DocumentExtractionProvider;
  /** Absent before initiative O. */
  readonly inboundMail?: InboundMailProvider;
}
