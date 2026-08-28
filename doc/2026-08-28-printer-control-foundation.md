# Printer Control Foundation

**Date:** 2026-08-28

**Status:** Delivered — implementation step 1

**Scope:** Platform-neutral printer configuration and Moonraker HTTP control
contracts for the later Device and Send flows.

## Boundary

`@orca/printer-control` owns version-1 configuration validation, the closed
built-in driver registry, Moonraker protocol semantics, and upload orchestration.
It has no Electron, Node, UI, iframe, or platform-storage dependency. Hosts
inject a `PrinterTransport`; the driver receives a complete validated printer
record and never reads storage or performs a connectivity preflight while
configuration is loaded.

Configuration stores multiple stable-ID records. Display names may repeat,
API keys are retained in full in the version-1 document, and console/API base
URLs are independently canonicalized HTTP(S) URLs without credentials.

## Moonraker protocol

The first driver calls `GET /server/info`, sends `X-Api-Key` only for a
non-empty key, uploads multipart form data to `POST /server/files/upload` with
`file` and `root=gcodes`, and extracts the returned remote path. Starting is a
separate JSON `POST /printer/print/start` request using that exact path. Status
uses the printer object query; pause, resume, and cancel send the corresponding
Moonraker G-code commands.

The service exposes upload-only and upload-then-start orchestration. If upload
succeeds but start fails, it raises `start-failed-after-upload` together with
the uploaded remote file so callers can deliberately retry start; it never
re-uploads silently.

## Verification

The package has fixture-style fake-transport Vitest coverage for configuration
normalization/validation, request methods/URLs/authentication and multipart
shape, upload-only, successful upload-then-start, start failure after upload,
and empty API-key behavior. Run `pnpm --filter @orca/printer-control test`,
`pnpm --filter @orca/printer-control typecheck`, and the related workspace
typecheck before handoff.
