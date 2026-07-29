/**
 * Import-graph boundaries.
 *
 * These enforce the structural rules in spec §2.4 (transport adapters hold zero
 * business logic), §4 (the raw Kysely instance is never exposed to service
 * code), and §8 (modules are built against the plugin-api surface only).
 *
 * ESLint rules check what a file *does*; these check what a file may *reach*.
 * The two are complementary and neither substitutes for the other.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-raw-db-outside-db-module',
      comment:
        'Spec §4: the raw Kysely instance is never exposed to service code — the unsafe path ' +
        'must not exist. Only src/db/** may import the client; everything else uses ' +
        'tenantDb(ctx) or systemDb from src/db.',
      severity: 'error',
      from: {
        path: '^packages/server/src/',
        pathNot: '^packages/server/src/db/',
      },
      to: {
        path: '^packages/server/src/db/client\\.ts$',
      },
    },
    {
      name: 'transport-holds-no-business-logic',
      comment:
        'Spec §2.4: transport adapters hold zero business logic. Routes call services; they do ' +
        'not reach into repositories or the database directly.',
      severity: 'error',
      from: {
        path: '^packages/server/src/transport/',
      },
      to: {
        path: '(\\.repository\\.ts$|^packages/server/src/db/)',
        pathNot: '^packages/server/src/db/index\\.ts$',
      },
    },
    {
      name: 'services-do-not-import-transport',
      comment:
        'Spec §2.4: one service layer, many transports. A service that imports from transport ' +
        'has coupled itself to HTTP and cannot be called from MCP or the workflow engine. ' +
        '`modules/mcp/host.ts` is the one sanctioned exception, carved out narrowly by the ' +
        'paired rule below: D-59 makes it a second transport in its own right, not a service, ' +
        "and it needs the Fastify `App` alias to mount `POST /mcp` on the api role's instance.",
      severity: 'error',
      from: {
        path: '^packages/server/src/modules/',
        pathNot: '^packages/server/src/modules/mcp/host\\.ts$',
      },
      to: { path: '^packages/server/src/transport/' },
    },
    {
      name: 'mcp-host-reaches-only-the-app-type',
      comment:
        'The exception the rule above carves out is narrow on purpose: `host.ts` may take the ' +
        'Fastify `App` alias (`transport/types.ts`) and nothing else from `src/transport/` — no ' +
        'route, no error handler, no schema helper. Enforcement still happens inside each tool ' +
        "handler, exactly as it happens inside each REST route's service call " +
        '(`modules/permissions/index.ts`: "a route that reached for `requirePermission`... would ' +
        'be a second enforcement point, which is the whole thing the rule prevents"); this file ' +
        'only dispatches to that handler and holds no enforcement of its own.',
      severity: 'error',
      from: { path: '^packages/server/src/modules/mcp/host\\.ts$' },
      to: {
        path: '^packages/server/src/transport/',
        pathNot: '^packages/server/src/transport/types\\.ts$',
      },
    },
    {
      name: 'plugin-api-is-a-leaf',
      comment:
        'Spec §8: plugin-api is the contract, not a consumer. It may not depend on any ' +
        'implementation package, or the contract stops being independently meaningful.',
      severity: 'error',
      from: { path: '^packages/plugin-api/' },
      to: { path: '^packages/(server|web|shared-types)/' },
    },
    {
      name: 'web-uses-the-public-api-only',
      comment:
        'Spec §12: the React app consumes the public REST API only, from Phase 0. No internal ' +
        'shortcuts — importing server code would create a second, undocumented contract.',
      severity: 'error',
      from: { path: '^packages/web/' },
      to: { path: '^packages/(server|plugin-api)/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular dependencies make initialization order load-bearing and untestable.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment: 'Unreachable module — either wire it up or delete it.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(eslint|vitest|vite)\\.config\\.(js|ts)$',
          // Process and bundle entrypoints: nothing imports them by design.
          '^packages/server/src/entrypoints/',
          '^packages/web/src/main\\.tsx$',
          // RuleTester needs the fixture to exist inside a TS program for
          // type-aware rules; importing it would defeat the point.
          '^packages/eslint-plugin/test/fixtures/',
          // Vitest `setupFiles` is loaded by the runner, not imported (OB-058).
          '^packages/web/src/test/setup\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'no-dev-deps-in-src',
      comment: 'A devDependency reachable from production source will be absent at runtime.',
      severity: 'error',
      from: {
        path: '^packages/(server|shared-types|plugin-api)/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist|coverage|\\.yarn)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    progress: { type: 'none' },
  },
};
