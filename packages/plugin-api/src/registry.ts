declare const SERVICE_TYPE: unique symbol;

/**
 * A token is the seam that lets module A call module B without importing its
 * source (spec §8). The service type rides along as a phantom property that is
 * never populated at runtime, so `resolve` infers its return type from the token
 * rather than from a cast at the call site.
 *
 * The phantom is optional so a token can be declared as a plain object literal.
 * The cost is that a bare `{ name }` literal satisfies any `ServiceToken<T>` —
 * the declaration site is where the service type is asserted, and after that
 * point passing the wrong token does not typecheck.
 */
export interface ServiceToken<TService> {
  /** Module-namespaced, e.g. `ledger.posting`. Stable: it is a wiring identifier. */
  readonly name: string;
  readonly [SERVICE_TYPE]?: TService;
}

export interface ServiceRegistry {
  /** Registering a token twice is a wiring bug and should throw, not last-write-win. */
  register<TService>(token: ServiceToken<TService>, service: TService): void;
  /**
   * Throws when unregistered. A missing service is a boot-time wiring error, and
   * returning `undefined` here would push a null check into every call site that
   * can do nothing useful with the absence.
   */
  resolve<TService>(token: ServiceToken<TService>): TService;
  /** For genuinely optional collaborators — an M4 module asking whether banking is present. */
  tryResolve<TService>(token: ServiceToken<TService>): TService | undefined;
}
