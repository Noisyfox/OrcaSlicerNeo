# Corresponding Source Offer

OrcaSlicerNeo is free software distributed under the GNU Affero General Public
License, version 3 (see `LICENSE`).

The corresponding source code is published in the project repository:

- **Repository:** <https://github.com/Noisyfox/OrcaSlicerNeo>
- **Branch:** `main`
- **C++ slicing core:** `libslic3r` (fork of OrcaSlicer, AGPL-3.0), pinned as a
  git submodule at `packages/slicer-wasm/cpp` (see
  `packages/slicer-wasm/cpp` — commit SHA in `.gitmodules`/`git submodule status`)

The commit this build was produced from is recorded in the version header
(`SLIC3R_VERSION` / `GIT_COMMIT_HASH` in the generated
`libslic3r_version.h`), which is embedded in the G-code metadata of every
exported file.

Build instructions: see `doc/2026-08-12-wasm-build-notes.md` (WASM core) and
`doc/2026-08-14-m3-implementation-notes.md` (packaging pipeline).
