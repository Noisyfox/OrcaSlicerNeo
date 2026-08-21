# Fix: web host never compiled Tailwind — 2026-08-20

## Symptom

`pnpm --filter web dev` (and the built bundle) rendered with a completely
broken layout: no spacing, no grid/flex arrangement, no theming.

## Root cause

The shared UI (`packages/slicer-app`) styles come from
`packages/slicer-app/src/index.css`, which is Tailwind v4 source:
`@import "tailwindcss"` plus `@theme inline`, `@layer base` with `@apply`,
and `@utility` definitions. Tailwind v4 CSS only compiles when a plugin
processes it — otherwise those at-rules are not understood by the browser.

The two hosts wired this differently:

| Host | Pipeline | Status |
|---|---|---|
| Desktop (`apps/desktop`) | `@tailwindcss/postcss` via `apps/desktop/postcss.config.js` | worked |
| Web (`apps/web`) | **none** — no postcss config, no `@tailwindcss/vite` plugin | broken |

With no plugin, Vite resolved `@import "tailwindcss"` to the raw
`tailwindcss` package CSS and inlined it together with the app's directives
verbatim. Browsers ignore `@theme`/`@apply`/`@utility`, so **zero utility
classes were generated** — every Tailwind class in the shared UI was dead.
Measured: the web build CSS contained 0 occurrences of `.flex`/`.grid`/
`.bg-background`/`.w-full` vs. the desktop build's compiled output. The m9
web verification (unit tests, non-root smoke, web e2e) asserted functional
behavior (wasm loads, slices run) but never checked styling, so the broken
layout went unnoticed.

## Fix

Register the Tailwind Vite plugin in `apps/web/vite.config.ts` and add
`@tailwindcss/vite` (^4.3.3, matching desktop's tailwindcss) to
`apps/web/package.json` devDependencies. The `@source "./**/*.{ts,tsx}"`
in `index.css` is relative to the CSS file, so it already covers every
component in `packages/slicer-app/src`.

## Regression guard

`apps/web/scripts/non-root-smoke.mjs` now asserts that the built
`dist/assets/index-*.css` contains at least one compiled utility (`.flex{`).
Without the plugin, the build CSS is raw source and the guard fails.

Note for future edits: the guard reads the built artifact rather than the
preview server because `vite preview` with `base: './'` serves the HTML at
the subpath (`/orca/`) but assets at the root (`/assets/...`) — fetching the
stylesheet through the preview would hit the SPA fallback (index.html) and
also tripped a Node 24 Windows libuv teardown assertion when a second
keep-alive connection was open at exit.

## Verification

- `pnpm --filter web build` — CSS grows 24 kB (raw source) → 45 kB
  (compiled); `.bg-background`, `.flex`, `.grid`, `.w-full`, `.items-center`
  present; preflight present; zero `@apply` residue.
- `pnpm --filter web dev` — dev-transform of `index.css` serves compiled
  utilities (`.w-full { width: 100%; }`, `.bg-background { background-color:
  hsl(var(--background)); }`).
- `pnpm --filter web test:non-root` — build + smoke green (incl. new CSS
  assertion).
- `pnpm --filter web test` (5 pass), `pnpm --filter web typecheck` — green.

## Update 2026-08-21 — desktop unified onto the Vite plugin

Commit `6ee4d95` retired the desktop PostCSS pipeline: `@tailwindcss/postcss`
and `postcss` dropped from `apps/desktop/package.json`,
`apps/desktop/postcss.config.js` deleted, `@tailwindcss/vite` registered in
`apps/desktop/electron.vite.config.ts`. Both hosts now compile the shared
Tailwind v4 source identically (the table above is historical). Alongside:
`components.json` moved from `apps/desktop` to `packages/slicer-app` (its
stale `tailwind.config.js` pointer dropped — Tailwind v4 is CSS-first), and
`packages/slicer-app/vite.config.ts` added for the package's own tooling
(vitest picks it up; `__dirname` works because Vite injects it when bundling
the config).
