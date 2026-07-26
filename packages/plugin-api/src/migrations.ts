/**
 * How a module contributes schema.
 *
 * The database handle is a type parameter rather than `Kysely<DB>` because
 * plugin-api may not import the server (spec §8), and because pinning the
 * contract to a query-builder version would turn a Kysely upgrade into a
 * contract change. The host binds it once (OB-008); modules see it already bound.
 */
export interface ModuleMigration<TMigrationDatabase = unknown> {
  /**
   * Sortable, globally unique, and immutable once merged — prefixed with the
   * owning module (`ledger/0001_journals`) so two modules cannot claim the same
   * ordinal. Editing a merged id re-runs or skips a migration depending on the
   * environment, which is the one failure mode a migration runner cannot recover
   * from.
   */
  readonly id: string;
  up(db: TMigrationDatabase): Promise<void>;
  /**
   * Absent means deliberately irreversible. The grant revocations in OB-011 are
   * the example: reinstating `UPDATE` on `journals` to satisfy a symmetry
   * requirement would defeat the point of removing it.
   */
  down?(db: TMigrationDatabase): Promise<void>;
}
