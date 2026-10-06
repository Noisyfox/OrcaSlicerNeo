# Printer console and G-code control experience

**Date:** 2026-08-30

**Status:** Final user experience

**Scope:** The printer-console and printer-control experience shared by the
Electron desktop application and the Web application.

## Purpose

The application provides two connected but independent ways to use a user's
printer:

1. View and manage the printer's Web console inside the application.
2. Send G-code to the printer and optionally start a print through its HTTP
   API.

The embedded console is a convenience and management surface. Sending and
printing use the printer API directly, so either surface can continue to be
used when the other one is unavailable.

## Device page

Device is a top-level page alongside Workspace. Workspace contains only the
profile/settings sidebar and the 3D scene. Switching between pages preserves
the state of both surfaces.

The Device page uses the same card-style visual language as Workspace:

- The left card contains the saved printer list and an add-printer action.
- The right card contains the selected printer's embedded console.
- The sidebar can be resized, starts at 288 px, and stays between 220 px and
  560 px. Its width is remembered independently from the Workspace sidebar.

Each printer row shows its name and has separate Edit and Delete actions.
Deleting a printer requires confirmation. Adding or editing a printer opens a
configuration dialog.

## Printer configuration

The configuration dialog accepts:

- A display name.
- The built-in **Moonraker** adapter.
- A required **API base URL**.
- An optional **Console URL**.
- An optional, password-masked **API key**.

If Console URL is left blank, the embedded console uses the API base URL. A
separately entered Console URL is used as-is after normal URL validation.

Printer configurations are saved across sessions in the application's user
configuration. The same complete printer record is retained by Electron and
Web, including the API key when one is supplied. The API key is optional: a
printer without one can still be used for Moonraker operations that do not
require authentication.

## Console selection and behavior

The Device console selection is always explicit and is not saved. Adding a
printer does not select it automatically. If the selected printer is deleted,
the selection becomes empty and the console shows an empty state rather than
silently selecting another printer.

Selecting a printer opens its configured console in the right-hand card. The
console is a focused printer-management surface, not a general browser: the
application does not provide an address bar, history controls, or an editable
navigation target.

On Electron, a supplied Moonraker API key can be reused by the embedded console
so the user does not need to enter it again each time. On Web, the console is
shown in a normal iframe and keeps its own browser-managed login/session
behavior; the application does not inject the API key into the iframe.

The Electron adapter waits for the initial guest `dom-ready` event before
calling webview methods; attachment alone does not establish readiness.
Where document-start content-script registration is unavailable, the fixed
API-key wrapper is installed on each guest `dom-ready` event, including
guest-initiated reloads and navigations. This fallback cannot guarantee
injection before the console's earliest page scripts run.

Web embedding is best effort. Browser and printer policies, local-network
access, HTTPS/mixed-content rules, CORS, or a console's own framing policy may
prevent the console from displaying. The application reports the console
problem when it occurs and does not treat it as proof that direct printer
control is unavailable.

## Send G-code

After a successful slice, the toolbar provides two separate actions:

- **Send** uploads the G-code and leaves it on the printer.
- **Send & Print** uploads the G-code and starts printing after the upload
  succeeds.

The send dialog has its own printer selector, independent of the Device
console selection. It never remembers the selected target. A deleted or
otherwise unavailable target leaves the selector empty; the user must choose
a printer explicitly.

The API base URL and Moonraker adapter are required for sending. An API key is
not required; when it is empty, the application sends the request without an
API-key header. The Web application attempts the direct API request subject
to browser networking rules, while Electron can use its desktop networking
path. Compatibility is determined when the requested operation runs rather
than by a separate setup check.

The dialog shows upload progress and allows cancellation while an upload is
in progress. It displays sent/total byte sizes in binary units (B, KiB, MiB,
GiB), together with cumulative average speed in KiB/s. Every 500 ms, speed is
calculated as all bytes sent divided by elapsed time since the upload request
began, using the monotonic clock and excluding G-code export time. Reporting
gaps remain part of elapsed time rather than producing zero-byte sampling
windows. Each upload resets the measurement. When the browser
cannot determine the total size, the total is displayed as “Unknown”.

Electron writes the HTTP body in bounded chunks and reports intermediate byte
counts under socket backpressure. These counts describe bytes accepted by the
local network stack. After all bytes are sent, the dialog shows an indeterminate
“Waiting for printer confirmation…” status with complete byte counts and
0.0 KiB/s. Transfer percentages never round an incomplete transfer up to 100%.
Upload success requires a successful response with a valid remote file path.
Send & Print then shows a separate indeterminate “Starting print…” status and
hides upload statistics. Cancellation remains available while waiting for
upload confirmation. Web uses browser-native XMLHttpRequest upload progress
events for byte counts; it does not split the file into separate upload requests.

If Send & Print uploads successfully but starting the print
fails, the dialog explains that the file is already on the printer and offers
a start-only retry. Retrying does not upload the file again.

On success, the dialog counts down from five seconds before closing. The
**Close and switch to Device after sending** option is persisted and enabled
by default. When enabled, the success message counts down to closing and
switching to Device; when disabled, it only counts down to closing. The
printer selector and this option are disabled while sending and during the
success countdown. Close remains available for early dismissal. Errors,
cancellation, and a failed print start never navigate to Device.

## Platform differences

Electron provides the richer embedded-console experience, including automatic
Moonraker API-key reuse when a key is configured. Web provides the standard
iframe console experience and does not inject scripts into the embedded page.
Both platforms retain the same printer configuration, independent selections,
Moonraker Send/Send & Print behavior, and best-effort handling of actual
network or printer failures.

## G-code filename generation

Export and Send obtain the recommended filename from the completed plate's
retained native `Print::output_filename()` and original Orca ASCII folding
(`fold_utf8_to_ascii(..., false)`). The retained Print owns that generation's
model, configuration and final statistics. Naming validates the slice receipt,
rejects active slicing and stale results, and reads the existing immutable
G-code source without another export pass. Timestamp placeholders are evaluated
for each naming operation. The project's actual opened or saved filename
supplies a basename override; an unsaved session supplies an empty override so
Orca derives the name from printable objects.

The typed runtime request requires both `receipt` and `filenameBase`; successful
results expose only `fileName` and `bytes`. The temporary path remains private
to the native bridge and typed client. Send uses the generated basename directly
without a rename control. Existing extensions are preserved by the native naming
logic; neither ASCII folding nor the naming API performs business-level illegal
character replacement.

Export suggests the generated basename to the host. Electron uses its native
Save As dialog with a filter derived from the generated extension and reports
cancellation separately from a completed write. Web starts a browser download
directly with the generated basename, preserving arbitrary extensions and their
case. The application adds no filename validation or replacement; the native
dialog or browser handles platform restrictions and any user rename. A cancelled
native save does not mark the slice result as exported. Web cannot observe the
browser's final saved filename or whether the user cancels its download prompt.

Send retains the first successfully generated basename while retrying an upload
of the same slice receipt. Each retry still revalidates the native export; a
stale receipt or filename template error prevents another upload. Reopening the
dialog or using another receipt creates a new naming operation. Print start and
its retry use the actual path returned by Moonraker, rather than the local name.

Native multipart header encoding uses quoted-pairs for quotes and backslashes;
CR/LF are percent-encoded to keep them out of header lines. Web uses browser
FormData encoding. Chromium percent-encodes a quote as `%22`, and Moonraker's
StreamingFormDataParser uses Python's HTTP email header parser, which does not
URL-decode plain `filename` parameters. Consequently browser wire encoding can
affect the printer-side name of unusual characters; the application does not
replace those characters or claim identical decoded names across hosts.

The focused real-WASM naming contract is
`node packages/slicer-wasm/harness/gcode-filename-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`.
It covers template defaults, empty/custom formats, real statistics, per-plate
names/numbers, Unicode folding, extensions, template errors, per-operation
timestamps, generation reuse and stale receipts.

## Upload verification

`pnpm test` and `pnpm typecheck` cover the shared component and both host
boundaries. The upload tests include a real 32 MiB HTTP request paused at the
receiver, byte-for-byte multipart fidelity, write failures, cancellation and
late callbacks. Component tests cover sampled speed, delayed progress events,
reset on retry, unknown totals, confirmation waiting and print-start staging.

The Electron mock validation uses `VITE_USE_MOCK=1` with
`pnpm --filter @orca/desktop exec electron-vite build --mode e2e`, followed by
`pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs` and
`pnpm --filter @orca/desktop exec playwright test e2e/printer-control.e2e.ts e2e/app.e2e.ts --grep 'Send|Device config|full v1 flow'`.
The fixture holds the upload response until the UI shows complete byte counts,
zero speed and confirmation waiting without 100%, then verifies success and
start-only retry. The current checks pass: 1,647 unit tests, all workspace
typechecks, renderer build/CSS validation and four focused Electron E2E tests.
Physical-printer and minutes-long real-network transfer
verification remain unavailable. WASM builds and real Web E2E are outside this
UI/transport-only correction's scope.
