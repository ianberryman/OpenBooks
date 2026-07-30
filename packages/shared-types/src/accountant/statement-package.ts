import { z } from 'zod';

import { reportBasisSchema } from '../reports';
import { calendarDateSchema } from '../wire';

/**
 * The statement-package wire contract (initiative P, OB-195; ROADMAP P5).
 *
 * A branded P&L / Balance Sheet / Cash Flow bundle rendered to one PDF for a date
 * range, stored behind the `StorageProvider` (the INV foundation) and recorded in
 * `statement_packages` (append-only) so it is re-downloadable and audited. Gated by
 * `reports.read` — it renders reports the holder can already run.
 */

/**
 * The render request: a date range and an optional reporting basis. A range rather
 * than a single period so a package can cover a quarter or a year; the three
 * statements are run over `[periodStart, periodEnd]`. `basis` absent means the org's
 * `default_reporting_basis` (the same convention every report takes).
 */
export const createStatementPackageRequestSchema = z
  .strictObject({
    periodStart: calendarDateSchema,
    periodEnd: calendarDateSchema,
    basis: reportBasisSchema.optional().meta({
      description: 'Overrides the org default for this package. Absent uses the org’s basis.',
    }),
  })
  .meta({
    id: 'CreateStatementPackageRequest',
    description: 'Renders a branded P&L / Balance Sheet / Cash Flow bundle to a single PDF (P5).',
  });

export type CreateStatementPackageRequest = z.infer<typeof createStatementPackageRequestSchema>;

/**
 * One rendered package. `downloadUrl` is a freshly-minted `StorageProvider` signed
 * URL, so it is signed at read time and short-lived — the create response and every
 * list row carry one, which is why there is no separate id-addressed download route.
 * `generatedBy` resolves the author's display name for the accountant's list.
 */
export const statementPackageSchema = z
  .strictObject({
    id: z.uuid(),
    periodStart: calendarDateSchema,
    periodEnd: calendarDateSchema,
    basis: reportBasisSchema,
    downloadUrl: z.string().meta({
      description: 'A short-lived signed URL to the stored PDF, minted on read.',
    }),
    generatedByUserId: z.uuid(),
    generatedByName: z.string().nullable().meta({
      description: 'The author’s display name, or null if the user no longer resolves.',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'StatementPackage', description: 'A rendered statement package and its artifact.' });

export type StatementPackage = z.infer<typeof statementPackageSchema>;

/** The envelope convention: newest first, unpaginated in v1. */
export const statementPackageListSchema = z
  .strictObject({
    packages: z.array(statementPackageSchema),
  })
  .meta({
    id: 'StatementPackageList',
    description: 'The org’s rendered statement packages, newest first.',
  });

export type StatementPackageList = z.infer<typeof statementPackageListSchema>;
