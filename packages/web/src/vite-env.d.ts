/// <reference types="vite/client" />

/**
 * Declares the one variable this package reads from its build environment.
 *
 * Without this, `vite/client`'s `[key: string]: any` index signature is what answers
 * `import.meta.env.VITE_API_BASE_URL`, and an `any` here would be load-bearing: that
 * value decides where every request in the application goes, and `any` is precisely
 * what switches off the rules (`no-unsafe-assignment`, `no-unsafe-argument`) that
 * would otherwise force it to be checked. Declaring it also makes `src/env.ts` fail
 * to compile if the variable is ever renamed on one side only.
 *
 * `noPropertyAccessFromIndexSignature` is on, so an undeclared `VITE_*` read would
 * not compile either — which is the intended outcome. A new variable is declared
 * here, resolved in `src/env.ts`, and documented in `.env.example`.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}
