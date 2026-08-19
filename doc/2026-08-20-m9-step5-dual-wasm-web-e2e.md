# M9 Step 5 — dual wasm64 delivery and Web verification

Step 5 completes the Web–Electron migration boundary. `packages/slicer-wasm/build.sh`
now keeps separate CMake/build/output trees for `threaded` and `serial` wasm64
variants; `scripts/build-wasm-dual.sh` builds both and stages each complete
`orca_slice.js/.wasm/.data` set under `wasm/<variant>/`. The serial build uses
the existing TBB shim, while the threaded build requires the pinned oneTBB
pthread archive. Both variants use the same bridge/client TypeScript contract.

The runtime Worker selects `threaded` only when the page is cross-origin
isolated with SharedArrayBuffer support; otherwise it loads `serial`. Vite
dev/preview retain COOP/COEP headers for the normal threaded path, while a
deliberately header-free server exercises the serial path. The web capability
probe and status use the same isolation/SAB condition.

Verification target: `pnpm test`, `pnpm typecheck`, the dual-artifact build and
Node bridge smokes when Emscripten dependencies are available, Chrome Web E2E
for threaded and serial deployments, and the existing Electron E2E suite.
