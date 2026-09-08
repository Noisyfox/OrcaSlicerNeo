# Repository Guidelines

## Mission and non-negotiable boundaries

- OrcaSlicerNeo is a shared React + TypeScript + Vite + shadcn/ui application
  with thin Electron and static-Web hosts. The C++ `libslic3r` core is compiled
  to WebAssembly; the wxWidgets GUI is neither ported nor built for WASM. The
  authoritative architecture is
  [`spec/Web-Electron Shared Application Architecture.md`](spec/Web-Electron%20Shared%20Application%20Architecture.md).
- Treat `packages/slicer-wasm/cpp/` as a read-only pinned submodule. Make
  upstream adaptations through `packages/slicer-wasm/patches/*.patch`, or use
  an intentional, documented submodule commit. Never make ad-hoc edits or move
  the submodule pointer casually.
- `packages/slicer-wasm/src/client/` is the only JavaScript allowed to talk
  directly to the Emscripten module. Application code must use
  `packages/slicer-runtime/`; never import module URLs or Emscripten globals
  into the application.
- Run the WASM module in a Web Worker; never block the renderer UI thread.
- Use pnpm for workspace development, unit tests, typechecks, and Electron e2e.
  Do not substitute npm or yarn. The native WASM build drivers are the intended
  exception.
- The repository and its deliverables remain AGPL-3.0.

## Read before changing

Keep this file as a concise execution entry point: link to authoritative
documents instead of copying their directory trees, command catalogs,
troubleshooting procedures, or test matrices here.

1. Before any coding, read
   [`spec/Web-Electron Shared Application Architecture.md`](spec/Web-Electron%20Shared%20Application%20Architecture.md).
2. Read the relevant approved design in `spec/` and the current dated task
   document in `doc/`. The delivered desktop vertical slice is documented in
   [`doc/2026-08-12-electron-gui-rewrite-design.md`](doc/2026-08-12-electron-gui-rewrite-design.md).
3. Use
   [`project_structure_and_guidelines.md`](project_structure_and_guidelines.md)
   for the repository tree, ownership boundaries, engineering constraints, and
   documentation conventions. Do not duplicate those inventories here.
4. Use [`README.md`](README.md) and the platform driver's `help` command for
   current setup, build, development, smoke, and e2e commands. For WASM-specific
   details, consult
   [`doc/2026-08-12-wasm-build-notes.md`](doc/2026-08-12-wasm-build-notes.md),
   [`doc/2026-08-15-cmd-build-pipeline.md`](doc/2026-08-15-cmd-build-pipeline.md),
   and
   [`doc/2026-08-20-wasm-dwarf-debug-build.md`](doc/2026-08-20-wasm-dwarf-debug-build.md).
5. Follow
   [`doc/testing_guidelines.md`](doc/testing_guidelines.md)
   when choosing verification scope. Do not infer that every feature edit
   requires the full repository matrix.
6. Update [`doc/high_level_dev_plan.md`](doc/high_level_dev_plan.md) and
   [`spec/Grand Plan.md`](spec/Grand%20Plan.md) only when delivered work changes
   roadmap or milestone status, and keep them consistent.

Start each feature or design change with one dated, living task document in
`doc/` and update it in place. Record only accepted behavior and decisions;
do not create phase-by-phase notes. When approved, promote that same document
to `spec/` and remove superseded task notes.

## Working rules

1. Work on a dedicated development branch. Before starting a new issue, commit
   verified in-scope work already in the tree; do not bundle unrelated or
   pre-existing changes into the new commit.
2. Divide implementation into complete, independently testable pieces. Run the
   checks appropriate to each piece and commit each piece separately.
3. On Windows, use `scripts\build-windows.bat`; do not use Git Bash. Keep batch
   files cmd-native and CRLF. See the cmd pipeline document above for quoting,
   executable lookup, and parenthesis-block hazards.
4. Report the exact checks run and their results. Name any intentionally
   skipped, unavailable, or failing check.
5. For documentation-only changes, at minimum run `git diff --check` and verify
   every changed local link and command against its authoritative source.

## High-risk paths

| Path | Required handling |
| --- | --- |
| `packages/slicer-wasm/cpp/` | Preserve the pinned submodule; use patches or a deliberate documented submodule update. |
| `packages/slicer-wasm/src/bridge.cpp` | Preserve the narrow C++/JS ABI and run the applicable native WASM quick build. |
| `packages/slicer-wasm/src/client/` | Keep all direct Emscripten-module access behind this typed client. |
| `scripts/*.bat`, `packages/slicer-wasm/*.bat` | Use Windows cmd syntax and CRLF; never assume Git Bash. |
| `doc/`, `spec/` | Keep living task decisions separate from approved specifications and avoid parallel phase notes. |

## Bridge and runtime invariants

- The bridge is `extern "C"`, JSON-in/JSON-out, and synchronous on its Worker
  thread.
- Binary buffers cross through the WASM heap using `_malloc`, `_free`, and
  `HEAPU8` views.
- Renderer and application code use the runtime/client boundary rather than
  calling the module directly.

## Verification scope

- During an edit loop, run the smallest deterministic checks that cover the
  changed behavior.
- Before committing an independently testable piece, run the affected package
  tests/typecheck and any boundary guard or smoke test implicated by the diff.
- At handoff or PR time, run the repository-level checks plus affected-host e2e
  and affected WASM variant checks.
- Reserve the full dual-host, dual-WASM release matrix for release qualification
  or changes that genuinely span that matrix.

The precise decision table, escalation triggers, and command examples live in
[`doc/testing_guidelines.md`](doc/testing_guidelines.md);
that document is authoritative when this summary is insufficient.

<!-- code-review-graph MCP tools -->
## Code exploration and review

**Use the code-review-graph MCP tools before Grep, Glob, or broad file reads.**
The graph provides structural context such as callers, dependents, flows, and
test coverage. Fall back to text search or file reads only when the graph does
not contain the needed evidence.

- Explore concepts with `semantic_search_nodes_tool` or `query_graph_tool`.
- Assess blast radius with `get_impact_radius_tool` and execution paths with
  `get_affected_flows_tool`.
- Review changes with `detect_changes_tool`, then request focused source context
  with `get_review_context_tool`.
- Trace callers, callees, imports, dependencies, and tests with
  `query_graph_tool`; use the `tests_for` pattern for coverage questions.
- Use `get_architecture_overview_tool` and `list_communities_tool` for
  architecture questions.

The graph auto-updates through repository hooks. For reviews, start with change
detection, inspect affected flows, then confirm coverage for the changed nodes.
