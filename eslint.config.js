import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import openbooks from '@openbooks/eslint-plugin';

/**
 * Flat config. Composed centrally rather than per-package so the boundary rules
 * (which are inherently cross-package) live in one place.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.yarn/**',
      'infra/**',
      // Generated. Owned by their generators, never hand-edited.
      'packages/server/src/db/generated.ts',
      'packages/web/src/api/schema.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling files belong to no package tsconfig.
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            '.dependency-cruiser.cjs',
            'scripts/*.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { openbooks },
    rules: {
      // Unused vars are an error, with the conventional underscore escape.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Spec §12 treats agent and integrator input as untrusted; `any` erases
      // the Zod-validated boundary that makes that safe.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // Floating promises in a financial write path lose errors silently.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',

      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-param-reassign': 'error',

      // Redundant under TypeScript, and it cannot see type-only globals.
      'no-undef': 'off',
    },
  },

  // --- Money (OB-005) -------------------------------------------------------
  {
    files: ['packages/{server,shared-types}/**/*.ts'],
    rules: {
      'openbooks/no-float-money': 'error',
    },
  },

  // --- Environment access (OB-003) ------------------------------------------
  // Only the config module may read process.env; everything else consumes the
  // validated, frozen config object.
  {
    files: ['packages/**/*.{ts,js}'],
    rules: {
      'openbooks/no-process-env': 'error',
    },
  },
  {
    files: [
      'packages/server/src/config/**/*.ts',
      'scripts/**/*.mjs',
      'packages/server/test/**/*.ts',
      'vitest.config.ts',
      // Build tooling, like the two entries above it. A Vite config runs in Node
      // before any application exists and cannot consume the server's validated
      // config — that module lives in another package and importing it would pull
      // the server into the web build. What it reads is the dev proxy's target,
      // which is a fact about the developer's machine rather than about the
      // running system.
      'packages/web/vite.config.ts',
    ],
    rules: {
      'openbooks/no-process-env': 'off',
    },
  },

  // --- Journal write path (OB-020) ------------------------------------------
  {
    files: ['packages/server/**/*.ts'],
    rules: {
      'openbooks/no-journal-writes': [
        'error',
        {
          allow: [
            'packages/server/src/modules/ledger/posting.repository.ts',
            'packages/server/src/db/migrations/',
            // Test factories build ledger fixtures directly. They are the one
            // legitimate second writer: a factory that went through the posting
            // service could not construct the invalid states the enforcement
            // tests exist to reject. Listed here rather than as a file-scoped
            // disable so every exemption to this rule is visible in one place.
            'packages/server/test/db/factories.ts',
          ],
        },
      ],
    },
  },

  // --- Design tokens (OB-046) -----------------------------------------------
  // D-24: colour is defined once, in the token layer, and reached through a role token.
  // The `allow` list is a directory rather than a file because the exemption belongs to
  // whatever defines tokens, not to a particular name — today that is `tokens.css`, which
  // ESLint does not parse at all, so the entry earns its keep the moment a JS-side token
  // module appears (a chart palette is the likely first one).
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    rules: {
      'openbooks/no-raw-color': ['error', { allow: ['packages/web/src/styles/'] }],
    },
  },

  // --- Tests ----------------------------------------------------------------
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      // Tests deliberately construct invalid input to prove it is rejected.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // --- Lint rules are authored in JS ----------------------------------------
  {
    files: ['packages/eslint-plugin/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  // --- Root tooling ---------------------------------------------------------
  // Build and config scripts sit outside every package tsconfig, so the type
  // information the type-checked rules need is not available for them. Linting
  // them for style is useful; linting them for types is noise.
  {
    files: ['eslint.config.js', 'vitest.config.ts', '.dependency-cruiser.cjs', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },
);
