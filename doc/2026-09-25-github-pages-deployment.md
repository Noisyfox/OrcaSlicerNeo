# CI Assets, Packaging and GitHub Pages

**Updated:** 2026-10-24
**Status:** Current deployment reference

## Pages pipeline

[CI](../.github/workflows/ci.yml) builds the static Web host and checks non-root
deployment on pull requests. Deployment runs only for pushes to `main`, using
GitHub Actions as the Pages publishing source. The configured project URL is
`https://noisyfox.github.io/OrcaSlicerNeo/`.

Both WASM variants and the packaged profiles come from the same workflow run.
The Pages build tests/typechecks Web, builds it, runs
`node apps/web/scripts/non-root-smoke.mjs`, and prepares `apps/web/dist` with
`node scripts/prepare-web-pages.mjs`. Preparation verifies HTML, the profile
manifest and six production JS/WASM/data files, strips other WASM-directory
content (debug/profiling artifacts and maps), writes `.nojekyll`, and rejects
artifacts over 1,000,000,000 bytes.

The ordinary Web build retains both variants for isolated hosts. On Pages,
without COOP/COEP headers, runtime selection uses serial wasm64. Keep the
Chrome 133+ and WebGL 2 capability gates; HTTPS alone does not enable threads.
Asset URLs must work under the project subpath.

## Dependency and asset ownership

The dependency job caches fetched/compiled Boost, oneTBB, Draco, NLopt and OCCT.
Its key includes the SDK version, dependency scripts, OCCT patches and FreeType
probe. Core source or core-driver changes alone do not invalidate dependency
compilation. A miss builds/verifies the required variants and saves the cache
before core jobs run; core jobs restore it and refresh generated headers through
the idempotent fetch script when their production-artifact cache misses.

Each WASM variant caches its production output only after all of that job's
native tests and smokes pass, including serial publication-rollback injection.
The artifact key includes the superproject's pinned Orca submodule commit (no
submodule file-content hashing), Emscripten version and native build inputs.
Standalone test sources, harnesses, fixtures, JS dependencies, profile-packaging
code and workflow test steps do not participate in the artifact key. Changes
only to those inputs reuse an available exact cache and skip native tests;
a miss still runs every native test before saving. Native build scripts and
CMake configuration remain inputs even when an edit concerns their test logic.
Only an exact hit skips that variant's
toolchain/dependency setup, compilation and native tests/smokes. Test-enabled
build trees are never cached. Both hits and misses upload the production
artifacts for the current run, including the legacy threaded copy. Dependent
host jobs await both core artifacts and still run their own checks.

Invoke shell helpers through `bash` in Linux CI rather than depending on
executable Git file modes. Verify Boost archives using the platform's staged
name rather than assuming the Windows suffix. Linux CI commands do not change
the Windows cmd-native development rule.

Profile packages build independently of WASM and are uploaded once. Native
smokes, Pages, real Electron E2E and packaging use the same profile artifact.
Mock E2E also needs profiles and pinned native resources; soft staging copies
profiles even without WASM. Unit tests and typechecks remain independent of
generated WASM. Failed E2E preserves Playwright traces and uploads `test-results`.

## Desktop packaging

Each of the six platform/architecture entries produces exactly one installer,
checked by `scripts/verify-installer.mjs`, with architecture selected by the
job's CLI flag. Pass flags directly after the pnpm script name; an extra `--`
can reach electron-builder literally and select the wrong architecture. The
workflow owns exact target suffixes and runner choices. Each target uses a
matching native runner and Node architecture so its Node-API addon can be built
and exercised in the packaged application.

JavaScript production dependencies are bundled by Vite. Exclude production
`node_modules` from electron-builder file
collection so installers do not include workspace source and `.work` builds.
Staged `out/renderer/wasm` and `out/renderer/profiles` remain runtime assets,
unpacked according to
[electron-builder configuration](../apps/desktop/electron-builder.yml).

The desktop dev/build and ordinary E2E entry points prepare the host Bambu
addon and acquire the pinned precompiled plugin through
[`bambu-native` staging](../packages/bambu-native/scripts/stage.mjs).
The packaging hook performs the same preparation for the requested native
target. It verifies the archive checksum, preserves the complete plugin library
directory and stages Orca's complete public certificate directory, including
`slicer_base64.cer` and `printer.cer`. Explicit
`extraResources` place these files under `resources/bambu` outside asar;
the installed app loads only bundled resources and does not download a plugin.
`npmRebuild: false` remains intentional because the hook owns addon compilation.

Production renderer builds select real WASM through the production environment;
mock E2E retains its separate build mode. Package scripts stage the current
WASM/profile assets before bundling. The package matrix runs real-plugin
startup, provider configuration restart and isolated-login/system-browser
handoff probes against each produced app directory. Login-page fixtures prove
host integration; real account authentication and LAN hardware journeys remain
separate qualification requirements in the
[Bambu design](../spec/Printer%20Domain%20and%20Control%20Architecture.md#22-bambu-implementation-and-acceptance-sequence).

Mock Electron E2E uses Windows and real Electron E2E uses Linux in the current
workflow. Hosted functional verification does not replace local performance
budgets or macOS native menu qualification. Shared input, export-completion
and artifact-identity rules live in [testing guidelines](testing_guidelines.md).
