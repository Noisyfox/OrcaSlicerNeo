# Prime Tower History Restore Remediation

**Date:** 2026-09-11
**Status:** Implemented

## Accepted behaviour

- A Prime Tower coordinate frame is a Worker-owned optimization for the
  adjacent coordinate transition it records. It is never authority to omit a
  target model or complete project context during history navigation.
- Undoing or redoing a mixed sequence, including Prime Tower followed or
  preceded by an ordinary model, structural, or filament mutation, prepares
  and atomically restores the target model and complete Worker context.
- The coordinate-only fast path remains valid only for an adjacent Prime Tower
  transition. Directional jumps that cross another project frame use the full
  restore path.
- Prime Tower checkpoints retain the normal complete history context while
  sharing the current model blobs. The narrow direct frame retains only the
  coordinate transition payload; React remains a projection consumer and
  owns no model history.

## Verification boundary

- Native history coverage proves that a narrow target still supplies its model
  to a mixed Undo/Redo plan and that a directional jump cannot select the
  narrow fast path when it crosses an ordinary mutation.
- The real-WASM Prime Tower smoke covers mixed model restoration, reverse
  navigation, and directional jump behaviour in the serial and threaded
  artifacts.
