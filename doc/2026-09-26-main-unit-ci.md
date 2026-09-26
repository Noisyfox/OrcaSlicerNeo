# Main unit CI teardown failure

**Date:** 2026-09-26
**Status:** Pull-request validation

The first `main` run after the Pages CI pull request passed all 646
`slicer-app` assertions but failed the unit job on an unhandled Vitest
`EnvironmentTeardownError`. Importing `ToolpathMarker.tsx` started an
unawaited dynamic import of `@orca/slicer-runtime` even when a test only used
its pure marker helpers. The asynchronous import could still be resolving
when Vitest tore down that test file's environment.

Start the runtime import only when `loadHotendBytes` is called by a rendered
marker. Its existing per-profile promise cache keeps repeat reads shared.
Pure helper imports no longer start background work. The unit job remains a
required CI check.
