# Slicer-app CSS export — css-to-css composition — 2026-08-21

## What

The shared UI stylesheet is consumed by css-to-css composition: each host's
own `styles.css` begins with

```css
@import '@orca/slicer-app/styles.css';
```

and the host entry point imports only its own stylesheet
(`import './styles.css'`). Vite's css pipeline resolves the bare specifier
through the package's exports map
(`"exports": { "./styles.css": "./src/index.css" }`); no alias is involved.

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
- Tailwind v4: the imported `index.css` is processed by the `@tailwindcss/vite`
  plugin; its `@source` is relative to the css file, so it still covers
  `packages/slicer-app/src`. Verified byte-identical compiled output
  (`index-11QsX6C8.css`, 54.72 kB) before and after the change.

## Gotchas

- Vite alias matching is prefix-based: with a bare `@orca/slicer-app` alias
  present, `@orca/slicer-app/styles.css` resolves to `src/index.ts/styles.css`
  (ENOENT). Removing the aliases entirely sidesteps the trap.
- TS `paths` patterns without `*` match exactly, so a bare `@orca/slicer-app`
  entry does not break subpath exports — but never add `"@orca/slicer-app/*"`
  patterns, which would swallow them.
- Host `import './styles.css'` requires `vite/client` types in scope (both
  hosts' `env.d.ts` reference them).
