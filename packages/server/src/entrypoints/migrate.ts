/**
 * Migrate role. Implemented by OB-008.
 */
export type MigrateDirection = 'up' | 'down' | 'status';

export async function runMigrations(_direction: MigrateDirection): Promise<void> {
  await Promise.resolve();
  throw new Error('runMigrations is not implemented yet — OB-008.');
}
