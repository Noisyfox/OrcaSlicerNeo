# Real WASM E2E Startup Timeout

Date: 2026-08-18
Status: Implemented

The real Electron WASM test loads and parses the complete vendor preset bundle
before the preset selector becomes available. This is materially slower than
the mock module and can exceed the former 120-second Playwright test timeout
on a busy machine.

When `ORCA_E2E_REAL=1`, the E2E suite now allows five minutes for the first
preset selector and eight minutes for each scenario. Mock-mode tests retain
their short readiness timeout and two-minute overall test timeout. The longer
limit is deliberately scoped to the real module, rather than masking ordinary
UI regressions in the mock suite.
