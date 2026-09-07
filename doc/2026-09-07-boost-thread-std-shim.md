# Boost.Thread WASM compatibility shim

**Date:** 2026-09-07

**Status:** Implemented

**Scope:** Keep the WASM compatibility headers buildable in both artifact
variants while allowing the threaded variant to use Emscripten pthreads through
the C++ standard threading primitives.

## Accepted behaviour

- The serial wasm64 artifact keeps the existing deferred, serial
  `boost::thread` behaviour.
- The threaded wasm64 artifact implements the required `boost::thread` surface
  over `std::thread`; `join()` and `detach()` therefore run on real pthreads.
- `boost::mutex`, `boost::unique_lock`, `boost::lock_guard`, and
  `boost::condition_variable` use standard-library synchronization semantics in
  both variants. Waiting must atomically release and reacquire the associated
  lock; the compatibility layer must not lock an already-owned mutex a second
  time.
- Boost thread attributes remain source-compatible. The standard-thread
  implementation accepts the configured stack-size attribute but does not
  promise to apply it, because `std::thread` has no portable stack-size API.
- The existing oneTBB threaded slice path remains the production parallelism
  mechanism. This change does not re-enable dropped GUI, networking, or BBS
  background-manager code.

## Verification

- Compile-time shim tests cover serial and threaded thread construction,
  join/detach, mutex locking, condition-variable wait, and timed wait.
- The applicable WASM quick build and repository checks are run before
  handoff.
- The bridge smoke's floating-box regression preserves the model's existing
  X/Y placement while changing only Z, so its expected slicing error reaches
  the slicer instead of being masked by an unrelated plate-boundary error.
