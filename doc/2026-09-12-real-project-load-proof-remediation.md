# Real Project Load Proof Remediation

Date: 2026-09-12
Status: Verified
Scope: Make the desktop real-project regression prove that the selected 3MF
reached a committed native project session before viewport, history, or slicing
assertions run.

## Accepted behavior

- A real-project E2E identifies its requested 3MF by exact base filename and
  byte length at the shared project-action boundary. Electron paths remain
  host-private; the shared session retains only an opaque location.
- The E2E observes the completed native result, including its commit route,
  mode, native display name, object/instance counts, project-setting status,
  and multi-plate metadata. A preflight route is accepted only after
  `commitProjectPreflight` has completed; a staged preflight is not evidence of
  a loaded project.
- The same evidence also proves the committed shared session has the expected
  project name, `project` preset scope, content, and opaque location.
- The Odyssey multi-colour 3MF regression requires a committed project-mode,
  settings-bearing, multi-plate native result with non-zero object, instance,
  and plate counts. It cannot pass using an empty session or a geometry-only
  fallback.

## Decision

`openProject` now returns a narrow `ProjectLoadReceipt` only after it has
applied the native result, reset history, and published the project session.
The E2E-only renderer hook reads that receipt plus safe session identity fields;
it contains no filesystem path or location token. The real desktop runner runs
the proof before its Prime Tower project scenario.
