import { Kysely, MysqlDialect } from 'kysely';
import { createPool, type Pool } from 'mysql2';

/**
 * Connection parameters for a MySQL 8 database.
 *
 * Deliberately a plain value type rather than a reference to the resolved config
 * object: migrations connect as `openbooks_migrator` and the application connects
 * as `openbooks_app` (spec §12), so callers supply different credentials against
 * the same shape.
 */
export interface DatabaseConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit?: number;
}

export function createDatabasePool(config: DatabaseConnectionConfig): Pool {
  return createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit ?? 10,
    waitForConnections: true,
    supportBigNumbers: true,
    decimalNumbers: false,
    // DATE is a calendar date; DATETIME is an instant. Keeping DATE as a string
    // is not fussiness — building a JS Date from '2026-07-15' applies a timezone
    // to a value that has none, which is how an entry_date lands in the wrong
    // fiscal period. DATETIME(3) values are real instants and are left as Dates.
    dateStrings: ['DATE'],
    timezone: 'Z',
    // Money is BIGINT minor units end to end (spec §12), and journal_lines.id is
    // BIGINT too. mysql2's default for BIGINT is a JavaScript number, and even
    // with supportBigNumbers it returns a number when the value happens to fit
    // and a string when it does not — a type that varies with the data is worse
    // than either. This forces every BIGINT to bigint, uniformly.
    typeCast: (field, next) => {
      if (field.type === 'LONGLONG') {
        const raw = field.string();
        return raw === null ? null : BigInt(raw);
      }
      return next();
    },
    charset: 'utf8mb4',
    multipleStatements: false,
  });
}

/**
 * Builds a Kysely instance over a pool.
 *
 * Generic in the schema type so the migrator can use a loose schema while the
 * application uses the generated `DB`. This function is intentionally not the
 * public database entrypoint — see `src/db/client.ts` for why the raw instance
 * stays module-private (spec §4).
 */
export function createKyselyOverPool<Schema = unknown>(pool: Pool): Kysely<Schema> {
  return new Kysely<Schema>({
    dialect: new MysqlDialect({ pool }),
  });
}
