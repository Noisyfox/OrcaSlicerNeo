# Threaded WASM Progress Mailbox Design

Date: 2026-08-18
Status: Implementing
Scope: Deliver detailed slice progress from oneTBB pthreads without invoking a
dynamic JavaScript function-table entry.

## Problem

`Print::set_status_callback` may run on any oneTBB worker. The former bridge
called a JavaScript function registered through `Module.addFunction` from that
callback. In Chromium, a pthread's Wasm instance can have an older function
table than the instance which registered the dynamic function; invoking it
traps with `table index is out of bounds`, which appears in the app as
`Error: unwind`.

Proxying the callback to the module worker would avoid that table mismatch, but
would not give live UI updates: that worker is occupied by the synchronous
`orc_slice` bridge call until slicing returns.

## Design

The threaded bridge exposes one fixed-layout mailbox in shared Wasm memory:

| Offset | Field | Meaning |
| --- | --- | --- |
| 0 | `uint32 sequence` | Seqlock generation; odd while being written |
| 4 | `uint32 percent` | Latest slicer progress, clamped to 0–100 |
| 8 | `uint32 text_length` | UTF-8 byte length of the status text |
| 16 | `char text[512]` | Latest UTF-8 status text, truncated safely |

The status callback only updates this mailbox. A mutex serializes concurrent
oneTBB status writers; the sequence number brackets every update with release
ordering. No C++ worker invokes JavaScript.

On module initialization, the module worker sends the mailbox location and its
`SharedArrayBuffer` to the renderer. The renderer polls it at a short interval,
reading the sequence before and after the payload. It discards a torn/odd read
and emits only completed generations through the existing progress listener
API. Since this happens on the renderer, it remains live while the module
worker is in `orc_slice`.

The serial artifact retains its existing one-time `addFunction` callback:
there are no Wasm pthread instances in that artifact, and this preserves its
current progress behavior. The threaded bridge ignores raw callback
registration defensively, so external callers cannot re-enable the unsafe
path.

## Verification

1. Unit-test the threaded mock mailbox protocol: it emits detailed status
   without calling `addFunction`.
2. Rebuild the threaded module and extend bridge smoke to verify the mailbox
   layout and changing sequence around a real slice.
3. Run the all-core two-`3DBenchy.stl` Electron regression using `Anker M5 0.4
   nozzle` (no exclusion area), and assert progress reaches completion without
   `unwind`.

