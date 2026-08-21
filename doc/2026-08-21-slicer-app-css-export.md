# Slicer-app CSS export — css-to-css composition — 2026-08-21

## What

The shared UI stylesheet is consumed by css-to-css composition: each host's
own `styles.css` begins with

```css
@import "tailwindcss";
@import '@orca/slicer-app/styles.css';
```

and the host entry point imports only its own stylesheet
(`import './styles.css'`). Vite's css pipeline resolves the bare specifier
through the package's exports map
(`"exports": { "./styles.css": "./src/index.css" }`); no alias is involved.

## Update 2026-08-21 — Tailwind import moved to the hosts (7c66e9b)

The package's `index.css` no longer imports `tailwindcss` itself: it is pure
Tailwind v4 source (`@source`, `@theme`, `@apply`, `@utility`) and every
consumer owns its own `@import "tailwindcss"` + `@tailwindcss/vite` plugin
registration. Consequence: a consumer without the plugin no longer fails
loudly — the directives pass through verbatim into the built css and browsers
ignore them, so every utility class is dead with zero build diagnostics (the
exact silent failure that hit the web host, doc/2026-08-20). Treat the plugin
registration as part of the css contract.

Same commit deleted `packages/slicer-app/vite.config.ts` (its react/tailwind
plugins belonged to the hosts; vitest's `@` → `./src` alias now lives in the
package's `vitest.config.ts`).

## Why — how we got here

1. Host-local `@orca/slicer-app-css` alias + ambient
   `declare module '@orca/slicer-app-css'` shim. Fragile: an ambient
   declaration only works from a script-format file — the desktop `env.d.ts`
   is a module (imports + `export {}`), where `declare module` is a module
   augmentation that fails TS2882 for the side-effect import. Commit `6ee4d95`
   deleted the shim and broke `pnpm typecheck`; `3d4d0c4` restored it.
2. Package subpath import `import '@orca/slicer-app/styles.css'` with an
   `index.d.css.ts` companion declaration + `allowArbitraryExtensions`. Worked,
   but still required TS machinery and host aliases for both specifiers.
3. Now: pure css-to-css. No TS involvement, no aliases, no companion file.

## Mechanism

- `packages/slicer-app/package.json` exports: `".": "./src/index.ts"`,
  `"./styles.css": "./src/index.css"`.
- Host css: `@import '@orca/slicer-app/styles.css';` — vite resolves the bare
  specifier via node_modules + exports map (workspace dep).
- Host entry: `import './styles.css'` — typed by vite/client's `*.css`
  wildcard; no `allowArbitraryExtensions`, no per-file companion.
- No alias for the package anywhere (vite, vitest, tsconfig `paths`) — both
  hosts resolve the js entry and the css subpath through node resolution.
- Tailwind v4: each host's `@import "tailwindcss"` is processed by its own
  `@tailwindcss/vite` registration, which then compiles the imported package
  `index.css`; the `@source "./**/*.{ts,tsx}"` is relative to the css file, so
  it still covers `packages/slicer-app/src`.

## Gotchas

- Vite alias matching is prefix-based: with a bare `@orca/slicer-app` alias
  present, `@orca/slicer-app/styles.css` resolves to `src/index.ts/styles.css`
  (ENOENT). Removing the aliases entirely sidesteps the trap.
- TS `paths` patterns without `*` match exactly, so a bare `@orca/slicer-app`
  entry does not break subpath exports — but never add `"@orca/slicer-app/*"`
  patterns, which would swallow them.
- Host `import './styles.css'` requires `vite/client` types in scope (both
  hosts' `env.d.ts` reference them).
