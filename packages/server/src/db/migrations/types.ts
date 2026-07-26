/* eslint-disable @typescript-eslint/no-explicit-any -- see note below */
import type { Kysely } from 'kysely';

/**
 * The database handle a migration receives.
 *
 * Kysely's own `Migration` interface types this as `Kysely<any>`, and it has to:
 * a migration runs against whatever the schema looked like at that point in
 * history, which is by definition not the current generated `DB` type. Typing it
 * against `DB` would make every historical migration break the moment a later
 * migration drops a column.
 *
 * This is the one place in the codebase where `any` is correct, so the disable
 * lives here and nowhere else.
 */
export type MigrationDb = Kysely<any>;
