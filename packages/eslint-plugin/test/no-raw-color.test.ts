import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noRawColor } from '../src/rules/no-raw-color.js';

/**
 * JSX has to be parsed, because two of the three spellings the rule bans only ever appear
 * in a component: a `className` string and a `style` object.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const ALLOW = [{ allow: ['src/styles/'] }];
const COMPONENT = '/repo/packages/web/src/components/button.tsx';

describe('no-raw-color', () => {
  it('accepts token references and rejects raw colour values', () => {
    ruleTester.run('no-raw-color', noRawColor, {
      valid: [
        // The shape every component is expected to have.
        {
          code: "const cls = 'bg-surface text-text-muted border-border shadow-overlay';",
          options: ALLOW,
          filename: COMPONENT,
        },
        // A custom property reached through an arbitrary *property*, which names no value.
        {
          code: "const cls = '[color:var(--ob-color-text)]';",
          options: ALLOW,
          filename: COMPONENT,
        },
        // Arbitrary values that are not colours are none of this rule's business.
        {
          code: "const cls = 'grid-cols-[auto_1fr_auto] w-[--ob-width-form]';",
          options: ALLOW,
          filename: COMPONENT,
        },
        // `#` in a string is overwhelmingly a fragment or a selector, not a colour.
        {
          code: "const el = document.querySelector('#root'); const href = '#/accounts';",
          options: ALLOW,
          filename: COMPONENT,
        },
        // Six hex characters followed by more identifier characters are an id, not a colour.
        {
          code: "const el = document.querySelector('#abcdef-panel');",
          options: ALLOW,
          filename: COMPONENT,
        },
        // The token layer is the one place a raw value is the correct thing to write.
        {
          code: "const fallback = 'oklch(0.985 0.003 264)';",
          options: ALLOW,
          filename: '/repo/packages/web/src/styles/tokens.ts',
        },
      ],
      invalid: [
        {
          code: "const style = { color: '#111827' };",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'rawHexColor' }],
        },
        // Three-digit shorthand, the spelling most likely to be typed without thinking.
        {
          code: "<div style={{ background: '#fff' }} />;",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'rawHexColor' }],
        },
        {
          code: 'const shadow = `0 1px 2px rgba(0, 0, 0, 0.08)`;',
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'rawColorFunction' }],
        },
        // A modern colour space is still a value named outside the token layer.
        {
          code: "const brand = 'oklch(0.52 0.196 261)';",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'rawColorFunction' }],
        },
        // The Tailwind spelling, reported as such rather than as a bare hex — the fix is a
        // different one, so the message has to be.
        {
          code: "<div className='bg-[#fff] p-2' />;",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'arbitraryColorValue' }],
        },
        {
          code: "const cls = 'border-[rgb(17,24,39)]';",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'arbitraryColorValue' }],
        },
        // Both spellings in one class list are two findings, not one.
        {
          code: "const cls = 'bg-[#fff] shadow-[0_0_0_1px_hsl(0_0%_0%)]';",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'arbitraryColorValue' }, { messageId: 'arbitraryColorValue' }],
        },
        // An SVG attribute is the path that bypasses CSS entirely, so it has to be covered
        // or every icon becomes an exemption.
        {
          code: "<svg><path fill='#0f172a' /></svg>;",
          options: ALLOW,
          filename: COMPONENT,
          errors: [{ messageId: 'rawHexColor' }],
        },
        // With no `allow` configured, nothing is exempt — including the token layer. The
        // exemption is a configuration fact, stated in eslint.config.js.
        {
          code: "const fallback = '#ffffff';",
          filename: '/repo/packages/web/src/styles/tokens.ts',
          errors: [{ messageId: 'rawHexColor' }],
        },
      ],
    });
  });
});
