/**
 * `resource.action`, e.g. `invoices.write`. A template literal rather than a
 * closed union because the catalog is assembled from every module's
 * declarations; OB-016 narrows it to the concrete union once they are collected.
 */
export type PermissionKey = `${string}.${string}`;

/**
 * A module declares the permissions it owns. It does not declare who holds them
 * — role seeding is the host's job (OB-010), precisely so that installing a
 * module cannot quietly widen an existing role.
 */
export interface PermissionDefinition {
  readonly key: PermissionKey;
  /**
   * Written for the org owner choosing whether to grant it in the role editor
   * (M2), not for a developer reading the source.
   */
  readonly description: string;
}
