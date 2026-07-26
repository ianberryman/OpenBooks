/**
 * PLACEHOLDER — implemented by OB-005 alongside the Money primitive.
 *
 * The rule and the branded `Money` type are one unit: the rule is type-aware and
 * keys off the brand, so it cannot be written before the brand exists. This file
 * exists now only so the flat config can reference the rule name without the
 * plugin failing to load. It reports nothing.
 *
 * OB-005 replaces this body with the real implementation:
 *   - ban `+ - * / % **` and compound assignment where an operand is Money
 *     (arithmetic must go through the money helpers)
 *   - ban `Math.*` on Money
 *   - ban implicit Number(...) / unary + coercion of Money
 *   - ban `number` in any declared Money position
 *
 * @type {import('eslint').Rule.RuleModule}
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
        'Float arithmetic on money. Money is bigint minor units end to end (spec §12); ' +
        'use the helpers in @openbooks/shared-types/money.',
      numberCoercion:
        'Coercing money to number loses precision. Money is bigint minor units end to end ' +
        '(spec §12); format at the boundary instead.',
    },
  },
  create() {
    return {};
  },
};
