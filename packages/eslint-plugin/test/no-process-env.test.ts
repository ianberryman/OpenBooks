import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noProcessEnv } from '../src/rules/no-process-env.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

describe('no-process-env', () => {
  it('permits validated config reads and rejects direct env access', () => {
    ruleTester.run('no-process-env', noProcessEnv, {
      valid: [
        { code: "import { config } from '../config'; const url = config.database.url;" },
        // A local identifier named `process` is not the global.
        { code: 'const process = { env: {} }; const x = process.env;' },
        // Reading a property literally called `env` off something else is fine.
        { code: 'const x = ctx.env;' },
      ],
      invalid: [
        {
          code: 'const url = process.env.DATABASE_URL;',
          errors: [{ messageId: 'noProcessEnv' }],
        },
        {
          code: 'const { PORT } = process.env;',
          errors: [{ messageId: 'noProcessEnv' }],
        },
        {
          code: "if (process.env.NODE_ENV === 'production') {}",
          errors: [{ messageId: 'noProcessEnv' }],
        },
      ],
    });
  });
});
