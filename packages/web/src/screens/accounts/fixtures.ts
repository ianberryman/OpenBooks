import { ApiError } from '../../api';
import type { ApiErrorCode } from '../../api';
import type { Account } from './accounts-api';

/**
 * Fixtures for this folder's tests.
 *
 * `ApiError` is built from a real envelope rather than by setting `code` alone, because
 * every refusal this screen renders reads `error.body.error.details` — the structured half
 * the generated types describe as `{ [key: string]: unknown }`. A fixture that skipped the
 * envelope would exercise the narrowing in `refusal.tsx` against a shape the server never
 * sends, and the tests would pass for a screen that renders nothing.
 */
export function account(overrides: Partial<Account> = {}): Account {
  return {
    id: '2f9d4a54-1c7e-4a0d-9f3f-1a8d0f6b2c11',
    code: '1000',
    name: 'Operating bank account',
    type: 'asset',
    normalBalance: 'debit',
    parentAccountId: null,
    description: null,
    isActive: true,
    createdAt: '2026-01-04T09:00:00.000Z',
    updatedAt: '2026-01-04T09:00:00.000Z',
    ...overrides,
  };
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(status, code, message, {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

/** The refusal `deleteAccount` gives for an account the ledger points at. */
export function hasPostingsError(): ApiError {
  return apiError(
    412,
    'precondition_failed',
    'This account is referenced by at least one journal line and cannot be deleted. ' +
      'Deactivate it instead: an inactive account keeps its history and cannot be selected ' +
      'for new postings.',
    { precondition: 'account_has_postings' },
  );
}

/** The refusal `applyChartTemplate` gives when the org already holds some of the codes. */
export function templateCollisionError(codes: readonly string[]): ApiError {
  return apiError(
    409,
    'conflict',
    `This organization already uses ${String(codes.length)} of the account codes in the ` +
      '"General small business" template, so none of it was applied: ' +
      `${codes.join(', ')}. Delete or renumber what collides, or create the remaining ` +
      'accounts individually.',
    { codes: [...codes] },
  );
}
