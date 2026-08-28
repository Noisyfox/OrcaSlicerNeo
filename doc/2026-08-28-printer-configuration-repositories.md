# Printer Configuration Repositories

**Date:** 2026-08-28

**Status:** Delivered — M14 implementation step 2

**Scope:** Persist the version-1 printer configuration document behind the
shared platform contract for the Web and Electron hosts.

## Boundary

`@orca/platform-contract` exports `PrinterConfigurationRepository` with
`load()` and `save(document)` and exposes it as the required
`PlatformCapabilities.printers.configuration` capability. The document type
and normalization/validation rules remain owned by `@orca/printer-control`.
The repository is storage-only; it does not perform HTTP requests or expose a
transport seam.

## Host storage

Web stores the normalized complete document, including API keys, under the
versioned `orca-slicer-neo:printer-configuration:v1` localStorage key. Missing,
unparseable, invalid, or unavailable storage returns an empty version-1
document and keeps an in-memory copy for the session. Save normalizes before
writing and does not log document contents.

Electron stores the same JSON document at `userData/printer-config.json` via
typed preload IPC. Main-process reads validate and normalize input, treating
missing, malformed, invalid, and file errors as an empty document. Writes
accept only validated configuration documents and never include the document
or API key in diagnostics. The renderer sees only the narrow repository API;
filesystem and Electron APIs remain host-private.

## Verification

Coverage includes Web missing/corrupt/invalid fallback, complete-key round
trip, and multiple records; Electron preload/adapter IPC payload shape and
complete-key round trip; and main-process persistence helper behavior. The
workspace typecheck, tests, and `git diff --check` are the release checks for
this step.

## Acceptance hardening

The desktop rotate/scale E2E exposed a pre-existing stale screen-coordinate
assumption in its Z-ring hover setup. The test now probes the live
screen-space ellipse perimeter, avoiding center/edge handles, without changing
the product gizmo or extending polling timeouts. This is independent of the
printer persistence behavior.
