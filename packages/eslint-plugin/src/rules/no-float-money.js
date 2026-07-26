import { ESLintUtils } from '@typescript-eslint/utils';

/**
 * Marker for the `Money` brand from `@openbooks/shared-types`.
 *
 * The brand is a `unique symbol` property, which TypeScript names
 * `__@moneyBrand@<id>` internally, so this matches on a substring rather than an
 * exact name. Detection is structural on purpose: a type alias called `Money` in
 * some other package is not this type, and a re-alias of the real one still
 * carries the brand.
 */
const MONEY_BRAND_MARKER = 'moneyBrand';

const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '**']);
const COMPOUND_ASSIGNMENT_OPERATORS = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

/**
 * Does this type carry the money brand?
 *
 * @param {import('typescript').Type} type
 * @returns {boolean}
 */
function hasMoneyBrand(type) {
  if (type.isUnionOrIntersection()) {
    // `bigint & Brand` is an intersection; `Money | undefined` is a union whose
    // money constituent is still money.
    if (type.types.some(hasMoneyBrand)) return true;
  }
  return type.getProperties().some((property) => property.getName().includes(MONEY_BRAND_MARKER));
}

/**
 * Bans raw arithmetic and number coercion on money-typed expressions.
 *
 * Spec §12 makes money `BIGINT` minor units end to end and §11 requires a lint
 * rule banning float operations on money paths. The helpers in
 * `@openbooks/shared-types` are exact by construction, so the value of this rule
 * is that it makes the unsafe spelling unavailable: `a + b` on money is not
 * wrong today (bigint addition is exact), but `a * 1.1` is, `Number(a)` is, and
 * `Math.round(a)` is. Rather than trying to separate the safe operators from the
 * unsafe ones, the rule bans all of them so that every money computation goes
 * through a helper — which is also where the single rounding point lives.
 *
 * A `number` in a declared `Money` position is deliberately *not* checked here:
 * `Money` is branded over `bigint`, so `number` is already not assignable to it
 * and the compiler reports it. Duplicating that would report the same mistake
 * twice with a worse message.
 *
 * The rule is type-aware, so it only reports where type information exists. The
 * flat config enables it for `packages/{server,shared-types}/**\/*.ts`, all of
 * which are covered by a package tsconfig.
 *
 * @type {import('@typescript-eslint/utils').TSESLint.RuleModule<'floatArithmetic' | 'mathOnMoney' | 'numberCoercion', []>}
 */
export const noFloatMoney = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow float arithmetic and number coercion on money-typed values',
    },
    schema: [],
    messages: {
      floatArithmetic:
        "Operator '{{operator}}' applied to money. Money is bigint minor units end to end " +
        '(spec §12); use the helpers in @openbooks/shared-types (add, subtract, negate, sum, ' +
        'scale, allocate).',
      mathOnMoney:
        "'Math.{{method}}' operates on doubles, so it cannot take money. Money is bigint minor " +
        'units end to end (spec §12); use abs / compare / scale from @openbooks/shared-types.',
      numberCoercion:
        'Coercing money to number loses precision. Money is bigint minor units end to end ' +
        '(spec §12); format at the boundary instead (toDecimalString, toMinorString).',
    },
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    /**
     * @param {import('@typescript-eslint/utils').TSESTree.Node} node
     * @returns {boolean}
     */
    function isMoney(node) {
      const type = services.getTypeAtLocation(node);
      // A type parameter carries the brand on its constraint, not on itself.
      return hasMoneyBrand(checker.getBaseConstraintOfType(type) ?? type);
    }

    return {
      BinaryExpression(node) {
        if (!ARITHMETIC_OPERATORS.has(node.operator)) return;
        if (!isMoney(node.left) && !isMoney(node.right)) return;
        context.report({
          node,
          messageId: 'floatArithmetic',
          data: { operator: node.operator },
        });
      },

      AssignmentExpression(node) {
        if (!COMPOUND_ASSIGNMENT_OPERATORS.has(node.operator)) return;
        if (!isMoney(node.left) && !isMoney(node.right)) return;
        context.report({
          node,
          messageId: 'floatArithmetic',
          data: { operator: node.operator },
        });
      },

      UnaryExpression(node) {
        if (!isMoney(node.argument)) return;
        if (node.operator === '+') {
          // Unary plus is the classic silent coercion: `+money` asks for a double.
          context.report({ node, messageId: 'numberCoercion' });
        } else if (node.operator === '-') {
          context.report({ node, messageId: 'floatArithmetic', data: { operator: '-' } });
        }
      },

      UpdateExpression(node) {
        if (!isMoney(node.argument)) return;
        context.report({ node, messageId: 'floatArithmetic', data: { operator: node.operator } });
      },

      CallExpression(node) {
        const { callee } = node;

        if (callee.type === 'Identifier' && callee.name === 'Number') {
          if (node.arguments.some(isMoney)) {
            context.report({ node, messageId: 'numberCoercion' });
          }
          return;
        }

        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Math' &&
          callee.property.type === 'Identifier' &&
          node.arguments.some(isMoney)
        ) {
          context.report({
            node,
            messageId: 'mathOnMoney',
            data: { method: callee.property.name },
          });
        }
      },
    };
  },
};
