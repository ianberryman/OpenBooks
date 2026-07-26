/**
 * The one failure mode of config resolution.
 *
 * Spec §3 asks for startup validation that fails fast "with a precise message
 * naming the missing variables". A raw Zod dump is not that: it is shaped for
 * request validation, mentions paths and codes, and buries the variable name.
 * So issues are collected into a flat list keyed by env var name and rendered
 * as something an operator can act on without reading the schema.
 */
export interface ConfigIssue {
  /** Env var name, so the message can be grepped against `.env.example`. */
  readonly variable: string;
  readonly message: string;
  /**
   * Present when the variable is required only because of a provider choice.
   * Carrying the selector as well as the provider matters: the operator's fix
   * is either to set the variable or to change the selector, and they cannot
   * choose without knowing which selector pulled the requirement in.
   */
  readonly requiredBy?: {
    readonly selector: string;
    readonly provider: string;
  };
}

function render(issue: ConfigIssue): string {
  const because =
    issue.requiredBy === undefined
      ? ''
      : ` — required by ${issue.requiredBy.selector}=${issue.requiredBy.provider}`;
  return `  ${issue.variable}: ${issue.message}${because}`;
}

export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const count = `${issues.length} problem${issues.length === 1 ? '' : 's'}`;
  return [
    `Invalid environment configuration (${count}):`,
    '',
    ...issues.map(render),
    '',
    'Set the variables listed above, or select a different provider. See .env.example.',
  ].join('\n');
}

export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(issues));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}
