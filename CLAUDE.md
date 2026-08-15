@AGENTS.md

<!-- Project-specific Claude notes -->

## Key paths

| Path | What it is |
|---|---|
| `doc/2026-08-12-electron-gui-rewrite-design.md` | **Approved design — read before coding.** Architecture, bridge API table, decisions, risks |
| `doc/high_level_dev_plan.md` / `spec/Grand Plan.md` | Roadmap + milestone checklist (keep in sync with work) |
| `packages/slicer-wasm/cpp/` | git submodule → `Noisyfox/OrcaSlicer` (C++ source, pinned SHA). Treat as read-only except via `patches/` |
| `packages/slicer-wasm/src/bridge.cpp` | extern "C" bridge API (the C++↔JS seam) |
| `packages/slicer-wasm/src/client/` | typed JS client + worker glue (the only JS that touches the WASM module) |
| `apps/desktop/src/` | Electron main / preload / renderer |

## Reference (do not reinvent)

The phase-0 spike (external reference implementation, GO verdict 2026-07-24)
proved feasibility and contains reusable machinery:
- `shim/_serial.hpp` — serial TBB shim (copy; add `parallel_pipeline` stand-in)
- `build-boost-wasm64.sh` — Boost 1.84 for wasm64
- `cmake/CMakeLists.txt` — GLOB + `DROP_PATTERNS` scaffold
- `patches/0001-model-hpp-guard-step-include.patch` — Model.hpp STEP guard
- `harness/` — Node smoke runner + mock-module self-test pattern
- `FINDINGS.md` — per-file compile recipe, remaining blockers, wasm64 rationale

## Build commands (once scaffolded)

- All-in-one driver (Windows/Git Bash): `bash scripts/build-windows.sh help` —
  subcommands `env deps boost build full quick shim smoke test dev e2e` wrap
  every step below; `quick` is the incremental ninja loop for bridge changes.
- WASM: `bash packages/slicer-wasm/build.sh` (needs emsdk on PATH; ~50 GB disk for the dep build)
- Node smoke: `node packages/slicer-wasm/harness/run-slice.mjs --module out/orca_slice.js --stl fixtures/cube.stl --config fixtures/config.json`
- App dev: `pnpm --filter desktop dev` (electron-vite)
- e2e: `pnpm --filter desktop test:e2e` (Playwright Electron)

## Golden rules

1. **libslic3r is reused with minimum changes.** Prefer build-scaffold exclusions,
   stubs, and shim headers over editing the submodule. Any submodule edit needs a
   `patches/*.patch` (or an intentional, documented submodule commit).
2. **The WASM build is iterative.** The spike's iterate loop applies
   (TBB_HEADERS / DROP_PATTERNS / stubs / API drift) — see AGENTS.md.
3. **Everything through the bridge.** Renderer code never imports the WASM module
   directly; it calls `packages/slicer-wasm/src/client`.
4. **Docs first.** New work gets a dated note in `doc/` before/with code; approved
   designs move to `spec/`. Follow the repo's doc conventions (dated
   `YYYY-MM-DD-topic.md`).
