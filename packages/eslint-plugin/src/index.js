import { noProcessEnv } from './rules/no-process-env.js';
import { noFloatMoney } from './rules/no-float-money.js';
import { noJournalWrites } from './rules/no-journal-writes.js';

/**
 * Project-specific lint rules. Each one enforces a guarantee the spec states in
 * prose but that nothing else in the toolchain checks.
 *
 * Rules live here rather than in review conventions because spec §12 lists them
 * as build gates, and a gate a human has to remember is not a gate.
 */
const plugin = {
  meta: {
    name: '@openbooks/eslint-plugin',
    version: '0.0.0',
  },
  rules: {
    'no-process-env': noProcessEnv,
    'no-float-money': noFloatMoney,
    'no-journal-writes': noJournalWrites,
  },
};

export default plugin;
