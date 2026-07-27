/**
 * A colour written as a hex literal: `#fff`, `#ffff`, `#ffffff`, `#ffffffff`.
 *
 * The digit counts are exact, and the trailing boundary matters more than it looks.
 * Without it this matches the first three characters of `#deadbeef-cafe` and of a
 * `querySelector('#abcdef-panel')`; with it, `#root`, `#/accounts`, and an anchor `#` are
 * all uninteresting because they are not hex to begin with.
 */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/;

/**
 * A colour written as a CSS colour function.
 *
 * `oklch` and friends are here alongside `rgb`/`hsl` because the point is not that sRGB
 * hex is imprecise — it is that the value is named at the point of use instead of in the
 * token layer, and a modern colour space does not change that.
 *
 * The arguments are matched as well as the opening paren, and only so that the report
 * quotes `rgb(15, 23, 42)` rather than `rgb(` — a message naming half a value sends the
 * reader looking for the wrong string. The closing paren is optional for the same reason
 * the detection has to be lenient: an unterminated call is still a colour being written.
 */
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)?/;

/**
 * A Tailwind arbitrary value: the `[…]` in `bg-[#fff]`, `text-[rgb(0,0,0)]`,
 * `shadow-[0_0_0_1px_#000]`.
 *
 * Reported only when the bracket contains a colour by the two tests above, so
 * `grid-cols-[auto_1fr]` and `[&:has(input)]:bg-surface-hover` — arbitrary values that
 * name no colour — are left alone. `[color:var(--ob-color-text)]` is likewise fine: it
 * contains no literal.
 */
const ARBITRARY_VALUE = /\[[^\]]*\]/g;

/**
 * Does this string contain a colour literal, and if so which kind?
 *
 * @param {string} text
 * @returns {'rawHexColor' | 'rawColorFunction' | null}
 */
function colorLiteralIn(text) {
  if (HEX_COLOR.test(text)) return 'rawHexColor';
  if (COLOR_FUNCTION.test(text)) return 'rawColorFunction';
  return null;
}

/**
 * Tailwind spells a space as `_` inside an arbitrary value, and `_` is a word character —
 * so `shadow-[0_0_0_1px_hsl(0_0%_0%)]` has no word boundary before `hsl` and slips past
 * `COLOR_FUNCTION` unless the separator is restored first. Found by the test that asserts
 * two findings in one class list and got one.
 *
 * @param {string} bracket
 * @returns {string}
 */
function unpackArbitraryValue(bracket) {
  return bracket.replaceAll('_', ' ');
}

/**
 * Bans raw colour values outside the token layer (ROADMAP D-24).
 *
 * The rule exists for the reason `no-float-money` exists: D-24 makes "no component names a
 * raw colour" an acceptance criterion (M2 B9), and a criterion nothing checks is a
 * criterion that holds until the first deadline. The specific harm is not ugliness — it is
 * that a hardcoded colour is invisible to a theme. `tokens.css` re-binds a role at `:root`
 * and every component follows; a `#111827` in a component follows nothing, so dark mode
 * ships with one white panel and nobody finds it until a user does.
 *
 * Three spellings are reported, because they are the three that reach a browser:
 *
 * 1. A hex literal anywhere in a string or template — `style={{ color: '#111' }}`, an SVG
 *    `fill`, a chart series colour.
 * 2. A CSS colour function — `rgb(…)`, `hsl(…)`, `oklch(…)`, `color(…)`.
 * 3. A Tailwind arbitrary value containing either — `bg-[#fff]`, `border-[rgb(0,0,0)]`.
 *
 * What it deliberately does **not** try to catch is a Tailwind class naming a palette
 * value that no theme re-binds, such as `bg-red-500`. That is not this rule's job because
 * it is already impossible: `tokens.css` clears Tailwind's built-in theme with
 * `--*: initial`, so `bg-red-500` compiles to nothing at all. The two mechanisms are
 * complementary — the theme reset removes the values that are not tokens, and this rule
 * removes the ability to write a value directly.
 *
 * Only string literals and template chunks are scanned, so a hex appearing as JSX *text*
 * is not reported. That is content rather than styling, and a rule that reported it would
 * make a screen displaying a colour code unwritable.
 *
 * The escape hatch is the `allow` option, a list of path fragments, listed in
 * `eslint.config.js` so every exemption is visible in one place rather than as scattered
 * inline disables. It is a path list rather than a per-value allowance because there is no
 * such thing as one acceptable raw colour: the file that may name them is the file that
 * defines the token layer, and there is one of those.
 *
 * Not type-aware, so it applies to `.tsx` regardless of program membership.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const noRawColor = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw colour values (hex, CSS colour functions, Tailwind arbitrary colours) ' +
        'outside the token layer',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path fragments permitted to name raw colour values.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawHexColor:
        'Raw colour {{value}}. Colour is defined once in src/styles/tokens.css and reached ' +
        'through a role token (ROADMAP D-24) — a literal here is invisible to the theme, so ' +
        'it survives a switch to dark unchanged.',
      rawColorFunction:
        'Raw colour {{value}}. Colour is defined once in src/styles/tokens.css and reached ' +
        'through a role token (ROADMAP D-24) — a literal here is invisible to the theme, so ' +
        'it survives a switch to dark unchanged.',
      arbitraryColorValue:
        'Tailwind arbitrary colour {{value}}. Use a token-backed utility (bg-surface, ' +
        'text-text-muted, border-border); if no role fits, add one to src/styles/tokens.css ' +
        'rather than inlining the value (ROADMAP D-24).',
    },
  },
  create(context) {
    const options = /** @type {{ allow?: string[] } | undefined} */ (context.options[0]);
    const allow = options?.allow ?? [];
    const filename = context.filename.replaceAll('\\', '/');
    if (allow.some((fragment) => filename.includes(fragment))) {
      return {};
    }

    /**
     * @param {import('estree').Node} node
     * @param {string} text
     */
    function check(node, text) {
      /**
       * Arbitrary values first. `bg-[#fff]` would otherwise be reported as a bare hex,
       * with a message that says nothing about the Tailwind spelling that produced it.
       */
      const brackets = text.match(ARBITRARY_VALUE) ?? [];
      const reportedBrackets = brackets.filter(
        (bracket) => colorLiteralIn(unpackArbitraryValue(bracket)) !== null,
      );

      for (const bracket of reportedBrackets) {
        context.report({
          node,
          messageId: 'arbitraryColorValue',
          data: { value: bracket },
        });
      }

      let remainder = text;
      for (const bracket of reportedBrackets) {
        remainder = remainder.split(bracket).join(' ');
      }

      const messageId = colorLiteralIn(remainder);
      if (messageId === null) return;

      const match =
        messageId === 'rawHexColor' ? HEX_COLOR.exec(remainder) : COLOR_FUNCTION.exec(remainder);

      context.report({
        node,
        messageId,
        data: { value: match === null ? remainder : match[0] },
      });
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        check(node, node.value);
      },
      TemplateElement(node) {
        /**
         * `node.value.cooked` is null only for an invalid escape in a tagged template,
         * where `raw` is what the tag receives — so the raw text is the right thing to
         * scan and the fallback is not a defensive nicety.
         */
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
