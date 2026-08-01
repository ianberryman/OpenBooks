/**
 * Live bank feeds (OB-227; ROADMAP D-126…D-131).
 *
 * An org connects its own Stripe Financial Connections credential (BYO, D-131) to a
 * bank account, and a daily sync pulls transactions into the existing
 * `bank_statement_lines` → match → reconcile pipeline through the same fingerprint
 * dedup the file import uses (D-127). The public surface is the connection lifecycle,
 * the manual sync trigger, and the daily-sweep wiring; the repository and the provider
 * seam stay internal.
 */

export {
  connectBankFeed,
  createBankFeedLinkSession,
  deactivateBankFeed,
  getBankFeed,
  listBankFeeds,
} from './connections.service';

export { runBankFeedSync, syncBankFeed } from './feed-sync.service';
export type { BankFeedSyncDeps } from './feed-sync.service';

export {
  BANK_FEED_SYNC_QUEUE,
  createBankFeedSyncHandler,
  registerBankFeedSyncJob,
} from './feed-sync.job';
