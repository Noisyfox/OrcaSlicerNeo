# Instance and part transform synchronization follow-up

The renderer creates one `GLVolume` composite for each `(objectIdx, volumeIdx,
instanceIdx)` combination, but the native model stores a part's
`ModelVolume` transform once per `(objectIdx, volumeIdx)`. Therefore a
part-scoped edit must update the `volumeTransform` on every rendered copy with
the same object and volume indices. Per-instance transforms remain keyed by
`(objectIdx, instanceIdx)` and are not changed by a part edit.

`SceneInteractionController` enforces this invariant when applying volume
targets. The focused part-scoped tests cover movement and scaling across both
instances, verify that sibling parts remain unchanged, and verify that
instance offsets are preserved.

ObjectList mutations have a related ordering invariant: every operation that
changes model metadata or structure must await `waitForSettledModelTransforms`
before invoking its runtime bridge method. Transform persistence snapshots use
positional object/volume indices, so deleting, reordering, splitting, cloning,
or changing printable/type state while a snapshot is still pending could apply
that snapshot to a different entity. A failed settled sync aborts the ObjectList
mutation and leaves the bridge untouched; callers receive the failed
`MutationOutcome` for display and retry handling.

The client mock follows the same model shape. It stores instance placement
transforms per object instance, but stores each part transform once per object
volume and returns that shared value for every rendered instance. Structural
operations derive bounds from the live per-object arrays, so an instance added
after load can be transformed and returned by `getModelMesh` even when the
initial fixture had one instance. Focused client tests cover add → transform →
mesh persistence and propagation of a part transform to all instances.

The bridge smoke harness now preserves the result of its checks for process
automation: if any `check` call fails, it prints an aggregate error and exits
with status 1. A clean run leaves the exit status at 0, while real smoke
failures are no longer silently accepted by CI or build scripts.

## Instance rotation and scale synchronization

The renderer now follows OrcaSlicer's `Selection::synchronize_unselected_instances`
implementation (`packages/slicer-wasm/cpp/src/slic3r/GUI/Selection.cpp`, around
`Selection::rotate`, `scale_and_translate`, and
`synchronize_unselected_instances`). When an instance-scoped edit changes the
linear transform, the selected instance's relative linear change is applied to
the other instances of the same object. This shares scale and X/Y orientation
while preserving each instance's independent rotation around world Z. A pure
Z rotation intentionally does not synchronize other instances. Translation and
the existing part-scoped volume fan-out retain their previous behavior.

## Shared instance Z position

Every instance of the same object shares one world-space Z position. An
instance-scoped edit propagates the source instance's absolute Z translation
to all of that object's copies, including transforms represented by an
authoritative affine matrix. X and Y placement remain per-instance.
