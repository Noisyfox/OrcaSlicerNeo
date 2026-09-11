# History Epoch Ownership Remediation

**Date:** 2026-09-11
**Status:** Implemented

## Accepted behaviour

- `BridgeState::history_revision` is the Worker-owned mutation epoch, not a
  plate input revision or a React projection generation.
- Normal mutation, restore, initialization, reset, and externally visible
  abort paths advance it only through `HistoryMetadata::advance_history_epoch`.
- Exceptional transactional compensation restores its captured epoch directly;
  it is not a normal publication path and never creates a backwards-visible
  receipt.
- Per-plate input revisions and renderer restore generations remain separate
  concepts and must retain their explicit names.
