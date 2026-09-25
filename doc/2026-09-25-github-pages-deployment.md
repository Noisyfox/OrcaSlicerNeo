# GitHub Pages deployment

**Date:** 2026-09-25
**Status:** Pages deployed; CI fixes under pull-request validation

The public project site is published from `main` by the existing
`.github/workflows/ci.yml` workflow at
`https://noisyfox.github.io/OrcaSlicerNeo/`. The repository's default branch
is `main`; it has no `master` branch. GitHub Pages must use **GitHub Actions**
as its publishing source. The WASM dependency job prepares the shared compiled
dependency cache, then two runners build the threaded and serial cores
concurrently. The Pages job downloads both artifacts from that same run and
the packaged profiles, builds the Web host, checks its subpath behavior, and
uploads `apps/web/dist`. Pull requests run this Pages build and its checks,
while the deploy job runs only for pushes to `main`.

GitHub Pages serves HTTPS but does not provide the COOP/COEP response headers
required by threaded WASM. The runtime therefore selects the existing serial
wasm64 fallback. Chrome 133 or later and WebGL 2 remain required.

`scripts/prepare-web-pages.mjs` removes debug WASM, source maps, and profiling
artifacts copied from the shared desktop public directory. It verifies the
HTML, profile manifest, and six production WASM files, adds `.nojekyll`, and
rejects a site over the 1 GB Pages limit. The ordinary Web build still carries
both variants for hosts that provide cross-origin isolation.

The repository's Pages source must be set to GitHub Actions once. Thereafter,
each push to `main` publishes the current site after the WASM job and Web
tests/typecheck pass.

The first CI run reached the existing Linux WASM builder and found that the
OCCT helper was invoked directly despite lacking an executable Git file mode.
The builder now invokes that helper through `bash`, like its other helpers.
The next run compiled WASM, then found that the bridge smoke requires the
profile manifest. The existing profile-pack job now uploads its output once;
the WASM smoke and Pages build download that same artifact.

The WASM dependency job restores a cache of fetched sources and compiled
Boost, oneTBB, Draco, and OCCT dependencies. Its key includes the Emscripten
version and the dependency fetch/build scripts, OCCT patches, and FreeType
probe; changes to the core build script or pinned slicer source do not
invalidate it. A cache miss compiles both threaded and serial dependency
variants, verifies their staged files, and saves the cache before compiling
either core. A cache hit
skips dependency compilation. The two core jobs restore the same cache and
refresh the small generated headers with the idempotent fetch script. Each
job uploads its own variant; downstream jobs wait for both.

The first dependency-cache run built both variants, but its verification step
looked for the Boost filesystem archive name produced on Windows. Linux's
`b2` stages `libboost_filesystem.a`; the verification now accepts either
platform's suffix before saving the cache.

The first successful Pages run exposed failures in older desktop CI jobs. The
real Electron E2E and installer jobs now download both WASM variants and the
same packaged profiles as Pages, check out the pinned C++ resources, and run
the current `scripts/stage.mjs`. Mock E2E also checks out those resources.
Unit tests and typechecks remain independent of generated WASM; Electron
build coverage comes from mock E2E and the packaging matrix. The atomic-file
test now checks sibling placement using the host platform's path rules.

On a failed E2E job, Playwright retains a trace and CI uploads `test-results`
for diagnosis.

The installer matrix runs one job for each of the six platform and architecture
targets. The electron-builder target configuration leaves architecture selection
to each job's CLI flag; an explicit one-installer check guards against the
builder silently producing both architectures. Each installer is uploaded as
its own artifact.
Pass matrix flags directly after the pnpm script name. An extra `--` reached
electron-builder literally, causing arm64 jobs to package the host's x64
architecture; the one-installer check exposed this before upload.

The desktop's main and preload bundles have no external production imports,
and the renderer is bundled by Vite. Exclude production `node_modules` from
electron-builder's file collection so packaged installers do not carry the
WASM workspace source tree and temporary `.work` dependency builds. Keep
staged `out/renderer/wasm` and `out/renderer/profiles` as the runtime assets.

The mock Electron E2E suite runs on a Windows runner and its 50-test flow
passes locally and in the pull request. The real WASM E2E job remains on Linux
to exercise that host separately.

Mock E2E also downloads the profile-packages artifact. Soft staging now copies
profiles even without a WASM build, matching the asset set used by local E2E.
On a clean checkout, the Preview nozzle marker assertion failed without those
profiles and passed after staging them.

The Prime Tower E2E history helpers close their menus through the trigger:
pressing Escape could also invoke Prepare's global deselection shortcut and
leave the menu's inert overlay over the toolbar. The helpers wait for the Undo
trigger and first entry to become available, then wait for the menu to close before
testing gizmo hover. After a canceled drag, the test releases the held mouse
button and reselects only if cancellation cleared selection.

The real-project plate-switch test observes the next renderer frame instead of
Playwright's backoff intervals. The hosted Linux runner still reports roughly
0.5–1.5 seconds against about 0.1 seconds locally for the same project. CI
omits the plate-switch and other performance/profile E2E cases while retaining
the real WASM functional cases. Local runs keep the 500 ms cold and 250 ms
steady-state budgets and all profiling cases.

The hosted Windows runner reports a 1024×768 screen and starts Electron with a
1024×720 content viewport. The local desktop uses a roughly 1280×800 viewport.
Set the mock canvas test launch viewport to 1280×800 before the scene mounts,
so world-to-screen projection and pointer gestures use the same dimensions.

For a body drag, the first movement can only claim DragControls ownership on a
loaded runner; the E2E sends another movement in the same held gesture before
asserting translation. While a Prime Tower native move is pending, a model
mesh republish prunes stable selection IDs instead of resetting scene
interaction, preserving the selected tower through its authoritative receipt.
The Prime Tower E2E sends pointer-down and threshold-crossing movement through
Electron's native input channel in one task, like the passing model-body drag
test, then continues the held gesture before releasing it.
For the non-current tower near a canvas edge, the real E2E crosses the drag
threshold inside the canvas before moving toward an outside boundary. It waits
for the previous native tower commit to finish before starting that gesture.
After exporting G-code, the real E2E checks the current plate in the plate
session. The raycast bed projection can be absent while the scene changes to
Preview, while the plate session is the target used by the export command.
