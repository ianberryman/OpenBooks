/**
 * Scalar shapes shared across the contract.
 *
 * These are aliases, not branded types. The branded `Money` lives in the
 * server's money module (OB-005) and plugin-api may not depend on it — spec §8
 * makes the contract a leaf. A branded bigint is assignable to `MinorUnits`, so
 * the kernel keeps its brand and this file keeps its independence. If M2 finds
 * that the brand needs to cross the contract boundary, the brand moves here;
 * the dependency never goes the other way.
 */

/** Integer minor units. Spec §2.3 admits no float on a money path, ever. */
export type MinorUnits = bigint;

/**
 * `YYYY-MM-DD`. An accounting date is a calendar date, not an instant — a
 * `Date` here would make which fiscal period a journal lands in depend on the
 * reader's timezone.
 */
export type CalendarDate = string;

/** ISO 8601 instant in UTC. Wall-clock time of a system event, not an accounting date. */
export type Instant = string;
