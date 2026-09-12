# Prime Tower Port Naming Remediation

**Date:** 2026-09-12
**Status:** Implemented
**Scope:** Clarify the two distinct viewport mutation boundaries without changing
their behavior.

## Accepted decisions

- `PrimeTowerCommandPort` is the Worker-facing command boundary consumed by
  `WipeTowerVolumeCollection`. It owns authoritative move, reconciliation,
  revision, and history-status operations for a Prime Tower.
- `SceneEntityCommitPort` is the scene-controller boundary for committing a
  changed scene entity after its local draft transform. Its controller-facing
  contract remains independent of Worker command details.
- The shared interaction state machine, Worker FIFO, revision validation,
  authoritative projection publication, and history behavior are unchanged.
