/**
 * `pdfmake/build/vfs_fonts.js` is a generated data blob with no type
 * declarations of its own — see `fonts.ts` for why the renderer reaches into it
 * rather than requiring a real `.ttf` on disk. This ambient module covers that
 * one subpath only; it deliberately does not touch the `pdfmake` or
 * `pdfmake/interfaces` module names, which are expected to carry their own
 * types — bundled, or via a `@types/pdfmake` devDependency the orchestrator
 * adds at integration if the installed version ships none (see `index.ts`'s
 * header).
 *
 * The shape assumed here — `{ pdfMake: { vfs: Record<string, string> } }`,
 * base64 font payloads keyed by file name — is the shape pdfmake's node build
 * has exported this file in for a long run of versions, but it is unverified
 * against whatever version the orchestrator installs. If it differs, `fonts.ts`
 * is the one place to fix, and this declaration should change with it.
 */
declare module 'pdfmake/build/vfs_fonts.js' {
  const vfs: { pdfMake: { vfs: Record<string, string> } };
  export default vfs;
}
