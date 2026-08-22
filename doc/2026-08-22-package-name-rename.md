# Package renames + Electron userData directory

2026-08-22

## What changed

- `apps/desktop/package.json`: `"name"` `desktop` → `@orca/desktop`, and a
  `"productName": "OrcaSlicerNeo"` field was added.
- `apps/web/package.json`: `"name"` `web` → `@orca/web`.
- `packages/slicer-wasm/package.json`: `"name"` `slicer-wasm` →
  `@orca/slicer-wasm` (last unscoped project package; the `@orca/*` scope now
  covers every app and shared package, with `slicer-runtime`'s workspace
  dependency renamed to match).

## Why

- Electron derives the default `userData` directory from `app.name`, which
  prefers the `productName` field over `name` in the app's `package.json`.
  With the package named `desktop`, dev (and any unpackaged) runs persisted
  preferences under `%APPDATA%\desktop` on Windows. Setting `productName` to
  `OrcaSlicerNeo` makes every launch mode — dev, e2e, packaged — use
  `%APPDATA%\OrcaSlicerNeo` (verified: `app.getPath('userData')` →
  `C:\Users\<user>\AppData\Roaming\OrcaSlicerNeo`).
- The bare `desktop`/`web` package names were too generic for the monorepo;
  both apps now use the same `@orca/*` scope as the shared packages.

## References updated

Root `package.json`, `pnpm-workspace.yaml`, README, AGENTS.md,
`project_structure_and_guidelines.md`, `scripts/build.sh`,
`scripts/build-windows.bat`, `.github/workflows/ci.yml`,
`apps/web/playwright.config.ts`, `scripts/run-web-e2e-serial.mjs`,
`apps/web/package.json` scripts, and a comment in
`apps/desktop/e2e/packaged.e2e.ts` — every `pnpm --filter desktop|web`
reference now uses `@orca/desktop` / `@orca/web`. `pnpm --filter slicer-wasm`
references in `scripts/build.sh` / `scripts/build-windows.bat` and the README
were updated to `@orca/slicer-wasm`, and `pnpm-lock.yaml` was regenerated.
Editor helper files were updated too: `.vscode/tasks.json` (web dev task) and
`.vscode/launch.json` (desktop debug runtime args). Other agent helper configs
(`CLAUDE.md`, `GEMINI.md`, `CODEBUDDY.md`, `QODER.md`, `opencode.jsonc`,
`.cursorrules`, `.windsurfrules`, `.mcp.json`, `.claude/`, `.gemini/`,
`.codebuddy/`, `.kiro/`, `.qoder/`) contained no package-name references.

The workspace root (`orca-slicer-neo`) intentionally stays unscoped — it is
the monorepo container, not a project package.

Historical dated notes in `doc/` intentionally keep their original commands
(they record what was run at the time).

## Verification

- `pnpm --filter @orca/desktop typecheck` — pass
- `pnpm --filter @orca/web typecheck` — pass
- `pnpm --filter @orca/slicer-wasm typecheck` / `test` — pass
- Electron probe through the real launch path (`electron .` in
  `apps/desktop`): `app.getName()` → `OrcaSlicerNeo`;
  `app.getPath('userData')` →
  `C:\Users\<user>\AppData\Roaming\OrcaSlicerNeo`.
