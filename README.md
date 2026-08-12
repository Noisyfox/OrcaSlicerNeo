# OrcaSlicerNeo

A next-generation desktop GUI for OrcaSlicer, rebuilt on **Electron + React +
TypeScript + Vite + shadcn/ui**, with the C++ slicing core (`libslic3r`) reused
as-is and compiled to **WebAssembly** via Emscripten.

The existing wxWidgets GUI is not ported. One `.wasm` serves all six target
platforms: Windows x64/arm64, Linux x64/arm64, macOS x64/arm64.

## Status

- **Design approved** — see [doc/2026-08-12-electron-gui-rewrite-design.md](doc/2026-08-12-electron-gui-rewrite-design.md)
- Feasibility proven by the phase-0 compile spike (GO verdict 2026-07-24) —
  see CLAUDE.md → Reference for details
- Pre-implementation; repo scaffolding in progress

## Layout

```
apps/desktop/          Electron app (main / preload / renderer)
packages/slicer-wasm/  WASM slicer module: build scaffold + bridge + JS client
  cpp/                 git submodule → Noisyfox/OrcaSlicer (the C++ source)
doc/                   dated engineering docs (YYYY-MM-DD-topic.md)
spec/                  approved specs
tools/ scripts/ tests/ dev utilities, CI scripts, e2e tests
```

See [project_structure_and_guidelines.md](project_structure_and_guidelines.md) and
[AGENTS.md](AGENTS.md) for structure and engineering conventions.

## Licensing

AGPL-3.0. OrcaSlicerNeo is a fork of AGPL OrcaSlicer; the Electron app, the WASM
module, and the `libslic3r` core all inherit the AGPL. See the design doc's
Licensing section.
