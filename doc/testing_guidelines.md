# Testing Guidelines

**Status:** Authoritative project guidance

## Purpose

Keep the development feedback loop short without weakening release evidence.
The repository has fast Vitest coverage, heavyweight Electron/Web end-to-end
flows, and two real wasm64 variants. Those layers answer different questions
and must not all run after every edit or every small feature increment.

This document is the repository-wide testing guide. It defines test ownership,
quality expectations, and when each layer runs. Product specifications remain
the authority for the behaviours that must be covered; this guide controls the
frequency and scope of their execution.

## Principles

1. Run the cheapest test that can fail for the changed behaviour first.
2. A shared behaviour is proved exhaustively at its lowest practical layer and
   exercised end to end in one primary host. Other hosts test their platform
   seams rather than repeating the complete shared interaction matrix.
3. The threaded and serial wasm64 artifacts share the same bridge contract.
   During iteration, run the affected variant and focused harness. Before a
   release, prove both variants; do not run every shared scenario twice merely
   because two artifacts exist.
4. TypeScript interface-shape checks belong to `tsc`. Vitest tests must execute
   production behaviour, validate a runtime invariant, or protect a concrete
   regression.
5. An end-to-end assertion must identify the behaviour it proves. Ambiguous
   proxies such as "some pixels changed" are insufficient when several
   unrelated interactions can satisfy the assertion.
6. Security, persistence, binary-transfer ownership, compatibility, and
   failure-path tests retain priority even when their implementation is small.
7. Never remove the only test for a risk merely to shorten the suite. Move an
   expensive but unique check to the appropriate gate instead.

## Execution Levels

### Level 1 — edit loop

Run after an implementation edit while developing:

- the directly related Vitest file or smallest coherent set of files;
- the affected package typecheck when a public type, component interface, or
  cross-module contract changed;
- one focused harness only when the edited code crosses the JS/WASM boundary.

Examples:

```powershell
pnpm --filter @orca/slicer-app exec vitest run src/history/restoreCoordinator.test.ts
pnpm --filter @orca/slicer-app typecheck
scripts\build-windows.bat quick --variant serial
scripts\build-windows.bat smoke --variant serial
```

Do not automatically run all Electron E2E, both Web variants, or both WASM
variants at this level.

### Level 2 — independently testable piece / commit

Before committing a complete implementation piece:

- run the affected workspace package's full unit suite and typecheck;
- run a focused host E2E only when the piece changes rendered interaction or a
  host boundary that unit tests cannot prove;
- run the affected WASM variant's quick build and focused smoke when bridge,
  build-scaffold, or generated-artifact code changed;
- for documentation-only changes, run `git diff --check`; no product test is
  required unless the documentation change also modifies executable examples
  or generated inputs.

Use `--grep` or an explicit Playwright file to select the relevant E2E instead
of running the complete host suite.

### Level 3 — pull request / handoff

Before handing off code for review:

1. Run `pnpm test` and `pnpm typecheck`.
2. Run focused E2E for every affected host seam.
3. Run the primary shared-application E2E path once. Electron mock E2E is the
   default fast primary path for shared UI work; real Web E2E is required when
   browser deployment, browser adapters, runtime selection, or real WASM
   integration is affected.
4. When common WASM bridge or build code changed, quick-build both variants.
   Run the comprehensive bridge contract on one variant and variant-specific
   startup/threading/fallback smoke on the other. Run both comprehensive
   contracts only when variant-dependent code changed or the task's approved
   specification explicitly requires that evidence.
5. Report every command actually run, its result, and intentional skips. A
   missing environment or artifact is reported as not run, never as passed.

Documentation-only handoffs use `git diff --check` plus link/command review and
do not require the product regression matrix.

### Level 4 — release / milestone acceptance / overnight regression

Run the complete approved matrix:

- `pnpm test` and `pnpm typecheck`;
- dual threaded/serial WASM quick build and smoke;
- full Electron E2E;
- real Web threaded and serial E2E;
- applicable packaged-app, profile-package, project-compatibility,
  cross-check, and licensed-fixture probes named by the feature specification.

This is the only default level at which all host and artifact combinations run
regardless of the most recent change. A specification may require the same
matrix earlier for a high-risk task, but the task document must state why.

## Change-to-Test Routing

| Change scope | Required during iteration | Add before PR/handoff | Full release additions |
|---|---|---|---|
| Pure shared logic, store, geometry, or React behaviour | Focused `@orca/slicer-app` Vitest; package typecheck as needed | Package suite; root test/typecheck; one focused primary-host E2E when DOM/WebGL wiring matters | Full host matrix |
| Platform contract or shared runtime | Focused contract/runtime/client tests | Root test/typecheck; affected Electron/Web adapter E2E | Both hosts and both runtime variants |
| Electron main, preload, native menu, filesystem, transport, or webview | Focused desktop unit/security tests | Desktop typecheck and focused Electron E2E | Full Electron and packaged probes |
| Web adapter, capability gate, deployment headers, or download | Focused Web tests | Web typecheck and affected threaded or serial real E2E | Threaded and serial Web E2E plus non-root deployment smoke |
| C++ bridge, Emscripten scaffold, shim, or WASM artifact | Focused client test plus one affected-variant quick/smoke | Both quick builds; comprehensive bridge smoke on one variant and variant-specific smoke on the other | Comprehensive smoke on both variants and real host flows |
| Profiles or compatibility fixtures | Focused profile/package/compatibility test | Affected real-WASM compatibility harness | Full-manifest and both-variant compatibility matrix |
| Documentation only | `git diff --check` | Link, command, and consistency review | None unless release notes or executable release inputs changed |

## E2E Ownership

- Shared application behaviour belongs primarily to `packages/slicer-app`
  unit/component tests plus one primary-host journey.
- Electron E2E owns native dialogs, preload/main IPC, native/custom menu
  integration, filesystem persistence, packaged runtime, and Electron-only
  security boundaries.
- Web E2E owns browser file selection/download, browser navigation behaviour,
  COOP/COEP deployment, capability gating, and serial fallback selection.
- A second host assertion is justified only when the host boundary can change
  the outcome. Merely rendering the same shared component in another host is
  not sufficient justification.
- Threaded/serial parity is normally a runtime-selection and artifact smoke
  concern. Run the complete shared UI flow against one variant; use a focused
  import/slice/export path and fallback/threading assertion for the other.

## Test Quality and Maintenance

- Keep test output quiet. Expected errors must be captured explicitly, and
  React component tests must configure the `act` environment correctly so
  warnings do not hide regressions.
- Prefer user-visible or stable contract assertions over CSS implementation
  details. Exact class assertions are reserved for a documented layout or
  interaction regression that cannot be expressed semantically.
- Consolidate repeated setup and repeated host journeys, but do not share
  mutable application state between tests when isolation is the behaviour
  under test.
- Periodically use coverage and, for critical pure logic, mutation testing to
  support deletion decisions. Test count alone is not a quality target.

## Current Rationalization Targets

The following cleanup is approved as follow-up work, not performed by this
documentation change:

- remove the standalone Desktop and Web GPU-streaming E2E cases after retaining
  the same assertion in their existing full flows;
- remove or replace the ambiguous Desktop pixel-change drag assertion;
- convert interface-shape-only Vitest cases to compile-time fixtures;
- stop running the CLI `run-slice` harness for both variants in every routine
  smoke when the bridge smoke already proves slice/export;
- split Electron E2E into a small default smoke group and an extended group;
- run the complete Web shared behaviour suite on one WASM variant and a focused
  capability plus import/slice/export flow on the other.
