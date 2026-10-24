# Printer Console and Control Integration

**Updated:** 2026-10-23

**Status:** Console/Send, Moonraker Monitor and the Electron Bambu control
implementation are delivered. Bambu protocol fixtures and desktop interaction
regression cover software behavior; physical H2D + AMS acceptance remains last,
Account-backed automatic networking followed by LAN-only access. No complete
hardware or six-target control qualification is claimed.

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
Bambu account/discovery and control execution are implemented as described
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
same-name behavior. The saved document shape and host transport boundary are preserved; Electron
configuration writes now protect independent-instance updates as described below.

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

Moonraker Monitor provides explicit Refresh for supported status, sensors and
heater targets, plus capability-gated Pause, Resume and Cancel. Selecting it does
not start polling. All printers use one capability-driven Monitor and printing
progress card: preview area and print actions on the left, existing readings
and controls on the right. Moonraker retains a preview placeholder without
fetching thumbnails; unsupported sections are omitted. Sharing the layout does
not add Moonraker speed, temperature, motion, material or camera controls.
Bambu capabilities enable live observation for the selected device
and task, temperature, actuator, motion, tool and material cards. The
provider validates commands against fresh observations and their original target.
Missing readings stay unreported; disconnected data is marked stale. Unknown
outcomes never cause an automatic retry. Video remains outside this delivery.

### Bambu control design

**Decision status:** The shared application uses one capability- and topology-driven
Monitor (the approved refactoring option B), including advanced controls where
supported. This supersedes the original Bambu-specific composition. The first physical acceptance
target is **H2D + AMS**. Implementation is authorized in independently verified increments;
physical acceptance follows software verification. This UI choice is
separate from the earlier domain-architecture option B.

The selected scope excludes video, remote-file browsing and an HMS tab. Current
task/material errors and supported contextual recovery actions remain available
inside the relevant cards. The additional feature boundaries below are accepted.
Existing account, discovery and route management remain in place. The shared
control composition, live subscription and Device selection restoration are
implemented and covered by desktop integration regression. Physical H2D + AMS
qualification remains a separate acceptance gate.
The Electron host supplies native Bambu execution; shared React components use
the printer service. This work does not introduce a Web gateway.

#### Capability-driven Monitor composition

[PrinterMonitor](../packages/slicer-app/src/components/device/PrinterMonitor.tsx)
is the only Monitor composition. Device selection does not branch on provider ID.
Shared print-status, temperature, actuator, motion, material and operation-feedback
cards are selected by advertised capabilities and populated from reported topology.
Hardware IDs are opaque; tool/nozzle labels use descriptor names. For a reported
Bambu dual 0/1 pair, the provider follows Orca's main-extruder convention: 0 is
Right nozzle/Right extruder and 1 is Left nozzle/Left extruder. The provider
orders this pair left first, right second, independently of report order; the
vertical temperature and tool lists show left above right, and hardware details
list left before right. Temperature,
tool-selection and material-path controls share those names while retaining
the original command IDs. Single-tool and unknown layouts keep neutral names.
Movement choices
use advertised step IDs without silently substituting another step for an axis.
Extrusion presets use reported range and granularity; unknown bounds or increments
do not establish a preset. The provider still evaluates every command.

[Observation ownership](../packages/slicer-app/src/components/device/usePrinterObservation.ts)
splits consumed topics by delivery: `push` or `poll` topics use the service's watch,
while on-demand-only topics use explicit Refresh. The application adds no polling
loop. Mixed deliveries merge per topic and retain independent stream/read errors;
a successful manual read cannot clear a failed stream. Hidden views retain the
selected printer's subscription/cache and apply changes on return. A target or
configuration change ends that keyed lifetime. A standalone descriptor/firmware
capability does not start device access.

[Control and preview ownership](../packages/slicer-app/src/components/device/usePrinterControl.ts)
centralizes evaluation, guarded submission, operation feedback and task-scoped
preview cleanup. Ending observation never cancels a physical command, and an
unknown outcome never retries it. Preview reads require the capability and an
identified task; stale task results are discarded and object URLs released.
Moonraker keeps its existing manual observation and basic print-control envelope.
Shared UI must not parse vendor messages, build protocol commands or access native IPC
directly. Protocol normalization and capability derivation belong to the provider,
as specified in the
[Bambu control architecture](Printer%20Domain%20and%20Control%20Architecture.md#23-bambu-monitoring-and-control-design).

The Monitor follows the reference's two-column desktop composition without a
video panel: task preview above printing progress on the left; temperature,
lighting/fans, a directional XY pad with homing and Z controls, and individually
addressed extruders on the right. A visible Print speed label accompanies the
mode selector. Material units form a grid beneath the controls, with compact
reported slots and explicit tool paths; external holders remain distinct.
Fan controls and nozzle hardware details can expand within their sections.
No calibration, print-options, RFID or material-editing entry is implied by the
reference image. The explicit printer selector, current-device header and
freshness feedback remain visible. Narrow content areas stack the sections
without horizontal overflow; mobile support remains deferred. Selection
persistence is defined under Console selection and behavior below.

The accepted feature envelope is:

| Area | Accepted coverage |
| --- | --- |
| Current print | Name, phase, progress, remaining time, detailed stage and layer counts; pause, resume, cancel and speed selection. Display a current-task thumbnail when obtainable, otherwise a placeholder. The typed contract includes task previews, detailed observations and speed modes. Object skipping is excluded. |
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
part of this thumbnail scope. The provider reads the current task through the
native subtask-info export and selects its reported plate, or uses a reported
thumbnail URL. Only bounded PNG/JPEG bytes leave the utility; signed URLs remain
private. Missing task identity, unsupported URLs, absent images and failed
retrieval retain the placeholder. Completion rechecks task/configuration identity.
No LAN filesystem or FTP browsing is introduced by this path.

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
For Bambu external holders, reported virtual unit 255 feeds Tool 0 and unit 254
feeds Tool 1, each through slot 0, following Orca
[DevFilaSystem](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevFilaSystem.cpp).
Only reported holders and tools produce usable paths; array order, remembered
material metadata and unknown IDs do not imply routing or filament presence.
Legacy `vt_tray` describes only the main holder. Keep these logical identities
separate from Orca
[command encoding](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp),
which aliases unit 254 to 255 for load/unload. External-load temperatures use
the selected holder's material range for both current and target values, as in
Orca's handler; completion still requires the originally selected logical path
and tool to be reported, not merely an acknowledgement of the aliased command.
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

Bambu control addresses one physical printer through one stable agent endpoint.
The caller and UI do not select, prioritize or interpret LAN versus Cloud
transport. The native agent automatically manages account-backed mixed networking;
both message callbacks feed the same printer state and operation tracking, as in
Orca's `MachineObject::parse_json` and the callback wiring in `GUI_App`.
Do not provide a manual route switch or describe an account-backed device as
necessarily using Cloud transport. A failed channel does not invalidate fresh
data from the other channel. Missing all fresh data disables controls.
Independent saved LAN authorization still determines LAN-only access after
logout; discovery alone does not authorize it. Access/configuration changes
invalidate old guards while preserving the logical printer identity. Already
dispatched commands retain their target and outcome and are never replayed
because a transport or account state changed.

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

Qualify real H2D + AMS control with account-backed automatic networking first,
then independently authorized LAN-only access. Mixed LAN/Cloud reports are a
normal account-backed case, not an acceptance blocker. Dedicated Cloud-only or
network-loss claims still require their own network evidence; ordinary acceptance
does not require the caller to isolate or select a transport. Determine exact
AMS hardware and physical routing at acceptance from device reports.

Independent-instance acceptance must cover shared configuration with separate
provider runtimes, simultaneous use, startup restoration, account changes in
one instance without proactive synchronization to others, and server/plugin
invalidation of another instance's session. Verify concurrent writes and normal
shutdown do not corrupt saved configuration or resurrect removed account/device
state from an obsolete snapshot. Existing tests within a single Electron process
do not establish these multi-process behaviors.

Implemented storage uses short cross-process file locks and atomic publication.
Preference field updates use compare-and-swap and reapply on conflict. Saved
Moonraker devices merge per-record changes and reject conflicting edits/deletions;
Bambu provider updates read the latest document inside the lock. Existing Bambu
instances retain their own read snapshot. Plugin-owned authentication files are
not edited or locked by Neo. Unit tests cover actual competing Node processes,
conflicting preference snapshots and stale device edits. The Electron smoke
launches two independent applications with distinct real-plugin utilities,
checks one can close without stopping the other, and restores the shared client
identity in a third instance. Logged-in simultaneous operation and server-side
session invalidation still require account/hardware acceptance.

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
| Command implementation details | Implemented: 15-second telemetry freshness, 10-second explicit-read timeout, 30-second completion timeout, and instance-lifetime operation/request retention. ACK is separate from completion. New accepted telemetry can confirm target/task/path state; motion, refresh and recovery without reliable terminal evidence remain unknown on timeout. Hardware acceptance must establish actual firmware outcomes and tune these bounds if evidence requires it. |
| Qualification details | Confirm the physical fixture, representative device states and permitted physical operations at acceptance. Account-backed automatic networking precedes LAN-only access; independent runtimes share persistence without proactive account synchronization. Broader-model and release claims require separate evidence. |

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

**Implemented Device selection:** Remember the
last printer explicitly selected from Device's saved list, for every provider,
not only Bambu. On the first entry into Device after application restart, restore
that physical device if it still exists in the successfully loaded catalogue.
Do not choose an arbitrary replacement when it is absent. Loading or failed
catalogue reads do not establish absence. Persist the device identity, not a
forced Bambu route; route choice follows the policy above. Restoring Bambu starts
monitoring when its control view is shown. Restoring a request-based printer
preserves that provider's existing access policy rather than enabling polling.

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

## Bambu software verification

The 2026-10-23 local software gate ran on macOS ARM64. `pnpm test` passed
2,508 tests with four existing conditional skips, and `pnpm typecheck` passed.
The desktop and shared-app suites were rerun after the final fan-range/UI
adjustments (236 and 1,405 passed). The platform import guard
(`pnpm --filter @orca/platform-contract test:import-guard`), native ABI declaration
check (`node packages/bambu-native/scripts/verify-declarations.mjs`) and pinned
plugin load (`pnpm --filter @orca/bambu-native smoke`) passed. The actual plugin
is Open Bamboo Networking v2.2.0, ABI `02.08.01.99`.

Desktop verification builds with
`pnpm --filter @orca/desktop exec electron-vite build --mode e2e`, checks CSS with
`pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs`, then runs
`pnpm --filter @orca/desktop exec playwright test e2e/bambu-control.e2e.ts e2e/bambu-provider.e2e.ts e2e/bambu-account.e2e.ts e2e/printer-control.e2e.ts e2e/app.e2e.ts`.
The initial run had 41 passes, three real-WASM-only skips, and one sidebar-layout
coordinate failure after viewport resizing. The unchanged isolated command
`pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts --grep 'sidebar panels resize independently'`
passed; the failure was not reproduced and is not claimed as a fixed root cause.
After the final fan/UI adjustments, the rebuilt application passed all seven
focused cases in the four Bambu/Moonraker files above (excluding `app.e2e.ts`).
The Bambu control journey uses a typed main-IPC fixture to exercise renderer,
preload, target selection, temperature submission, cancellation context and stale
controls. Separate provider unit/native tests cover protocol validation and
outcomes. The independent-instance smoke uses actual native utilities with empty
account state. None of these substitutes for a logged-in physical printer test.

The automatic-agent transport correction passed `pnpm test` (2,510 tests,
four existing conditional skips), `pnpm typecheck`, the platform import guard,
and all seven focused desktop cases in the four Bambu/Moonraker files above.
After aligning the remaining fixtures with the single endpoint, the desktop
and shared-app suites passed again (238 and 1,405 tests), as did the full
typecheck and the Bambu control E2E case. Tests cover merging same-device LAN
and Cloud reports, retaining fresh state when one channel fails, correlating
command acknowledgements across channels without resending, and retaining the
logical target when account removal leaves independently authorized LAN access.

On 2026-10-23, a normal production build started with
`env -u ORCA_E2E -u ELECTRON_RENDERER_URL pnpm --filter @orca/desktop exec electron .`
restored the existing account and selected H2D. Its single Bambu Lab endpoint
remained Live for several minutes on the ordinary mixed LAN/Cloud network,
beyond the former approximately 15-second stale boundary. Read-only UI evidence
showed idle, nozzle temperatures 26/27 C, bed/chamber temperatures 25 C, two
0.4 mm hardened-steel standard-flow nozzles, four-slot AMS 0 bound to Tool 1 and
four-slot AMS 2 Pro 1 bound to Tool 0. Only the AMS 2 Pro exposed a dryer;
remaining material was unknown rather than a fabricated zero. The user confirmed
the two-unit arrangement; the model/nozzle detail above comes from device reports.
This verifies account-backed monitoring on the mixed network, not isolated Cloud
transport or a physically forced failover.

External-holder normalization and command preparation now follow the Orca
mapping above. Automated coverage checks both holders, legacy reports, unknown
and removed paths, per-holder temperatures and completion against the original
logical path despite the command alias. The H2D read-only hardware recheck
confirmed separate external-holder cards: 255 to Tool 0 and 254 to Tool 1,
with no unavailable-path warning. Neither holder was reported loaded, and
unknown spool presence/remaining values stayed unknown. Returning from Home
retained the selected device and Live state, with subsequent nozzle and AMS
temperature changes confirming continued reports. Together with the
nozzle, AMS and live-status checks above, this completes the current
account-backed mixed-network read-only acceptance scope. Actual load/unload
behavior, including the command alias on physical firmware, remains unqualified.
No heating, motion, loading, unloading or other physical control command was
sent during this read-only check; each such operation requires individual user
confirmation. Real control operations, isolated Cloud/LAN transport qualification,
account invalidation between live instances, and the six-target release matrix
remain unrun. No C++ slicing/WASM bridge changed, so no new dual-WASM build or
real Web release run was required.

### Independent LAN read-only acceptance

On 2026-10-24, the production desktop build (`pnpm --filter @orca/desktop build`)
was exercised with the real native networking plugin in a separate normal
Electron user-data directory. No E2E overrides, mocked printer handlers or Cloud
account state were supplied. The original application profile and Cloud login
were preserved. SSDP discovered the H2D (`O1D`), and the user entered its access
code through the normal Discover LAN printers dialog. The saved catalogue then
contained one device with only a LAN authorization record; account state remained
`signed-out`. The system socket table confirmed an established connection from
the Bambu utility to that printer's LAN address on TCP 8883.

The unified Monitor became Live and continued receiving newer fresh status
readings beyond the 15-second freshness boundary, including while hidden by Home.
Read-only reports showed idle/ready, nozzle temperatures approximately 26/27 C,
bed 25 C and chamber 26 C; two 0.4 mm hardened-steel standard-flow HS01 nozzles;
four-slot AMS 0 routed to Tool 1; four-slot AMS 2 Pro 1 routed to Tool 0 and
reporting its dryer; and external holders 255/254 routed to Tool 0/1. Unknown
external-spool material stayed unknown. These are reported observations, not a
fixed hardware configuration requirement.

A normal close and restart using the same independent profile restored the saved
LAN record and selected printer without entering the access code again. Returning
to Device restored Live with a newer received timestamp and an established TCP
8883 connection; the account was still signed out. The host credential file had
mode 0600. Screenshots and timestamped snapshots are local ignored evidence under
`.vitest/lan-acceptance/`; credentials are not included in that evidence.

This completes independent LAN discovery, authorization, sustained monitoring,
dynamic-hardware presentation and same-profile restart acceptance. The saved LAN
authorization belongs to this separate acceptance profile. Heating, motion,
extrusion, material operations, wrong-code handling, forced network loss/recovery
and cross-instance invalidation were not exercised. Each physical control action
still requires individual user confirmation.

### Independent LAN lighting-control acceptance

On 2026-10-24, the same signed-out, independently LAN-authorized H2D profile
was used to test `lights.set` through the production Monitor. Reported
capabilities allowed `chamber_light` and `chamber_light2`; both were initially
on. `work_light` remained unknown and its control was disabled, so it was not
sent a command.

Each supported light was switched off and back on independently. Every command
reached the UI's completed outcome and fresh device telemetry reported the
requested state while the other light retained its state. At the user's request,
the sequence was repeated with at least ten seconds in each off state to allow
physical observation. The user confirmed that both physical lights turned off
and back on normally. Both supported lights were restored to their initial on
state. Timestamped local evidence is in `.vitest/lan-acceptance/lights.json` and
`lights-repeat.json`; no credential data is recorded.

This qualifies independent LAN on/off control and observed completion for these
two reported lights on this H2D. It does not qualify the unsupported work light,
other models, Cloud-only command execution or other control families. No heating,
motion, extrusion or material operation was performed in this stage.

### Independent LAN fan-control acceptance

On 2026-10-24, the user authorized a Fan 1 test at 30 percent for approximately
ten seconds, followed by restoration to zero. The production Monitor sent both
`fans.setSpeed` commands on the independently authorized LAN profile. Each
operation completed, with fresh telemetry reporting Fan 1 at 0.3 and then 0;
Fans 2, 3 and 6 remained at zero. The user confirmed the physical fan started
and subsequently stopped normally. A final read confirmed all four reported
fans at zero. Timestamped local evidence is in
`.vitest/lan-acceptance/fan1.json`.

The user then authorized sequential tests of Fans 2, 3 and 6, each at 30 percent
for at least ten seconds followed by restoration to zero. All six operations
completed with matching fresh device readings, and other fan setpoints remained
at zero. The user confirmed physical start/stop for Fans 2 and 3, but could not
identify Fan 6 physically. Final telemetry showed all four fans at zero. Local
evidence is in `.vitest/lan-acceptance/fans-2-3-6.json`.

Orca defines index 6 as `FAN_INNNER_LOOP_FAN_0_IDX` in
[DevFan.h](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevFan.h)
and labels it `Heat` in
[FanControl.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/Widgets/FanControl.cpp).
The [H2D user manual, section 6.5.1](https://csm.bblcdn.com/hub/4668d0ca43994ff3bff4b37f1a65c2e7.pdf)
explains that the chamber heat circulation fan remains off in cooling mode and
automatically starts in heating mode. Fan 6 therefore has command/report evidence
only; physical behavior and mode-dependent applicability remain unqualified.
The provider now derives descriptive fan names from Orca's AIR_FUN mapping,
including Part cooling, Auxiliary cooling, Chamber exhaust and Chamber heat
circulation. Pinned model/mode/submode label overrides take precedence as in
Orca; unknown IDs are explicitly labelled as unknown fans. Only reported fan
parts create controls and their opaque command IDs remain unchanged. The shared
Monitor renders these domain names without interpreting vendor IDs. This naming
change does not add chamber-mode controls or qualify mode-dependent execution.
After rebuilding and restarting the real LAN profile, a read-only UI recheck
confirmed these four functional names with all fan setpoints still at zero.

This qualifies the set/restore sequences for Fans 1, 2 and 3 on the H2D.
Other speed ranges, active-print interaction and Cloud-only operation remain
unqualified. No chamber-mode change, heating, motion, extrusion or material
command was issued in these fan stages.

### Independent LAN bed-heating acceptance

On 2026-10-24, the user explicitly authorized setting the bed to 40 C, waiting
for the actual reported temperature to reach 40 C, holding that target for ten
seconds, and restoring the target to zero. The production Monitor performed this
sequence on the same independently LAN-authorized H2D. Initial target was zero,
with actual bed temperature approximately 25 C. Fresh telemetry confirmed the
40 C target and subsequent actual warm-up; command completion alone was not
used as evidence of reaching temperature.

After a fresh actual reading reached 40 C, the 40 C target was maintained for
ten seconds before the zero-target command. Both operations completed, and
fresh telemetry confirmed target zero with residual actual temperature about
41 C. The nozzle and chamber targets stayed at zero. A later read showed the
bed cooling to 39 C. The user confirmed that the printer screen matched the
warm-up and target changes and accepted this test. Timestamped local evidence
is in `.vitest/lan-acceptance/bed-40.json`.

This qualifies the authorized bed set/warm-up/restore sequence on this H2D over
LAN. Other temperatures and print-time behavior remain unqualified. No nozzle
or chamber heating, motion, extrusion or material command was issued in this
stage; each further heating or physical-control test needs its own user approval.

### Nozzle-side identification during LAN acceptance

During the subsequent user-authorized nozzle-0 50 C test, both target commands
completed and telemetry showed actual temperature above 50 C followed by the
zero-target restoration. The final actual reading was about 56 C. The user
identified nozzle 0 as the physical right nozzle, exposing the ambiguity of the
numeric UI label. The provider display-name correction above addresses that
ambiguity; it does not change heater, extruder or material-path IDs or claim
additional physical-control qualification. All heater targets were confirmed
zero before the naming change. A production rebuild/restart read-only check
confirmed Right nozzle/Right extruder for 0, Left nozzle/Left extruder for 1,
and zero targets for both nozzles, the bed and the chamber.

The user subsequently accepted the right-nozzle test and separately authorized
the left nozzle (ID 1) at 50 C, with a ten-second target hold after actual
temperature reached 50 C and restoration to zero. Both left-nozzle commands
completed with matching fresh telemetry; actual temperature was about 57 C at
restoration. The other nozzle, bed and chamber targets stayed at zero. The user
confirmed left/right identity, actual warm-up and target restoration against
the printer screen and accepted both nozzle tests. A final read confirmed all
four heater targets at zero. Local evidence is in
`.vitest/lan-acceptance/nozzle0-50.json` and `nozzle1-50.json`.

This qualifies these explicitly authorized dual-nozzle set/warm-up/restore
sequences on this H2D over LAN. The tests held the requested target after actual
temperature crossed it; reported overshoot to approximately 56/57 C is recorded
rather than claiming stable 50 C regulation. Other temperatures and print-time
behavior remain unqualified. No chamber heating, motion, extrusion or material
operation was included in this nozzle stage.

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
