# Profile compatibility UI end-to-end coverage

The desktop E2E suite contains `e2e/profile-compatibility.e2e.ts`. It uses
the existing deterministic mock preset graph to exercise the shared app's
runtime transition, rather than duplicating compatibility filtering in the
test or in React.

The test slices a model, changes from the mock X1C printer to the mock P1S
printer, and verifies all of the following:

- every preset selector is locked while the atomic selection snapshot is in
  flight;
- the resolved Printer, Process, and Filament trigger values update together;
- the Process and Filament popups contain exactly the P1S-compatible source
  candidates (and no stale X1C candidates);
- the prior slice result, layer control, and G-code export are invalidated.

`VITE_MOCK_PRESET_TRANSITION_DELAY_MS` exists solely in the desktop E2E mock
build to make the short in-flight state observable. Production builds never
enable the mock module or set this variable. The companion real-WASM fixture
coverage remains documented in `doc/2026-08-30-preset-compatibility-fixture.md`.

Run it with the normal desktop E2E command:

```powershell
pnpm --filter @orca/desktop test:e2e
```
