import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';
import { RuleTester, type Rule } from 'eslint';
import { describe, it } from 'vitest';
import { noFloatMoney } from '../src/rules/no-float-money.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const filename = path.join(fixtures, 'file.ts');

/**
 * A type-aware rule needs a real program, so the tester runs the TypeScript
 * parser against the fixture tsconfig.
 *
 * The cast on the rule is the price of the two nominal type universes:
 * `eslint`'s `Rule.RuleModule` and `@typescript-eslint`'s `TSESLint.RuleModule`
 * describe the same runtime object with different declarations. The rule is
 * typed against `@typescript-eslint/utils` because that is what makes the type
 * checker reachable inside it; the assertion is confined to this boundary.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: fixtures,
    },
  },
});

const PRELUDE = [
  "import type { Money } from '@openbooks/shared-types';",
  "import { add, subtract, sum, toMinorUnits } from '@openbooks/shared-types';",
  'declare let a: Money;',
  'declare let b: Money;',
  'declare const line: { amount: Money };',
  'declare const count: bigint;',
  'declare const rate: number;',
  '',
].join('\n');

const valid = (code: string) => ({ code: PRELUDE + code, filename });

const invalid = (
  code: string,
  messageId: 'floatArithmetic' | 'mathOnMoney' | 'numberCoercion',
) => ({
  code: PRELUDE + code,
  filename,
  errors: [{ messageId }],
});

describe('no-float-money', () => {
  it('forces money arithmetic through the helpers', () => {
    ruleTester.run('no-float-money', noFloatMoney as unknown as Rule.RuleModule, {
      valid: [
        // The helpers are the whole point of the ban.
        valid('const total = add(a, b);'),
        valid('const net = subtract(a, b);'),
        valid('const all = sum([a, b]);'),
        // Deliberately unwrapping to bigint is how persistence and the money
        // module's own internals compute; it is visible in review.
        valid('const stored = toMinorUnits(a) + count;'),
        // Arithmetic on values that are not money is none of this rule's business.
        valid('const scaled = count * 2n;'),
        valid('const pct = rate * 0.5;'),
        valid('const idx = 1 + 2;'),
        // Exact comparison of bigints is safe, so it stays legal.
        valid('const cheaper = a < b;'),
        valid('const same = a === b;'),
        valid('const max = Math.max(1, 2);'),
        valid("const parsed = Number('12');"),
        valid('const text = String(a);'),
      ],
      invalid: [
        invalid('const wrong = a + b;', 'floatArithmetic'),
        invalid('const wrong = a - b;', 'floatArithmetic'),
        invalid('const wrong = a * count;', 'floatArithmetic'),
        invalid('const wrong = a / count;', 'floatArithmetic'),
        invalid('const wrong = a % count;', 'floatArithmetic'),
        invalid('const wrong = a ** count;', 'floatArithmetic'),
        // Money reached through a property is still money.
        invalid('const wrong = line.amount + b;', 'floatArithmetic'),
        invalid('const wrong = b + line.amount;', 'floatArithmetic'),
        // Concatenating money into a string skips toDecimalString.
        invalid("const wrong = 'total: ' + a;", 'floatArithmetic'),
        invalid('a += b;', 'floatArithmetic'),
        invalid('a -= b;', 'floatArithmetic'),
        invalid('a *= count;', 'floatArithmetic'),
        invalid('const wrong = -a;', 'floatArithmetic'),
        invalid('a++;', 'floatArithmetic'),
        invalid('--a;', 'floatArithmetic'),
        // Coercions: both the explicit and the sneaky spelling.
        invalid('const wrong = Number(a);', 'numberCoercion'),
        invalid('const wrong = +a;', 'numberCoercion'),
        // Math is doubles all the way down.
        invalid('const wrong = Math.abs(a);', 'mathOnMoney'),
        invalid('const wrong = Math.round(a);', 'mathOnMoney'),
        invalid('const wrong = Math.max(a, b);', 'mathOnMoney'),
      ],
    });
  });
});
