const JOURNAL_TABLES = new Set(['journals', 'journal_lines']);
const WRITE_METHODS = new Set(['insertInto', 'updateTable', 'deleteFrom', 'replaceInto']);

/**
 * Restricts writes to `journals` and `journal_lines` to the posting repository.
 *
 * Spec §2.1 makes the ledger the only holder of financial state and §2.2 makes
 * journals append-only. Both collapse the moment a second code path can insert
 * a posting: validation, balance checks, period locks, and actor provenance all
 * live in the posting repository, so a write that skips it skips all of them.
 *
 * The database also denies UPDATE/DELETE on these tables to the app user, so
 * those cases fail at runtime regardless. This rule catches them at build time,
 * and catches the case the grants cannot — an INSERT from the wrong place.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noJournalWrites = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow writes to journal tables outside the posting repository',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path fragments permitted to write to journal tables.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noJournalWrite:
        "'{{method}}' on '{{table}}' is only permitted in the posting repository. " +
        'Call the posting service instead — it owns balance validation, period locks, ' +
        'and actor provenance (spec §2.1, §2.2).',
    },
  },
  create(context) {
    const options = /** @type {{ allow?: string[] } | undefined} */ (context.options[0]);
    const allow = options?.allow ?? [];
    const filename = context.filename.replaceAll('\\', '/');
    if (allow.some((fragment) => filename.includes(fragment))) {
      return {};
    }

    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        if (!WRITE_METHODS.has(callee.property.name)) return;

        const [firstArg] = node.arguments;
        if (
          firstArg?.type !== 'Literal' ||
          typeof firstArg.value !== 'string' ||
          !JOURNAL_TABLES.has(firstArg.value)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'noJournalWrite',
          data: { method: callee.property.name, table: firstArg.value },
        });
      },
    };
  },
};
