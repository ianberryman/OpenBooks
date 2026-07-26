/**
 * Is `name` bound by a declaration visible from this scope?
 *
 * Walks the scope chain directly rather than using a helper from
 * @typescript-eslint/utils, whose Scope type is a different nominal type from
 * the one `eslint` hands back here.
 *
 * @param {import('eslint').Scope.Scope | null} scope
 * @param {string} name
 * @returns {boolean}
 */
function hasLocalBinding(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((candidate) => candidate.name === name);
    if (variable) return variable.defs.length > 0;
  }
  return false;
}

/**
 * Bans `process.env` outside the config module.
 *
 * Spec §3 requires startup config validation that fails fast when a selected
 * provider's required variables are missing. That guarantee only holds if every
 * environment read goes through the validated config object — a single stray
 * `process.env.FOO` elsewhere is an unvalidated input that bypasses it.
 *
 * Resolves `process` through scope analysis so a local binding of that name is
 * not reported. Shadowing the global would defeat the rule, but nothing in this
 * codebase does that, and false positives on unrelated locals are worse than a
 * bypass that shows up plainly in review.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noProcessEnv = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct process.env access; read from the validated config module instead',
    },
    schema: [],
    messages: {
      noProcessEnv:
        'Do not read process.env directly. Import the validated config from src/config instead, ' +
        'so the variable is declared in the env schema and validated at startup (spec §3).',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type !== 'Identifier' ||
          node.object.name !== 'process' ||
          node.computed ||
          node.property.type !== 'Identifier' ||
          node.property.name !== 'env'
        ) {
          return;
        }

        // A `process` with its own definition is a local, not the Node global.
        if (hasLocalBinding(context.sourceCode.getScope(node), 'process')) return;

        context.report({ node, messageId: 'noProcessEnv' });
      },
    };
  },
};
