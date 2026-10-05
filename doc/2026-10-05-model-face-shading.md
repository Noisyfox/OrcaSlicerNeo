# Model Face Shading

Date: 2026-10-05
Status: Implemented and verified.

## Behavior and cause

Indexed model geometry shares vertices across sharp edges. Averaging those
vertices' normals and interpolating them in the material produces artificial
gradients and radial triangle streaks on planar surfaces.

Ordinary and MMU-painted model materials use per-face shading in Prepare and
Preview. Plate thumbnails use the same shading. This follows Orca's default:
`GLModel::init_from` uses per-face normals unless the optional smooth-normal
setting is enabled; `AppConfig` defaults that setting to false.

Three.js flat shading derives a face normal in the fragment shader. Existing
indexed buffers, geometry sharing, BVH picking, painting groups, transforms,
and opacity rules remain valid without expanding the mesh into triangle soup.
Curved surfaces expose the source mesh's facets, as in Orca's default mode.

This is shared Web/Electron rendering with no host or WASM protocol changes.
It adds no geometry memory or loading work. Mobile input and support are
unchanged from the desktop scope of the
[shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md).

## Verification

Follow the [testing guidelines](testing_guidelines.md): root unit tests and
typechecks, thumbnail material regression, and focused Electron ordinary and
painted model rendering/picking flows. The supplied screenshot's original
model file is unavailable, so exact before/after reproduction is not claimed.

Passed checks:

- `pnpm test`: 158 test files, 1519 tests passed.
- `pnpm typecheck`: all workspace packages passed.
- `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`
  with `VITE_USE_MOCK=1`, both with and without
  `VITE_MOCK_PAINTED_FACET_FIXTURE=1`.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts
  e2e/painted-facet.e2e.ts --grep 'full v1 flow|Prepare painted model'
  --workers=1`: two painted-fixture tests passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts
  --grep 'full v1 flow' --workers=1`: ordinary unpainted-model flow passed.
- `git diff --check`: passed.

No WASM build or real-model/Web E2E was run: the change is limited to shared
model materials and adds no host/runtime boundary. Electron mock tests assert
actual scene materials and preserve the existing painting BVH interaction test.
