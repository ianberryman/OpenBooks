/**
 * The change feed (OB-101; ROADMAP D-56, D-57): a resumable, tenant-scoped read
 * over the `event_log` outbox `modules/events/outbox.ts` writes.
 *
 * Read `change-feed.service.ts` for the design notes — why this is a projection
 * and not a second store, why `requirePermission` runs first, and why
 * `CHANGE_FEED_RETENTION_DAYS` is a documented bound with no pruning job behind it
 * yet.
 *
 * No route lives here. OB-104 owns ids and the HTTP surface; `readChangeFeed` is
 * equally reachable from an MCP tool (M5) or the workflow engine (M6), because it
 * touches no request or reply.
 */
export { CHANGE_FEED_RETENTION_DAYS, readChangeFeed } from './change-feed.service';
