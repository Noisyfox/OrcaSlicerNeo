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
