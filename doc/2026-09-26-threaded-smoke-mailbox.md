# Threaded bridge smoke mailbox

**Date:** 2026-09-26
**Status:** Pull-request validation

The first `main` CI run after the Pages changes also failed its threaded
bridge smoke. The native build and cube slice passed. In the cancellation and
replacement scenario, the harness awaited the replaced task first and drained
all pending FIFO messages, discarding the cancelled and replacement task
terminals if they arrived in the same batch. Both later waits timed out after
120 seconds.

The harness now retains terminals by task ID and entry incarnation until their
respective waits consume them. The bridge smoke uses the shared mailbox helper
and continues collecting all messages for its FIFO assertions. A deterministic
test feeds the three task terminals in one drain and checks that each waiter
receives its own result.
