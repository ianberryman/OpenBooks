import type { EventBus, EventOf, OpenBooksEventName } from './events';
import type { McpToolDefinition } from './mcp';
import type { ModuleMigration } from './migrations';
import type { PermissionDefinition } from './permissions';
import type { Providers } from './providers';
import type { RouteDefinition } from './routes';
import type { ServiceRegistry } from './registry';

/**
 * What the host hands a module during registration. Notably not a database
 * handle: a module that needs data resolves the owning service (spec §4, D-01).
 */
export interface ModuleHost {
  readonly services: ServiceRegistry;
  readonly events: EventBus;
  readonly providers: Providers;
}

export interface EventSubscription<TName extends OpenBooksEventName = OpenBooksEventName> {
  readonly event: TName;
  /** Method syntax for the same bivariance reason as `RouteDefinition.handler`. */
  handle(event: EventOf<TName>): Promise<void>;
}

/**
 * The single thing a module exports. The host reads it to wire migrations,
 * permissions, services, routes, MCP tools, and event subscriptions — so adding a
 * capability to a module is a change to one object, and the host never needs to
 * know a module's internal file layout (spec §8).
 *
 * Every collection is optional because most modules use a subset: the ledger
 * kernel contributes migrations and a service, a reporting module contributes
 * only routes.
 */
export interface ModuleDefinition<TMigrationDatabase = unknown> {
  /**
   * Namespace for this module's permission keys, event names, service tokens, and
   * migration ids. Collisions across modules are a host-level error at boot.
   */
  readonly id: string;
  readonly migrations?: readonly ModuleMigration<TMigrationDatabase>[];
  readonly permissions?: readonly PermissionDefinition[];
  readonly routes?: readonly RouteDefinition[];
  readonly mcpTools?: readonly McpToolDefinition[];
  readonly subscriptions?: readonly EventSubscription[];
  /**
   * Registers this module's service implementations. Called once at boot, before
   * routes are mounted, and synchronous on purpose: a module that needs I/O to
   * describe itself is a module whose boot ordering has become load-bearing.
   */
  register?(host: ModuleHost): void;
}
