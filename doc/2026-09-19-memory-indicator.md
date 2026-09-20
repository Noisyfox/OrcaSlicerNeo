# Memory Indicator

**Date:** 2026-09-19

**Status:** Implementing

**Scope:** Shared application status-bar memory indicator for the Electron and
Web hosts.

## Accepted behaviour

The right side of the shared status bar shows the current application memory
figure. Activating it opens a popup with a total and two labelled groups:

- **Platform memory** contains host-provided, additive entries. Electron
  reports the sum of every associated process working set and groups that sum
  by Electron process type. The Web host does not invent platform entries.
- **Shared runtime diagnostics** contains renderer JavaScript heap, slicer
  Worker JavaScript heap, and the Worker WASM linear-memory capacity whenever
  they are available. These values are explicitly labelled as already included
  in a full total and are never added to it a second time.

On Web, the shared application uses complete browser page-and-Worker memory
measurement when it is available. Otherwise the status bar says **JS heap
estimate** and sums the renderer and Worker used JavaScript heaps. WASM linear
memory capacity remains a diagnostic only. A failed or unavailable sample shows
**Memory unavailable** and the popup explains the condition; the next scheduled
sample retries automatically.

Sampling starts immediately when the popup opens and otherwise runs every five
seconds. Sampling continues while the host is backgrounded; browser scheduling
and throttling remain host-controlled.
An in-flight complete browser measurement is shared by subsequent samples and
is given one second to respond; timeout transparently uses the JS-heap estimate
instead of leaving the status indicator in a loading state.

## Boundaries

The platform contract models generic labelled memory entries and a platform
snapshot. It contains no Electron process categories or Web-specific metrics.
The shared application owns collection of renderer and Worker diagnostics. The
Worker exposes its JavaScript heap and WASM-buffer capacity through the typed
runtime/client boundary; application components never access an Emscripten
module directly. Electron-only process metrics cross the existing
main/preload/adapter boundary as validated, read-only IPC data.

## Impact

This is a desktop-oriented status affordance. Mobile is deferred with the
product's existing desktop-only policy. The feature creates one bounded,
non-overlapping asynchronous sample per five-second interval and retains only
the most recent result. It introduces no profiling build flag, production test
hook, native bridge instrumentation, or cache/eviction policy.
