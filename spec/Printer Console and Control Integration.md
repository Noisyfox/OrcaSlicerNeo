# Printer Console and Control Integration

**Updated:** 2026-10-23

**Status:** Current console/Send experience and basic Monitor are delivered.
Bambu control scope and principal interaction decisions are recorded below;
protocol-dependent implementation details and physical qualification remain
pending. No Bambu control delivery is claimed by this document.

**Scope:** The printer-console and printer-control experience shared by the
Electron desktop application and the Web application.

## Purpose

The application provides two connected but independent ways to use a user's
printer:

1. View and manage the printer's Web console inside the application.
2. Send G-code to the printer and optionally start a print through its HTTP
   API.

The shared device model is owned by
[Printer Domain and Control Architecture](Printer%20Domain%20and%20Control%20Architecture.md).
That design covers discovery, capabilities, material systems, sensors, cameras
and remote files. The existing Moonraker subset implements that service;
Bambu account/discovery foundations are delivered, with control design recorded
below. Other agents and the gateway remain deferred. This document
continues to own the existing console and sending experience, including printer
selection and upload/start retry behavior. Its saved API-key representation
remains current; the proposed credential-reference approach requires a separate
migration decision before this persistence contract changes.

The domain specification also owns the accepted
[native Web entry and device-page eligibility rules](Printer%20Domain%20and%20Control%20Architecture.md#41-native-web-interface).
Device feature tabs follow those eligibility rules. Control connectivity is
independent of native-page access, and the existing Moonraker Console URL
fallback and host authentication behavior are provider-specific conventions.
The domain contract preserves request-driven Moonraker operation: loading saved
configuration does not probe the printer, selecting it opens the configured Web
page without an agent connection, and upload executes on demand. Additional
material-sync support is type-specific and explicitly user-triggered. All domain
APIs are stateless. Both hosts inject the Moonraker domain service; Device
resolves its Web entry locally and Send submits explicit upload/start requests
and observes operation references. The old driver/Send service is retired.
Uploads explicitly select the advertised overwrite policy, preserving existing
same-name behavior. Configuration persistence and host transports are unchanged.

The embedded console is a convenience and management surface. Sending and
printing use the printer API directly, so either surface can continue to be
used when the other one is unavailable.

## Device page

Device is a top-level page alongside Workspace. Workspace contains only the
profile/settings sidebar and the 3D scene. Switching between pages preserves
the state of both surfaces.

The Device page uses the same card-style visual language as Workspace:

- The left card starts with an explicit printer dropdown and add/discovery actions.
  Edit and route-specific Delete actions apply to the selected printer.
- Below the dropdown, vertical feature tabs show **Web Interface** and **Monitor**
  only when a route has locally established support. Web Interface is initially
  selected when available, otherwise Monitor. Unknown capabilities are explained
  without probing or inventing support.
- The right card shows the selected feature. Switching feature tabs retains the
  embedded console and monitor readings. Features use their own eligible route;
  capabilities from different routes are not combined.
- The sidebar can be resized, starts at 288 px, and stays between 220 px and
  560 px. Its width is remembered independently from the Workspace sidebar.

The title bar's left collapse icon hides the Device sidebar and resizer without
unmounting their content or changing the saved width. Its independent
`ui.deviceSidebarCollapsed` preference is restored at startup and defaults to
expanded; Workspace collapse preferences remain separate.

Deleting a printer route requires confirmation. Adding or editing a printer opens a
configuration dialog.

The delivered Monitor currently provides explicit Refresh for supported status, sensor and
heater-target readings, plus capability-gated Pause, Resume and Cancel print.
Selecting a printer or entering Monitor does not start reads, polling or control
commands. Missing readings remain unreported; failed reads retain previous
values with an error indication. Commands carry the selected route and its
configuration revision; unknown outcomes ask the user to check the printer and
are never automatically retried. Camera viewing and additional motion, material,
and actuator cards remain future work. Current Bambu enumeration alone does not
establish Monitor eligibility. The accepted Bambu observation behavior below
supersedes manual-only entry for that planned implementation; it does not change
Moonraker's request-driven behavior.

### Bambu control design

**Decision status:** The user selected shared control cards with a Bambu-specific
composition and advanced controls (UI option B). The first physical acceptance
target is **H2D + AMS**. Implementation is authorized in independently verified increments;
physical acceptance follows software verification. This UI choice is
separate from the earlier domain-architecture option B.

The selected scope excludes video, remote-file browsing and an HMS tab. Current
task/material errors and supported contextual recovery actions remain available
inside the relevant cards. The additional feature boundaries below are accepted.
Existing account, discovery and route management remain in place.
The Electron host supplies native Bambu execution; shared React components use
the printer service. This work does not introduce a Web gateway.

#### Shared cards and Bambu composition

Reuse common print-status, temperature, actuator, motion and operation-feedback
components. Compose them into a Bambu control surface, with specialized material
presentation and advanced settings where the device requires them. Shared UI
must not parse vendor messages, build protocol commands or access native IPC
directly. Protocol normalization and capability derivation belong to the provider,
as specified in the
[Bambu control architecture](Printer%20Domain%20and%20Control%20Architecture.md#23-bambu-monitoring-and-control-design).

The working layout retains the explicit printer selector and uses the available
content area without an empty video panel. A header identifies the printer,
route and observation freshness. Task controls appear before temperature,
actuator and motion cards; material units and tool paths form a dedicated area.
Hardware details and material-target selection can use dialogs. Exact card
order and dialog grouping remain reviewable. Selection persistence is defined
under Console selection and behavior below. Desktop
layout should accommodate narrow windows through internal scrolling and fewer
columns; mobile support remains deferred.

The accepted feature envelope is:

| Area | Accepted coverage |
| --- | --- |
| Current print | Name, phase, progress, remaining time, detailed stage and layer counts; pause, resume, cancel and speed selection. Display a current-task thumbnail when obtainable, otherwise a placeholder. Extended observations, previews and speed semantics need contract changes. Object skipping is excluded. |
| Thermal and actuators | Separately identified nozzle/tool temperatures, bed and supported chamber control, fans and lights; unknown limits must not become unrestricted inputs. |
| Motion and tools | Homing, jogging, extrusion/retraction and supported tool selection, with explicit targets and device/state-dependent availability. |
| Materials | Dynamically reported AMS units, external holders, slots, read-only metadata/remaining material and paths to tools; load, unload and switch. No metadata editing or manual RFID re-read. |
| Drying and environment | Read-only reported temperature/humidity, drying state and remaining time. No drying start, stop or settings. |
| Hardware details | Read-only information for each nozzle, including type/material, diameter and flow type when reported. Offer an explicit device-supported refresh/re-identification action; no device-configuration or slicer-preset edits. |
| Calibration and detection | No device-calibration launch UI or print-detection settings in this delivery. Show reported calibration state when calibration is started elsewhere. Existing detection settings remain unchanged. |
| Camera settings | No recording, timelapse or camera-resolution settings. Preserve existing device configuration; no video playback or recording-file browsing. |
| AMS settings | No settings entry for automatic filament backup, insertion/startup identification or remaining-capacity estimation. Preserve device configuration. |
| Feedback | Command progress, rejection, stale data and unknown outcomes. Show current relevant device errors and supported retry, recovery and abort actions in the task or material cards, without an HMS tab. |

H2D acceptance must exercise separately addressed tools/nozzles and AMS-to-tool
paths rather than assuming one nozzle and four fixed slots. Resolve the AMS
generation, unit count, physical routing and optional filament-transfer hardware
during physical acceptance, not as design prerequisites. Derive presentation and
availability dynamically from provider-normalized device reports. Other models
remain representable, but H2D acceptance is not qualification for every Bambu model.

Upload/Send & Print, firmware upgrades and importing device materials into the
project are not automatically added to this control scope. Filament-calibration
workflows are also outside this delivery.

#### Accepted task, hardware and recovery scope

Current-task thumbnails are independent of file-browser UI. Display an available
task image, or a placeholder when absent or unavailable. Loading failures must
not block observations or controls. Resolve the image through the provider's
typed current-task/media boundary; do not substitute the active Neo workspace's
model or require a Neo-originated upload. Switching task, printer or route must
not let an earlier asynchronous image result replace the current image.
Orca's reference is the current-task and SD-card thumbnail handling in
[StatusPanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp).
Object picking, object metadata acquisition and skip-object commands are not
part of this thumbnail scope.

Show the reported details of both H2D nozzles separately. Hardware information
is read-only; the explicit refresh/re-identification action is offered only
where the provider establishes support. It must not silently rewrite printer
configuration or slicer presets. The reference
[PrinterPartsDialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/PrintOptionsDialog.cpp)
disables editing and conditionally exposes nozzle refresh. Ordinary observation
refresh and device re-identification are separate operations.

Errors relevant to the current print, tool change or material operation belong
in that task/material card. Expose supported contextual retry, recovery or abort
actions rather than directing every failure to the printer. Follow the existing
opaque action-reference contract and validate context at execution; a user
invoking a device-provided recovery action is not automatic replay of an
uncertain command. Presentation follows the accepted command interaction below.
This does not introduce an HMS browser, an error-history page or unrelated
diagnostics.

Device calibration may be visible as reported activity, but no calibration
selection/start dialog is included. Detection settings, including device-side
AI/print-detection switches and sensitivity, are excluded even though they do
not require video playback. Camera recording, timelapse and resolution settings
are also excluded. None of these exclusions turns off an existing device
feature: the device keeps its current configuration.

#### Accepted materials and AMS behavior

Build units, holders, slots, tools and material paths from device-reported
identities, topology and capabilities; do not encode the acceptance fixture's
hardware layout in the UI. Use the sole usable feed target directly and show
its nozzle. When multiple targets are available, require explicit selection.
Unknown routing or an unready transfer mechanism must explain and block the
operation rather than guess a target. Keep actual and requested paths distinct.
Orca's load handler in
[StatusPanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp)
checks transfer readiness and opens a feed-direction dialog when applicable.

Do not add a per-load/unload temperature override. The provider owns the
Orca-derived command temperature policy and validates applicability and device
limits. Ordinary temperature-target cards remain available. The reference load
path derives current/target temperatures from material temperature-range
midpoints where available and otherwise retains protocol sentinel values;
the unload call uses the command declaration's defaults. These are distinct
reference pathways, not a universal temperature fallback. Validate missing-data,
sentinel and default behavior for the applicable device/protocol during
implementation and hardware acceptance; if applicability cannot be established,
explain why the operation is unavailable. Keep protocol-specific values private.
See the load/unload handlers above and the declaration in
[DeviceManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.hpp).

Material metadata is read-only. Exclude material-preset, color, temperature-range
and K/N/calibration-result editing; do not import or modify project presets.
No manual RFID re-read is offered; identification results update from device
reports. These exclusions do not remove load, unload, switch or supported inline
recovery actions. Nozzle hardware re-identification remains a separate accepted
feature and is not excluded by the RFID decision.

Drying is observation-only: show reported state, remaining time and available
temperature/humidity readings. Preserve their reported units and distinguish
humidity levels from percentages; absent data is unknown. Do not offer drying
start, stop, temperature/duration settings or other drying options. No AMS
behavior-settings entry is included for automatic filament backup, insertion or
startup identification, or remaining-capacity estimation. Preserve existing
device configuration and continue displaying reported material changes and
remaining capacity. Orca provides a broader set of controls in
[AMSDryControl](../packages/slicer-wasm/cpp/src/slic3r/GUI/AMSDryControl.cpp)
and [AMSSetting](../packages/slicer-wasm/cpp/src/slic3r/GUI/AMSSetting.cpp);
those controls are intentionally outside this delivery.

#### Accepted observation and access behavior

Selecting a Bambu printer and showing its control view automatically starts
state acquisition and live monitoring; no Connect or Start monitoring action is
required. Leaving Device for Home or Workspace pauses hidden-view updates but
retains the provider connection, background state reception and cache updates.
Outstanding operations continue to be tracked. Returning to the view displays
the latest available state with its actual freshness. UI visibility, provider
observation and operation lifetime are separate; hidden-page rendering must not
be required to maintain device state. Moonraker remains request-driven.

Maintain ordinary monitoring only for the currently selected printer. Selecting
another printer releases the previous printer's ordinary monitoring connection
or selection/subscription as applicable; it does not accumulate background
monitoring for every visited device. Retain the previous device's cached readings
with their actual freshness and its submitted-operation records. Returning to
that printer reacquires valid state before controls become available.

Allow immediate printer selection changes even while a command awaits a result.
The submitted command stays bound to its original printer, route and operation
identity. Continue necessary outcome tracking where the native connection and
protocol permit; if switching prevents confirmation, preserve an unknown outcome
rather than guessing completion. Do not block selection until operations finish,
cancel the physical task, or resend/reassign a command because selection changed.
Late results may update the original operation only, not the newly selected
printer's state. Necessary operation tracking is separate from ordinary monitoring
and does not promise simultaneous live telemetry from previously visited printers.
Orca's reference selection flow is in
[DevManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp).

For Bambu control, choose the Cloud route whenever it exists; use an authorized
LAN route only when no Cloud route exists. Do not provide a manual route switch.
A LAN discovery announcement alone is not an authorized route. Temporary Cloud
failure retains the Cloud choice, reports the connection problem and marks
retained readings stale; it does not trigger automatic LAN fallback. Removing
the Cloud route, for example on logout, is a catalogue change: a retained LAN
route then becomes eligible under the same selection rule. Commands already
dispatched keep their original route and outcome; changing the catalogue must
not replay them on LAN. Connection recovery on the selected route is distinct
from cross-route fallback.

Each main desktop window is a complete independent Electron application
instance, as defined by the
[application shell](Application%20Shell.md#host-and-page-lifetime). Single-instance
multi-main-window operation is not supported. Each instance owns its current
selection, provider runtime, connections, observation cache and operations.
There is no cross-instance live selection synchronization or shared-connection
takeover UI. Persisting a last-selected device is a startup preference, not a
mechanism for changing the selection of another running instance. Instances
share persisted configuration, including remembered login, saved devices and
last-selected-device preference; do not create a separate profile directory per
instance. This sharing does not merge live provider state or connections.

Do not actively synchronize login, logout or account switching across running
instances. Each instance maintains its own session; newly started instances read
the latest saved configuration. If the server or plugin invalidates an existing
session, that instance performs normal account/route cleanup and presents the
need to sign in again. Lack of proactive synchronization is not a guarantee that
another instance's session remains valid after logout. Shared-storage concurrency
must be qualified without exposing or rewriting private plugin auth files.

These are accepted design changes, not claims that current production code
already implements them. Printer-selection persistence applies to all providers
as specified below, independently of Bambu-specific monitoring policy.

#### Accepted command interaction

Pause and resume do not add a generic confirmation dialog. Cancelling the
current print requires confirmation identifying the target printer and task;
revalidate that context before dispatch so a selection/task change cannot
redirect the confirmation. Device-specific blocking conditions and contextual
prompts remain independent of this generic confirmation policy. Orca's reference
pause/resume and cancel handlers are in
[StatusPanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp).

Temperature edits submit valid input on Enter or loss of focus, following
[TempInput](../packages/slicer-wasm/cpp/src/slic3r/GUI/Widgets/TempInput.cpp).
Do not add an Apply button or a generic confirmation dialog. Enter followed by
focus loss must not duplicate the same submission. Bind the edit to its original
printer, route and heater; a selection change must not send it to a new target.
The provider still validates current capability, limits and availability.

Initially follow Orca's corresponding control states, local messages and
necessary dialogs for command feedback. Do not introduce a unified operation
history panel or require every failure/unknown outcome to remain as a persistent
inline badge. This choice concerns presentation: native send success is still
not physical completion, and ambiguous results must not cause automatic replay.
Orca's temporary protection of edited values from incoming telemetry is not
proof that the device applied a command. Provider operation tracking remains
independent of the visible page; the UI must not invent a successful result.

Disconnected, connecting, or stale-state control views must not accept new
control commands. Retain available old readings with an explicit stale marker;
restore controls only after valid state is received and the operation's other
conditions are satisfied. Apply this restriction even if the transport still
appears connected. Continue tracking commands already dispatched; do not queue
new user actions for automatic dispatch after recovery. The reference
[Monitor](../packages/slicer-wasm/cpp/src/slic3r/GUI/Monitor.cpp) resets display
on connection loss; Neo retains stale readings as already selected above.

Manual homing, jogging and extrusion/retraction do not add generic per-action
confirmation dialogs. Check device capabilities and current conditions before
sending; an unmet homing or extrusion-temperature prerequisite blocks the
requested operation and explains the requirement. A contextual homing prompt
may offer explicit homing, following Orca's XY behavior, but must not replay the
original movement afterwards. Do not automatically heat or replay blocked
extrusion. Use device-applicable constraints rather than treating Orca's fixed
extrusion threshold as universal. The reference Z handlers send movement before
checking homing; do not reproduce that ordering. All applicable checks precede
dispatch, including provider-side validation.

#### Accepted qualification sequence

Qualify real H2D + AMS control over Cloud first, then LAN. This is an acceptance
order, not a change to Cloud-preferred runtime routing and not permission to
claim LAN support from Cloud results. Determine the exact AMS hardware and
physical routing at hardware acceptance, using device-reported topology in the
design. Both paths require their own evidence for the operations claimed.

Independent-instance acceptance must cover shared configuration with separate
provider runtimes, simultaneous use, startup restoration, account changes in
one instance without proactive synchronization to others, and server/plugin
invalidation of another instance's session. Verify concurrent writes and normal
shutdown do not corrupt saved configuration or resurrect removed account/device
state from an obsolete snapshot. Existing tests within a single Electron process
do not establish these multi-process behaviors. This remains a design requirement,
not a claim of completed hardware or persistence qualification.

#### Remaining implementation and qualification details

The principal scope and product-interaction choices are settled. The following
details require implementation evidence or the physical acceptance environment;
they are not additional product options that must be guessed in advance. If new
evidence requires a product-level change, clarify it interactively, one question
at a time, explaining the checked-in Orca behavior. Consolidate related decisions
in their owning sections rather than maintaining an answer log. Implementation proceeds in independently tested and committed increments;
physical acceptance remains last.

| Group | Evidence and decisions still required |
| --- | --- |
| Command implementation details | Command-specific completion evidence, freshness thresholds, operation retention/deduplication windows and confirmation timeouts need protocol evidence and validation during implementation. Verify which pending outcomes remain observable after a device switch; preserve unknown outcomes when evidence is unavailable. User-facing feedback follows Orca as selected above; these details do not imply a new operation-history UI. |
| Qualification details | Confirm the physical fixture, representative device states and permitted physical operations at acceptance. Cloud precedes LAN; independent runtimes share persistence without proactive account synchronization. Broader-model and release claims require separate evidence. |

Reference behavior comes from the checked-in Orca revision identified in the
[provider specification](Printer%20Domain%20and%20Control%20Architecture.md#21-bambu-electron-provider-design),
not an assumption about the latest external Orca or Bambu Studio release.
[Monitor](../packages/slicer-wasm/cpp/src/slic3r/GUI/Monitor.cpp) and
[StatusPanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp) own the
reference UI; connection selection is in
[DeviceCore/DevManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevManager.cpp).
Orca behavior informs a choice but does not automatically replace Neo's existing
stateless service, explicit selection or shared-host boundaries.

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

**Accepted selection-persistence change; implementation pending:** Remember the
last printer explicitly selected from Device's saved list, for every provider,
not only Bambu. On the first entry into Device after application restart, restore
that physical device if it still exists in the successfully loaded catalogue.
Do not choose an arbitrary replacement when it is absent. Loading or failed
catalogue reads do not establish absence. Persist the device identity, not a
forced Bambu route; route choice follows the policy above. Restoring Bambu starts
monitoring when its control view is shown. Restoring a request-based printer
preserves that provider's existing access policy rather than enabling polling.
The current implementation still uses an ephemeral selection until this change
is implemented.

Adding a printer does not select it automatically. If the selected printer is
deleted, the selection becomes empty and the console shows an empty state rather
than silently selecting another printer. Send and Send & Print retain their
independent, non-persistent target selection.

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

The Electron webview shares the application's default session. COOP
`same-origin` and COEP `require-corp` are injected only for the exact
application renderer origin, including its Worker and WASM resources.
Development uses the configured Vite origin; built applications use the
bound loopback server origin. Printer-console responses retain their own
headers. This avoids applying application isolation policy to remote Fluidd
pages, including untrustworthy HTTP origins where Chromium ignores COOP.

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
local network stack. After all bytes are sent, the dialog shows a 100% progress
bar and “Waiting for printer confirmation… 100%” status with complete byte counts and
0.0 KiB/s. Transfer percentages never round an incomplete transfer up to 100%.
Upload success requires a successful response with a valid remote file path.
Send & Print then shows a separate indeterminate “Starting print…” status and
hides upload statistics. Cancellation remains available while waiting for
upload confirmation. Web uses browser-native XMLHttpRequest upload progress
events for byte counts; it does not split the file into separate upload requests.

If Send & Print uploads successfully but starting the print
fails definitively, the dialog explains that the file is already on the printer and offers
a start-only retry. Retrying does not upload the file again. An interrupted
start response is an unknown outcome: the dialog asks the user to check the
printer and offers no blind start retry. A successful HTTP acknowledgement is
not an independently observed physical print-start confirmation.

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
late callbacks. Component tests cover cumulative average speed, delayed progress events,
reset on retry, unknown totals, confirmation waiting and print-start staging.
Upload fixtures at the service, component and host E2E boundaries use Moonraker's
HTTP 201 top-level upload receipt. Coverage includes upload-only, same-name
overwrite and starting the exact root-relative path returned by the server;
malformed or interrupted receipts must not report success or trigger a print.

The Electron mock validation uses `VITE_USE_MOCK=1` with
`pnpm --filter @orca/desktop exec electron-vite build --mode e2e`, followed by
`pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs` and
`pnpm --filter @orca/desktop exec playwright test e2e/printer-control.e2e.ts e2e/app.e2e.ts --grep 'Send|Device config|full v1 flow'`.
The fixture holds the upload response until the UI shows complete byte counts,
zero speed and confirmation waiting at 100%, then verifies success and
start-only retry. Filename coverage includes project identity, native generated
names, arbitrary extensions, cancelled saves, upload retries and multipart
encoding. Handoff verification quick-builds both WASM variants, runs native
bridge/slicing and filename harnesses, and checks real Web download/Send/project
save seams using freshly staged artifacts. Electron checks include the primary
shared application flow, project lifecycle, native Save As and Send; its real
threaded runtime probe covers host-backed export and temporary-file cleanup.
Physical-printer and minutes-long real-network transfer verification remain
outside the available local fixtures.

## Electron debugging and Worker verification

VS Code renderer debugging can leave a Fluidd G-code parsing Worker waiting
for the debugger before its initialization runs. The console then remains at
"Parsing file" with zero progress. In the confirmed 2026-10-06 incident, the
9222 CDP endpoint listed the Fluidd `webview` and its `parseGcode` Worker,
whose `self.onmessage` was still null. Sending
`Runtime.runIfWaitingForDebugger` to that Worker completed the existing
preview: 666,901 bytes, 18,746 moves and 136 layers. The same file parsed in
approximately 1.14 seconds in a fresh Electron session, and Fluidd's own
`gcodePreview/loadGcode` action and manual preview also succeeded there.
Restoring the old global isolation-header injection in an isolated probe
still allowed parsing, so the header leak was a separate defect.

The [VS Code debugger target manager](https://github.com/microsoft/vscode-js-debug/blob/main/src/targets/browser/browserTargetManager.ts)
recursively enables auto-attachment with `waitForDebuggerOnStart`; its
[supported JavaScript target types](https://github.com/microsoft/vscode-js-debug/blob/main/src/targets/browser/browserTargets.ts)
do not include Electron's `webview`. This supports a debugger integration
failure as the explanation for the observed startup wait. For Device/Fluidd
testing, use `Desktop Debug Main Process` instead of `Desktop Debug All`,
which also starts `Desktop Debug Renderer Process`. Inspect the application
renderer through Electron DevTools. These configuration names and the 9222
port are defined in [the workspace launch configuration](../.vscode/launch.json).

Maintain coverage that executes a guest Worker, verifies its responses lack
injected COOP/COEP, and confirms the app remains cross-origin isolated. Unit
coverage includes renderer resources, development origins, external console
and Worker resources, different ports/protocols, invalid origins and
case-insensitive header replacement. Retain API-key reuse, guest reload and
printer-control tests. These fixtures do not establish physical-printer or
all-platform release qualification.
