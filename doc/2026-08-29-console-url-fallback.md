# Optional console URL fallback

**Date:** 2026-08-29

The printer configuration dialog now presents the required Moonraker API base
URL before the optional embedded-console URL. A blank console URL is accepted
and remains blank in the saved configuration. When the Device page opens a
selected console, the shared lifecycle boundary resolves that blank value to
the configured API base URL. A distinct console URL is preserved and loaded as
entered after normal URL canonicalization.

Keeping the fallback at load time avoids rewriting user configuration or
making the API driver depend on the console presentation setting. The API base
URL remains required for direct printer control and for the fallback target.
The form marks Console URL optional and its empty state is shown only when no
printer is selected.

Coverage includes blank/invalid configuration normalization, form order and
optional validation, effective target selection, built-in script injection
ordering, and the existing edit/lifecycle integration tests.
