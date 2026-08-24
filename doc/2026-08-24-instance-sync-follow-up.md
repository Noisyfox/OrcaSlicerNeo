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
