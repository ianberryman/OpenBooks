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

export interface Providers {
  readonly queue: QueueProvider;
  readonly storage: StorageProvider;
  readonly secrets: SecretsProvider;
  readonly email: EmailProvider;
  /** Absent before M4. */
  readonly bankFeed?: BankFeedProvider;
}
