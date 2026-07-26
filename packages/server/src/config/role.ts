/**
 * Process role resolution.
 *
 * Spec §2.5 requires the same image everywhere. Rather than build three images,
 * one image selects its entrypoint from `OPENBOOKS_ROLE`. Spec §12 additionally
 * requires migrations to run as a discrete pre-deploy job and never on container
 * boot — the `migrate` role is how that separation is expressed, in Compose and
 * in the ECS task definitions alike.
 *
 * This lives under src/config/ because that is the only place permitted to read
 * the environment (enforced by openbooks/no-process-env).
 */
export const PROCESS_ROLES = ['api', 'worker', 'migrate'] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

export class InvalidRoleError extends Error {
  constructor(received: string | undefined) {
    super(
      `OPENBOOKS_ROLE must be one of ${PROCESS_ROLES.join(', ')} — received ${
        received === undefined ? '<unset>' : JSON.stringify(received)
      }.`,
    );
    this.name = 'InvalidRoleError';
  }
}

function isProcessRole(value: string | undefined): value is ProcessRole {
  return PROCESS_ROLES.includes(value as ProcessRole);
}

/**
 * Resolves the role, defaulting to `api`. Fails fast on an unrecognised value
 * rather than silently falling back — a typo'd role in a task definition should
 * stop the deploy, not quietly start the wrong process.
 */
export function resolveRole(env: NodeJS.ProcessEnv = process.env): ProcessRole {
  const raw = env['OPENBOOKS_ROLE'];
  if (raw === undefined || raw === '') return 'api';
  if (!isProcessRole(raw)) throw new InvalidRoleError(raw);
  return raw;
}
