/**
 * Which log fields are secrets.
 *
 * ## Relationship to `src/config/redact.ts`
 *
 * That module owns the same question for the config object and is the reason this
 * one can be short: it establishes the approach (match on the *field name* at any
 * depth, never on a list of paths, so a secret added later is redacted by virtue
 * of being called a secret) and this module applies it to log records.
 *
 * It does not export its field list, and OB-009 may not widen the config module's
 * surface, so the names are restated. They are restated as a deliberate
 * **superset**, not a copy: config holds a database password, a session secret,
 * and nothing else, while a log record carries request headers, session and API
 * tokens, and password hashes — none of which can appear in `Config` and all of
 * which must not appear in a log line. A list that matched config exactly would be
 * wrong here. `test/logging/redact.test.ts` asserts the superset relation holds by
 * running a real config through both, so the two cannot drift into disagreement.
 *
 * ## Substring matching, and why over-redaction is the right failure
 *
 * Matching is a case- and separator-insensitive substring test, so `passwordHash`,
 * `SESSION_TOKEN`, and `set-cookie` are all caught without being enumerated. It
 * over-matches — a field called `tokenCount` is redacted too. That is the correct
 * direction to be wrong in: a redacted counter costs someone a debugging session,
 * a logged bearer token costs a customer their data. Spec §12 makes these logs a
 * durable artifact, so the value is only as protected as the worst line ever
 * written.
 */

const SECRET_FIELD_SUBSTRINGS = [
  // Shared with config/redact.ts — see above.
  'password',
  'secret',
  // Log-only: these travel on requests and sessions, never in Config.
  'token',
  'authorization',
  'cookie',
  'apikey',
  'credential',
  'passphrase',
  'privatekey',
  // Vendor disbursement details (Pay Bills, D-67). A vendor's real bank
  // coordinates — `ach_routing_number`, `ach_account_number`, `wire_instructions`
  // — must never reach a durable log line (spec §12). Matched by their normalized
  // names (`routingnumber`, `accountnumber`, `wireinstruction`); over-redacting a
  // field that merely contains one of these is the correct direction to err, as the
  // header argues.
  'routingnumber',
  'accountnumber',
  'wireinstruction',
  // Taxpayer identifiers (1099 reporting, OB-228, D-228-2). A vendor TIN — EIN/SSN/ITIN —
  // is PII that lives encrypted in `vendor_tax_profiles.tax_id_ciphertext` and only its
  // last four ever crosses the wire; these ensure a full TIN can never reach a durable log
  // line. `taxid` covers every field here (all are `tax_id*`); `ssn` is a rare substring.
  // Bare `tin`/`ein` are deliberately NOT used — they match "routing"/"being"/"meeting"
  // and would over-redact far beyond the intent.
  'taxid',
  'ssn',
] as const;

export const SECRET_LOG_FIELD_SUBSTRINGS: readonly string[] = SECRET_FIELD_SUBSTRINGS;

/** `API_KEY`, `api-key`, and `apiKey` are the same field name for our purposes. */
function normalize(field: string): string {
  return field.toLowerCase().replaceAll(/[-_\s]/gu, '');
}

export function isSecretLogField(field: string): boolean {
  const normalized = normalize(field);
  return SECRET_FIELD_SUBSTRINGS.some((secret) => normalized.includes(secret));
}
