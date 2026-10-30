# Printer Console and Control Integration

**Updated:** 2026-10-30

**Status:** Console/Send, Moonraker Monitor and the Electron Bambu control
implementation are delivered. Bambu protocol fixtures and desktop interaction
regression cover software behavior; physical H2D + AMS acceptance remains last,
Account-backed automatic networking followed by LAN-only access. No complete
hardware or six-target control qualification is claimed.
Local-artifact print preparation/submission is implemented and initially enabled
only by the Bambu agent. Development-host LAN qualification includes two completed
H2D fixed-right-nozzle prints using AMS B1 and a completed fixed-dual-nozzle PETG
print using left A2 and right B1. Orca-style send completion is physically verified:
the modal closed automatically and Device selected the correct printer and task.
The dual-nozzle run needed external recovery from a dirty nozzle-camera error;
Error-specific dialogs/actions now have software coverage; physical recovery,
other supply paths and Cloud printing remain unqualified.

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

## Prepare printer and filament synchronization

**Decision status:** Option B is selected with separate interactions: Printer
sync executes directly with Orca-style necessary confirmations/configuration
choices and no generic change-preview dialog; Filament sync uses a modal
mapping/rebuild dialog. Each accepted project operation applies atomically in
native code. The shared workflow, normalized Bambu observations and native
transactions are implemented; physical qualification remains pending.

### Scope

Printer sync imports observed printer hardware into the project's slicing
configuration. Filament sync imports physical material metadata into the native
project rack. Both use shared, vendor-neutral application/domain contracts;
the initial device integration is Bambu through its Electron provider. Web uses
the same feature layer when its injected provider has the required capabilities;
this design does not add a browser Bambu transport or gateway. Mobile support
remains deferred.

### Agent extensibility

Generalize the synchronization workflow so future agents can reuse the same
Printer action, Filament dialog, native application and history/persistence
paths. Bambu is the first provider implementation, not the shared feature's
data model or dispatch condition.

Shared UI and orchestration consume normalized identity, topology, material
inventory, namespaced catalogue references, capabilities and source revisions.
Keep resource IDs opaque. Model tool/slot/path cardinality from those contracts,
without fixed assumptions about two tools, four-slot AMS units, contiguous
numbering or left/right device IDs. Native slicing limits still apply. Future
multi-tool fixtures do not expand the initial Bambu runtime coverage.

Agents own protocol decoding, device-model aliases, physical numbering/order,
catalogue normalization and vendor-specific hardware policy. Native preset
matching, effective drafts and project/reference transformations remain in the
existing shared native owners. Common UI must not import Bambu resources,
parse its protocol fields, or branch on Bambu/model IDs to decide the common
sync flow. Vendor-specific validation results enter through the agent/domain
boundary and native compatibility projection.

Gate Printer and Filament sync independently by the observations and operations
each actually needs. Accept push-backed or explicitly requested on-demand
observations through the same service boundary; do not require a future agent
to reproduce Bambu's connection, subscription, firmware or unrelated Monitor
capabilities. No discovery-time/startup synchronization or polling is added for
an on-demand agent. Native default/fallback rules remain compatible with the
selected profile; Bambu-specific rules stay scoped to that provider.

Keep abstractions limited to these concrete shared boundaries. Adding another
agent should supply its normalization/capabilities and provider-specific rules,
then reuse the existing workflow rather than copy a Bambu sync implementation
or introduce parallel project mutation paths. This design adds no new agent,
gateway or universal plugin framework in the initial delivery.

### Entry points and device selection

Reuse the Printer section's Sync control in the Nozzle row. Do not add another Printer-header button. Put Filament Sync
immediately to the left of Flushing Volumes in the material toolbar; retain the
existing independent eligibility of Flushing Volumes. Detailed layout ownership
remains in [Application Shell](Application%20Shell.md).

At each manual sync invocation, automatically use the currently connected
printer. If no printer is connected, open a device chooser. Choosing a device
connects it and makes it Device's current printer before starting the selected
sync workflow. Failure to connect/read does not apply project changes.
Canceling a necessary Printer confirmation or the Filament dialog leaves the
selected device connected and current in Device; it cancels only the pending
project mutation. Selection in Device alone must not be treated as permission
to rewrite Prepare configuration.
Changing the selected/connected printer in Device never automatically changes
Prepare's Printer preset or materials. A subsequent manual sync invocation uses
the latest connected printer rather than retaining the previous sync source.
Capture the chosen source for each in-flight workflow. The Filament mapping
dialog and any necessary Printer confirmation/configuration dialog are modal:
the main application, including Device selection, cannot be operated behind
them. Printer sync does not open a modal for an ordinary successful update.
Do not silently retarget an in-flight operation if its source changes.

If the source disconnects while the Filament dialog is open, retain the dialog
and mapping choices, but disable application. After the original source
reconnects, reread the required observations and revalidate before allowing
confirmation. Do not automatically apply on recovery or silently discard
reviewed choices; changes invalidating those choices require renewed review.
An exceptional source switch also pauses that dialog rather than using the
replacement device. Using a different source requires canceling and invoking
sync again. For direct Printer sync, a failed read, disconnected source or
changed source/configuration before commit rejects the operation without
partial project changes; a new manual invocation can retry with current data.

After a successful Printer sync, ask whether to continue with Filament sync.
Only an affirmative choice opens that second workflow; declining or canceling
it retains the already completed Printer changes. The two workflows are
separate native operations with separate Undo entries. The offered
continuation uses the Printer workflow's source; a later independent sync click
resolves the latest connected device as above.

An independent Filament sync first checks the source device against the
project's Printer using model compatibility, not display-name equality. If they
are incompatible, stop material import and offer a "Sync Printer first" entry.
Only the user's "Sync Printer first" choice enters direct Printer sync; apply
its necessary confirmations and, after success, offer the normal Filament
continuation. Do not import against the incompatible Printer or switch
it silently. Compatible-but-different models follow the native compatibility
rules rather than an unconditional exact-model requirement.

### Project workflow and ownership

Read the required device observations outside the project mutation transaction.
For Printer sync, validate and apply the requested hardware changes directly
after the explicit Sync action. Follow Orca's necessary model-mismatch
confirmation and applicable hardware/configuration choices, plus the ordinary
Printer switch's existing required confirmations. Do not add a generic
before/after summary, a universal confirm step, or a new Printer preview UI/API.
Native staging and revision validation remain internal transaction concerns.
After success, offer the optional Filament continuation.

For Filament sync, prepare a native-validated material proposal, show its source
device and configuration changes in the modal mapping/rebuild dialog, allow
mapping and replacement choices, and apply only on confirmation. Canceling
that dialog does not apply its pending project changes.

Printer sync covers model/preset resolution, nozzle diameter, project flow types
and available material-slot capacity. Resolve physical tools to slicing
extruders explicitly; never equate vendor numbering or array positions with
project nozzle indices. Preserve applicable user-preset edits where possible;
capacity import must distinguish physical slots from multiple paths reaching
the same slot. After successful Printer sync, update both the current project
capacity vector and the final selected Printer preset's remembered capacities,
using the existing preset-keyed preference policy. Undo restores project state
without reverting this preference write; reopening a project still uses its
saved values rather than treating remembered capacities as live overrides.

If the required model exists in profile resources but is not enabled, stop this
sync and direct the user to Setup to enable it, then retry Sync. Do not implicitly
enable the model, force a hidden preset visible, or bypass normal profile
activation. Setup retains its existing whole-model/all-variants activation rule.

For an already matching model and effective ordered nozzle-diameter vector,
retain the current Printer source, including a user preset, and its unrelated
customized settings. Update the applicable hardware-derived fields directly
without a general preview step.
Existing [project-owned Printer draft lifetime](Preset%20Editor%20Dialog.md#26-printer-drafts-are-project-owned)
continues to apply: switching sources deactivates rather than deletes the old
draft, and later selecting that source reactivates it. Sync does not implicitly
save a preset or migrate unrelated overrides into a different source.

Mixed nozzle diameters are in scope. The
[upstream mixed-diameter sync behavior](https://github.com/OrcaSlicer/OrcaSlicer/blob/db35f3d0980a622bc158d1f13855abc913cad8ca/src/slic3r/GUI/Plater.cpp#L1878)
is the Orca reference: preserve each physical nozzle's reported diameter rather
than forcing a single-head choice. Neo must integrate this with its delivered
[native toolhead selection and editing](Application%20Shell.md#native-toolhead-selection-and-editing),
not introduce a parallel mixed-diameter path. Resolve the complete final ordered
diameter vector against visible same-vendor/model presets and their effective
drafts, with matching count/order, current-source preference and stable canonical
tie-breaking. If a different exact matching source is selected, use the shared
Printer-switch path described below; otherwise update the current Printer
draft. When changing to a different device model without an exact full-vector
source, prefer its canonical base matching the first normalized tool's reported
diameter, following Orca's model-resolution rule, then apply the complete vector.
This avoids choosing an unrelated small-nozzle base and its flow restrictions.
It does not synthesize a mixed `printer_variant` or override an already applicable
current source. Mixed diameters do not require a pre-authored mixed variant.
Do not implement a multi-nozzle sync as sequential per-head commands that could
select intermediate profiles or publish intermediate project states.

Whenever sync changes the selected Printer source, invoke the same ordinary
Printer-selection implementation, including restoration of the target preset's
remembered filament rack, native compatibility normalization, topology and
filament-reference repair, and existing preference publication. This applies to
both model changes and diameter resolution that selects a different source.
Do not copy that logic, add a sync-only filament remapper, or use a separate
current-rack-preservation policy for sync. Future improvements to ordinary
Printer-switch filament remapping must benefit sync through the shared path.
Preserve the existing behavior of manual per-head editing outside sync.

Apply the ordinary switch and the final observed hardware/flow/capacity values
in one native project operation, without exposing the intermediate remembered
configuration or a second history entry. Reuse the ordinary switch's existing
reference-impact confirmations where required; do not wrap it in a generic
Printer change-preview dialog. Observed sync capacities are the final project
values and update the final target's capacity memory after success. The optional
subsequent Filament sync remains separately confirmed; declining it retains the
completed Printer switch, including its restored rack.

Retain the effective profile's `printer_variant` and canonical identity rules;
actual per-head diameters remain visible on nozzle cards and Multi. controls.
Do not synthesize a mixed variant from the diameter vector or rewrite the
Nozzle selector to a value without a canonical target. Preserve native flow
candidate repair, compatibility, project/Plate mapping, invalidation, history
and ordinary 3MF composition. These rules are owned by
[Profile Compatibility and Preset Selection](Profile%20Compatibility%20and%20Preset%20Selection.md#available-profiles)
and the existing toolhead workflow; upstream UI code is a reference rather
than a replacement for Neo's delivered contracts.

If the device has identified a nozzle but has not configured its flow type,
stop Printer sync and explain that its device nozzle settings must be completed
before retrying. Do not apply a partial Printer operation, substitute the
project's old flow, or offer a project-only manual flow override for this case.
This follows the
[upstream initialization gate](https://github.com/OrcaSlicer/OrcaSlicer/blob/db35f3d0980a622bc158d1f13855abc913cad8ca/src/slic3r/GUI/Plater.cpp#L20021).
For a device explicitly known not to support flow reporting, follow Orca's
native default-flow policy (Standard), subject to Neo's native flow-candidate
and compatibility rules. Do not classify an unreported/unknown capability as
known lack of support.

Unknown nozzle diameter follows Orca's existing device/preset-resolution
semantics rather than introducing a Neo-specific stop/manual-fill/retain-old
policy. The
[upstream diameter matcher](https://github.com/OrcaSlicer/OrcaSlicer/blob/db35f3d0980a622bc158d1f13855abc913cad8ca/src/slic3r/GUI/DeviceCore/DevExtruderSystem.h#L158)
treats the protocol's zero value as unknown and does not reject a preset match
for that reason. Keep unknown data explicit at Neo's domain boundary; zero is
not a valid physical diameter to write into the Printer draft. Preserve Neo's
native value validation and atomic rejection behavior. The
[subsequent upstream sync path](https://github.com/OrcaSlicer/OrcaSlicer/blob/db35f3d0980a622bc158d1f13855abc913cad8ca/src/slic3r/GUI/Plater.cpp#L2473)
assumes a valid diameter choice and asserts its availability; this is not
evidence of a general unknown-diameter recovery policy. Implementation
qualification must exercise this path without inventing or claiming an
upstream fallback that is not present. No generic Printer preview is added.

Filament sync includes mapping source materials onto existing project slots,
color-only updates, and rebuilding the rack. Preview the target compatible
presets, colors, additions/removals and any required reassignment of project
references. Match namespaced catalogue references through the applicable
resource mapping and native compatibility rules; a device catalogue ID is not
automatically a native preset ID. Ambiguous, generic-fallback and unresolved
matches remain visible for review. Empty slots, unknown presence and unavailable
metadata are distinct states. Candidate inclusion and fallback follow the
accepted rules below; review must retain each source's actual presence state.

Default to mapping updates when the project has models, and to rebuilding the
rack from device materials when it has no models. Check the whole project,
not just the selected Plate. Users can change mode in the preview; both defaults
still require modal preview and explicit confirmation, including an empty
project. Color-only updates remain available within the accepted scope.

Each new mapping preview prepares initial suggestions from current device and
project data, using Orca's type/color and applicable tool/path constraints.
Users can adjust the proposal. Keep those choices while reviewing that proposal
and through its permitted reconnect/revalidation flow, but do not persist a
project-material-to-physical-slot association for later sync invocations or
project reopen. An independent invocation always resolves the current connected
source and computes new suggestions. Saved project configuration retains its
ordinary effective presets, colors and references, not a lasting device binding.

Mapping permits multiple project materials to select the same physical source
slot. Keep their project slot identities and model/paint/Plate references
independent; do not merge them as a side effect of sync. The first delivery has
no sync-time merge option. Users can explicitly invoke the existing Merge
workflow separately. Mapping does not establish a persistent Send path binding.

Mapping mode displays the entire project rack, including slots unused by the
selected Plate. A project slot without a selected device source stays unchanged.
Edits affect shared project materials and therefore every Plate using those
slots; the dialog does not create Plate-local copies of the rack.

Mapping mode defaults to appending all unused eligible device materials to the
project rack, with the additions shown before confirmation. Follow Orca's
append-time preset/color duplicate detection, including recognition of a
preserved custom preset for the same filament. Equivalent material already
represented in the rack is not appended again; several identical unused device
slots do not require duplicate project slots. This skips redundant additions,
not a merge of independently existing project slots. Rebuild mode uses the
eligible device-material list under its separate replacement semantics.

If rebuilding removes a project material that still has references, require
the user to choose its surviving replacement before allowing confirmation.
Preview the affected model, painted, support, Plate and tool-change references.
Reuse the existing native Merge reference-remapping implementation for these
explicit replacements, composed into the single rebuild transaction; do not
silently use Delete's slot-1 fallback or discard paint/events as a default.
Reject unsupported reference transformations atomically under the existing
[Delete and Merge contract](Multi-Filament%20Support.md#83-delete-and-merge-with).
This required replacement handling does not add an automatic same-color merge
option to mapping mode, and independent project slots that survive remain
independent even when their device sources coincide.

Usable material metadata is sufficient for a source slot to participate by
default, including slots explicitly empty or with unknown presence. This also
applies to unused-material appending. Show empty/unknown state honestly in the
preview, retain namespaced provenance, and never fabricate physical presence
from metadata. Slots without usable metadata remain distinguishable from
eligible metadata-bearing slots. Importing retained metadata is a project
configuration operation, not a claim that the spool is installed or can supply
a print; Send retains its independent inventory/path validation.

When there is no compatible exact match, follow Orca's complete native preset
fallback sequence: compatible Generic candidates (including its type-word
matching), then the existing selection where applicable, then another
compatible Generic/system preset. Display the actual fallback and its reason
in the preview rather than describing it as an exact match. Native validation
still applies; do not bypass project compatibility constraints. Lack of any
usable native result remains unresolved rather than inventing a preset. The
first delivery does not restrict fallback to same-type Generic presets or
require manual selection for every non-exact match.

For full material updates, preserve the current compatible custom Filament
preset when its non-empty native `filament_id` matches the resolved sync
preset's ID. Retain its tuned effective configuration and source-local draft,
while applying the reviewed tray metadata such as slot colors. Do not replace
it with its system base solely because the device reports that base. Resolve
the device catalogue reference before this comparison; matching display names
or only material types does not establish this identity. This follows the
[upstream preservation rule](https://github.com/OrcaSlicer/OrcaSlicer/commit/db35f3d0980a622bc158d1f13855abc913cad8ca).
Distinct project slots sharing the source retain Neo's existing shared-draft
ownership; sync does not create per-slot preset copies. Incompatible or
different-ID presets follow the matching/fallback policy above.

Flushing-volume updates use the existing
[All / Color / None policy](Multi-Filament%20Support.md#101-flushing-volume-policy),
including initialization of new pairs, remapping of surviving pairs and native
effective Printer/Filament inputs. Do not add a sync-only calculation preference
or renderer-side approximation. Rack and metadata mutations share the existing
native preference, ordinary 3MF persistence and project history boundaries.

Applying a confirmed material proposal, or executing direct Printer sync, is
one native operation and one Undo entry. It must keep
the Printer/project configuration, rack identities, model and painted
assignments, Plate references/mappings, flushing state and affected slice-result
lifecycles coherent. Return a complete authoritative receipt; do not simulate a
batch by issuing independent renderer-side add/delete/preset/color commands.
Reject stale or invalid input without a partially applied project. The
[domain synchronization contract](Printer%20Domain%20and%20Control%20Architecture.md#6-material-systems-and-synchronization)
owns provenance and revision validation; existing rack, history and persistence
specifications continue to own their respective state.

The agent owns device-protocol interpretation and vendor resource associations;
the shared application owns source selection, review and orchestration; the
native Worker owns preset compatibility, configuration conversion and project
application. Keep Emscripten access behind the typed client/runtime boundary.
Do not port wxWidgets dialogs or expose Orca's MachineObject as a shared API.

Imported project materials do not establish Send's physical material-path
bindings. Print preparation still validates the current target independently.
Auto For Match, dynamic switcher-based slicing, hotend racks and multi-nozzle
inventory selection are outside this first delivery; their presence in the
Orca implementation is not authorization to enable them here.

### Initial device coverage

Enable the initial Bambu integration by applicable capabilities for existing
single-nozzle and fixed-dual-nozzle devices, including mixed diameters. Do not
restrict the feature to H2D by model name. Each action still requires its actual
observation/configuration and native topology support; unavailable capabilities
remain unavailable rather than being invented from the model label. Common
application/domain contracts remain vendor-neutral; other agents gain no
runtime support solely because these contracts exist.

H2D + AMS is the first physical acceptance target. Fixture or development-host
acceptance does not establish real-device qualification for every enabled
model, transport or host. Hotend racks, dynamic switcher-based mapping,
Auto For Match and physical sub-nozzle inventory selection remain deferred
under the scope exclusions above.

### Implementation and qualification

The shared [Prepare workflow](../packages/slicer-app/src/components/workspace/synchronization/PrepareSynchronization.tsx)
uses the same Printer receipt publication and preference handling as ordinary
selection. The native Printer command composes observed hardware into the
existing remembered-rack transition. Material imports share ordinary preset,
color, Merge-reference and flushing primitives inside one native transaction.
The read-only catalogue resolver is shared with Orca's AMS synchronization;
protocol IDs are normalized by the agent before crossing this boundary.

The [source boundary tests](../packages/printer-control/src/synchronization.test.ts),
[workflow tests](../packages/slicer-app/src/components/workspace/synchronization/PrepareSynchronization.test.tsx),
[Printer native smoke](../packages/slicer-wasm/harness/device-printer-sync-smoke.mjs),
[Filament native smoke](../packages/slicer-wasm/harness/device-filament-sync-smoke.mjs)
and [Electron fixture journey](../apps/desktop/e2e/prepare-synchronization.e2e.ts)
cover the software boundaries below. Their fixtures do not qualify a connected
printer. The legacy all-command smoke's separate 100 ms slot-history budget is
not qualified on the current development host: both the new serial artifact
and an unchanged earlier threaded artifact exceeded it. This evidence does not
identify a cause or qualify the broader timing budget.

### Required acceptance boundaries

Complete staged software verification before physical acceptance. Run static,
fixture, native WASM and host-interaction checks first; reserve real-printer
connection and hardware operations for the final acceptance stage.

Verify native compatibility and catalogue ambiguity, model/paint/Plate reference
preservation, color semantics, flushing state, atomic failure, stale proposals,
Undo/Redo and 3MF save/reopen. Exercise the direct Printer action and modal
Filament mapping workflow through an affected host and separately test provider
seams. Physical H2D + AMS acceptance must cover physical-tool order, reported
nozzle/flow differences, empty/unknown
materials, external spools, and slicing/sending after sync. Do not infer broader
model, Cloud or multi-nozzle qualification from fixtures or one hardware target.
Shared contract/workflow fixtures must also cover a non-Bambu-shaped topology
(different tool and feeder-slot counts), missing catalogue associations and an
on-demand material source without unrelated Monitor support. These fixtures
verify extensibility, not implementation or hardware acceptance of another
agent.
Mixed-diameter acceptance must additionally prove complete-vector resolution,
matching-profile and draft fallback paths, ordinary-switch remembered-rack
restoration versus same-source rack preservation, reference repair,
flow repair, effective per-head slice inputs and unchanged canonical-variant
presentation, with one atomic commit and exact Undo/Redo.
Use the repository [testing guidelines](../doc/testing_guidelines.md) for build
and regression scope. Only small device/configuration projections cross into
the Worker; do not copy project geometry or hold the mutation queue during
network waits.

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
Print actions follow Orca's layout: icon-only pause/resume and cancel buttons
sit immediately to the right of the progress bar. Pause and resume share one
button, switching icon, accessible name, tooltip and command from observed
print state. Capabilities, pending/stale-state locks and cancellation confirmation
continue to govern the actions; command acknowledgement does not change the
displayed phase optimistically.
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

The initial control increment excludes remote-file browsing and an HMS tab.
LAN live video is delivered by the separately verified Camera increment below.
The accepted [camera follow-up](#camera-live-view) is a separate increment. Current
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

The Monitor follows the reference's two-column desktop composition: the camera
card above printing progress on the left, with the current-task thumbnail to the
left of the progress information inside the same card; temperature,
lighting/fans, a directional XY pad with homing and Z controls, and individually
addressed extruders on the right. The Print speed mode selector, with its
visible label, sits below Fans and lighting. Material units form a grid beneath the controls, with compact
reported slots and explicit tool paths; external holders remain distinct.
Fan controls, lighting controls and nozzle hardware details are independently
collapsed by default and can expand within their sections.
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

Current printer errors can request a modeless dialog, following Orca's
`DeviceErrorDialog`: show the printer, error code, message and agent-supported
actions once per error/task episode. Ordinary refresh does not reopen a dismissed
dialog. The inline alert remains available through View error details; clearing
the error removes the dialog, and a new episode opens it again. Hidden Device
pages do not display the dialog. Stale/offline status disables recovery actions
without preventing local dismissal. Honor the agent's non-dismissible presentation
when the resource requires it.

Bambu selects the bundled English Orca error/action resource by serial-number
prefix. Empty introductions are internal errors and are suppressed; unknown
errors retain their code and an unknown-error message without invented recovery
choices. Preserve the resource's action order and distinct commands, including
Ignore this and Resume, Problem Solved and Resume, stopping, AMS done/retry/abort,
error acknowledgement and nozzle recheck when present. Ordinary Resume is a
separate operation. Closing the dialog sends Orca's UI-close notification, not
an error-clear or print-resume command. Like Orca, invoking an action hides the
dialog; the designated not-extruded Retry keeps it open. Existing command feedback
continues to report rejection/unknown outcomes without automatic replay.

The agent owns wire fields, task/error context and resource selection. The shared
UI consumes only generic alert presentation and opaque action references; a
reference is rechecked against the current episode during command admission.
Protocol tests cover exact payloads, legacy AMS acknowledgement plus UI close,
incremental-state retention and invalidated references. Component and Electron
fixtures cover presentation, dismissal, visibility, stale state and invocation.
The former real dirty-camera error was recovered outside Neo and does not qualify
these new actions physically. Online HMS updates, illustration/failure-snapshot
retrieval, independent HMS navigation and command-specific guard dialogs are not
implemented by this current-error presentation.

Device calibration may be visible as reported activity, but no calibration
selection/start dialog is included. Detection settings, including device-side
AI/print-detection switches and sensitivity, are excluded even though they do
not require video playback. Camera recording, timelapse and resolution settings
are also excluded. None of these exclusions turns off an existing device
feature: the device keeps its current configuration.

#### Camera live view

**Status:** Implementation is authorized in separately verified increments.
Shared delivery playback, binary contracts, native media integration and the
capability-driven Camera card are delivered within development-host fixture
acceptance. H2D H.264 LAN playback is now accepted on the development host;
physical MJPEG and six-platform packaged playback remain open.
The [printer-domain camera design](Printer%20Domain%20and%20Control%20Architecture.md#81-bambu-lan-live-view-and-shared-playback)
owns contracts, host execution, implementation order and qualification gates.
Keep the pinned Bambu v2.2.0; this is LAN video, including LAN-reachable
cloud-associated devices, without TUTK. Existing recording, timelapse,
resolution-setting and file-browser exclusions remain in force.

The shared Monitor adds a capability-driven Camera card separate from the
current-task Print preview. Its player chooses by delivery descriptor, not
printer vendor: H.264 fMP4 through MSE into `video`, JPEG frames or HTTP MJPEG
through `img`, remote browser-compatible URLs directly in `video`, and HLS
through native support or hls.js. JPEG is not transcoded to unify elements.
Unknown/unavailable camera information must not be presented as confirmed
hardware absence. A source format unsupported by the current host gets an
explicit playback-unavailable state without disabling other monitor cards.

Provide Play/Stop, retry, fullscreen and connection/playback status. User Play
opens the resource; connection readiness is distinct from the first displayed
frame. Use muted inline video and handle browser autoplay rejection with a
Play action rather than a reconnect loop. Live view is not a recording or
seekable history. Use a 16:9 placeholder while stopped, connecting or
unavailable. Once media dimensions are known, size the viewport to the actual
video or image aspect ratio without cropping or stretching. Keep the same
surrounding controls for both presentations. At narrower widths, the camera and
progress cards remain vertically stacked above the controls. Fullscreen
preserves the existing stream and scales the image/video to the available viewport. On macOS Electron, HTML
fullscreen fills the app window using
[`disableHtmlFullscreenWindowResize`](https://www.electronjs.org/docs/latest/api/structures/web-preferences);
native window fullscreen remains an OS action. This avoids the observed
HTML/native Space transition that left enter/exit promises pending during the
H2D development-host run. The toggle is disabled while a transition is pending;
Electron UI acceptance verifies both entry and exit with a decoded frame.

Stop on device/route change, leaving the monitor, document hiding or closure.
Top-level pages remain mounted, so cleanup must follow visibility as well as
component destruction. Returning from temporary hiding may reopen only while
the same device retains prior viewing intent; explicit Stop clears that intent.
Late open results must be closed and old callbacks/frames ignored. Bounded
transport retries are allowed while viewing is requested; authentication,
disabled-camera and unsupported-format failures require user action. Do not
change device recording, timelapse or print state when viewing starts/stops.

The implemented [viewing owner](../packages/slicer-app/src/components/device/media/useCameraView.ts)
serializes release/reopen, closes late opens, renews resource leases, watches
metadata errors and stops on component, route or document visibility changes.
Errors require explicit Retry; no automatic authentication or decoder retry is
performed. The [Camera card](../packages/slicer-app/src/components/device/media/CameraCard.tsx)
uses reported camera names and retains the independent current-task preview.
Unknown camera fields show an explanation, not hardware absence; reported LAN
protocols select JPEG or fMP4 capabilities. Disabled live view stops viewing and
requires Play again once enabled. Recording/timelapse state remains unknown
unless reported, and viewing never writes those settings.

Development acceptance includes lifecycle/renewal tests, Chrome/Electron real
MSE/JPEG/direct URL/HLS playback, and the full shared Monitor in Electron with a
generated JPEG frame through the production renderer adapter and MessagePorts.
The UI fixture verifies first decoded frame, control submission during viewing,
hide/resume, explicit Stop and device switching. It does not establish physical
printer control responsiveness, LAN authentication or hardware stop latency.

The real-H2D follow-up passes sustained H.264 playback across lease renewal,
Play/Stop/reopen, Home hide/return, normal-window minimize/restore and window
closure. Fullscreen enters/exits without replacing playback. Precise timings,
browser dropped-frame accounting and remaining hardware/host boundaries are in
[H2D camera acceptance](Printer%20Domain%20and%20Control%20Architecture.md#h2d-lan-development-host-acceptance).

Development-mode acceptance additionally covers React StrictMode: replayed
mount effects must not attach and then close the single-consumer camera stream.
The player defers attachment until after synchronous effect cleanup, while real
unmount and Stop still release playback. Desktop dev CSP permits the same
`media-src 'self' blob:` sources as production, so MSE can load its Blob URL.
A real H2D dev run passes sustained decoding and three Stop/Play cycles with no
media CSP violation; the StrictMode regression test fails before this fix.
Changing dev-server CSP requires restarting the dev command, not only refreshing
the renderer. Desktop dev HTML requests bypass conditional caching so a cached
document cannot retain the old CSP after a server restart; module caching remains
enabled. Acceptance includes reloading with an existing HTML ETag and the normal
development profile. Production-only playback acceptance does not cover these dev paths.

The first delivery has one Bambu view per application instance. Remote-URL
player verification may use a fixture agent; it does not deliver a remote-agent
configuration UI. Mobile product support is deferred, with touch-usable controls
and bounded memory/hidden-view cleanup required by the shared design.

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

For Bambu commands without reliable physical-completion evidence (jog, home,
extrusion, nozzle refresh and contextual recovery), a matching successful device
ACK ends the pending interaction silently, without a success confirmation message.
Controls become available subject to current telemetry and normal preconditions;
there is no subsequent completion timeout for that accepted command. Commands
with reliable completion predicates continue waiting after ACK. Neither a native
send return nor an unrelated ACK is sufficient to accept a command.
Observed completion also clears pending feedback without a success message.
Only errors and unknown outcomes display command feedback. Intermediate sent,
acknowledged and running phases show no status message; pending controls remain
disabled to prevent duplicate submission.

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
| Command implementation details | Implemented: 15-second telemetry freshness, 10-second explicit-read timeout, 30-second ordinary-command response/completion timeout, ten-minute material load/switch/unload completion timeout, and instance-lifetime operation/request retention. The material bound accounts for firmware warm-up, feeding and wiping observed during LAN acceptance. New accepted telemetry can confirm target/task/path state. Commands without reliable physical-completion evidence finish tracking as accepted on a matching successful ACK; missing ACKs remain unknown on timeout. Acceptance never claims physical completion. Hardware acceptance must establish actual firmware outcomes and tune these bounds if evidence requires it. |
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

This section describes the delivered Moonraker workflow. The selected
[print-submission design](#print-preparation-and-submission) adds a distinct
agent capability through the existing Send & Print action. Its accepted
[entry and selection rules](#accepted-entry-and-selection) supersede the
delivered Send & Print initial-selection behavior described below when
implemented; Send remains an upload-only action.

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

## Print preparation and submission

The shared preparation modal and initial Bambu-only submission capability are
implemented. It copies the current Device selection once, owns its mapping and
options, saves explicit option changes per physical printer, and locks project
editing while open. Agent diagnostics control availability and per-send warning
confirmation. Sending/cancellation remain visible until the agent reports their
outcomes; successful plugin completion closes the modal and selects the printer
in Device, where actual print progress is observed separately.
The former Moonraker upload/start flow remains available through the same entry.

Software validation on macOS ARM64 includes shared component tests, the complete
shared-app unit suite and workspace typechecks. The Bambu Electron fixture covers
renderer/preload/main requests, binary chunk delivery, persisted options,
cancellation and successful-send navigation; Moonraker send/retry and keyless
regressions pass. The fixture caught and fixed an observation target carrying a
command-only revision field. Physical acceptance is separate: development-host
H2D LAN qualification now covers two completed right-nozzle PETG runs from AMS
2 Pro B1 and one completed fixed-dual-nozzle run from left AMS 0 A2 and right B1.
The user confirmed normal feeding, first-layer extrusion, nozzle switching and
both finished cubes without obvious defects or missing material. Device reported
50/50 layers, 100%, ready and all heater targets zero. Both production builds
`87c7f259` (single nozzle) and `574c6f0d` (dual nozzle) physically verified the
Orca-style plugin-success transition: the modal closed automatically and Device
selected Fox and Fox with the exact submitted task name.

The dual-nozzle task paused at `0500808F` before its first layer. The user continued
through Orca or the printer; Neo observed recovery and did not resend. Neo's
error-specific dialog and ignore/problem-solved continuation actions now have
software coverage; this earlier external recovery is not a passed Neo recovery case. Other supply paths remain open and Cloud
physical acceptance is deferred. Preserve the precise
[domain qualification boundary](Printer%20Domain%20and%20Control%20Architecture.md#implementation-progress).


**Decision status:** Adopt a shared, capability-driven preparation UI and a
generic local-artifact submission contract (option B), initially enabled only
by the Bambu agent. The sections below record the accepted product decisions
and explicitly deferred scope. Delivery and physical qualification are limited
to the implementation and acceptance described above. The
[domain design](Printer%20Domain%20and%20Control%20Architecture.md#24-local-artifact-print-submission)
owns artifact provenance, agent execution, outcome semantics and implementation
validation boundaries. Preserve the existing Moonraker workflow.

The preparation view presents the target printer and plate preview,
estimated duration/consumption, editable material bindings, device-supported
print options, and actionable blocking/warning diagnostics. Each mapping row
connects a used slice material to an actual device supply path and shows its
target tool. Group candidates by reported units/slots without hard-coded
four-slot AMS layouts or fixed left/right array positions. Shared controls use
capabilities and topology; Bambu-specific compatibility and wire rules remain
inside its agent.

The preparation modal follows Orca's `SelectMachineDialog` layout: a plate
thumbnail on the upper left; the editable submission name, estimated time and
weight, printer selector, refresh action and build-plate type as text directly
below the printer name (without a separate plate icon) on the
upper right; filament source cards grouped by slice nozzle in the middle; and
two columns of segmented print options above the Send action. Narrow windows
stack nozzle groups and options vertically and scroll the modal body.
The thumbnail reuses the existing local plate renderer and releases its GPU
resources and object URL when closed. Missing preview graphics never block a
valid print. Renaming affects the submitted artifact and the task name shown by
the printer, not the project. The shared submission request carries the dialog
name explicitly as `jobName`; the Bambu agent passes it as the native task/project
name. Formatted export filenames may contain material/time suffixes and must not
be used to derive the task name. Upload filenames remain transport details and
are not used to decide successful sending. Plugin success ends submission;
Device shows actual preparation and printing independently.
Each material card shows the sliced material colour above the selected device
source colour. Transparent colours render over an opaque grey/white checkerboard, including
partially transparent colours; text contrast uses the composited appearance.
Missing colours use the current theme's surface and foreground colours.
Its picker follows Orca's `AmsMappingPopup`: a slot-card popover grouped by
reported tool, feeder unit and external holder, with source colour,
slot label, material type, selected checkmark and reported remaining fraction.
It retains empty, incompatible and unreachable slots as disabled cards with
agent-provided reasons. Unknown occupied materials display `?` and remain
selectable when the agent permits them. A reset action clears only the current
material binding; selecting a slot closes the popover, and Escape closes the
popover without closing print preparation. Unit capacity comes from the reported
topology, not a hard-coded four-slot AMS layout. The agent supplies unit/category,
slot and tool labels and selection eligibility together with each source.
Supply-device names (`unit.name`) and category labels (`unit.categoryLabel`) are
displayed as provided by the agent. The picker title and category headings must
not translate `automatic-feeder` into a vendor name: Bambu supplies `AMS`, while
another agent can supply `MMU` or its own product name without shared UI changes.
Its picker exposes the full source name and material type;
unassigned and unavailable selections stay explicit. Nozzle labels arrive in
slice tool-index order from the agent (`nozzleLabels`); the shared renderer does
not infer physical left/right positions from device IDs. Bambu reports Left
Nozzle then Right Nozzle for the supported fixed dual-nozzle slice layout.
Device warnings sit between materials and print options. Options retain their
agent-provided visibility, values and enabled state; the application-wide
abnormal-storage preference remains outside this modal.

Automatic suggestions and manual changes operate on the submission draft.
They do not recolor the editable project or replace slicing tool assignments.
An explicit material import is a separate workflow. The accepted mapping rules
below govern suggestions, editing, refresh, unknown material information and
lifetime.

#### Accepted initial delivery envelope

The user confirmed the following scope as one group:

- Support ordinary single-nozzle Bambu printers with AMS or an external holder,
  and H2D fixed dual-tool supply paths. H2D is the primary physical acceptance
  target; this does not establish qualification for every single-nozzle model.
- Include fixed tool assignments produced by the slicer's automatic allocation.
  These are not the special dynamic mapping mode. Hotend racks and special
  dynamic filament/nozzle mapping are deferred to a later extension.
- Both LAN and Cloud submission are required for this delivery and need separate
  verification. LAN-only implementation does not complete the agreed scope.
  First physical acceptance uses H2D with AMS over LAN; Cloud physical acceptance
  is deferred while Cloud stays in the functional design scope. Record untested
  routes and models explicitly. Transport selection and fallback follow the
  accepted execution rules below.
- Permit submission of any one Neo plate with a valid completed slice result,
  with one plate per submission. Importing external print packages, reprinting
  files already on the printer, and multi-plate submission/queues are deferred.

External multicolor assistance is included under the capability and interaction
rules below. Broader hardware/firmware combinations require separate acceptance.
The agreed hardware envelope does not automatically approve every
special mode available on those printers.

#### Accepted entry and selection

Reuse the existing **Send & Print** action. A printer advertising the new
submission capability receives the material-mapping and print-options flow;
other printers retain the existing upload/start execution. **Send** continues
to mean upload only; adding Bambu upload-only support is outside this increment.

When opening Send & Print, initialize the target from the Device page's current
printer selection if it is a suitable target for this action. Otherwise leave
the selector empty. Do not fall back to another printer in the list. The
dialog's selection is independent after opening: changing it does not change
Device selection, and no separate remembered Send & Print target overrides the
initial Device selection. Actual compatibility/readiness checks remain required
before submission; preselection is not print authorization.

The user first selects the desired sliced plate in the workspace and opens
Send & Print. Bind the modal to that current plate and its completed slice
result; show its name and preview without an in-dialog plate selector. This
implements the accepted ability to print any valid Neo plate through workspace
selection, one plate per submission.

Use a modal dialog. While it is open, prevent project editing, workspace plate
switching and starting another slice. Opening requires a valid completed result
and no active slicing. Result changes are therefore not an ordinary interactive
case: do not design a separate result-changed/reopen flow. Retain underlying
receipt validity checks at export/submission so obsolete results cannot be
published if an invariant fails. Device observations can still update while
the project remains fixed, under the mapping and observation rules below.

Orca's
[print action](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp) passes the
current plate into a modal machine-selection dialog; upload-only uses a
separate dialog. Its machine list prioritizes the currently selected device
and defaults to the first entry, with restoration of the last machine when
none is selected. Neo deliberately uses the accepted Device-selection-or-empty
rule instead of that fallback.

#### Accepted basic material mapping

- Automatically populate suggested bindings from legal supply paths using
  matching material type and nearest color, allowing manual adjustment. Leave
  requirements without a suitable match unassigned, except for the explicit
  external-holder behavior below. Suggestions never initiate printing.
- Follow Orca's ordinary AMS reuse rule: multiple slice material requirements
  may share one actual slot when their material types match and their supply
  paths are legal. Color and brand need not match; show the actual selected
  slot/material/color so reuse is apparent. Agent validation still checks the
  complete mapping against device restrictions.
- Follow Orca's external-holder exception, including automatic assignment when
  the entire eligible candidate set is exactly one external holder. An occupied
  AMS slot with unknown material remains a manual candidate and prevents this
  sole-candidate fallback. A material-type mismatch produces a warning without
  blocking submission. This is an explicit
  exception to leaving unmatched requirements empty; it does not bypass other
  path, printer or nozzle checks.
- Follow Orca's model configuration for mixing AMS and external supply within
  one print. The Bambu agent owns interpretation of
  `print.support_ams_ext_mix_print` in the pinned printer resources; the shared
  UI does not hard-code model identities. Orca defaults a missing value to
  false. When mixing is not allowed, a plan containing both supply kinds blocks
  submission with an explanation. A true value is only permission under this
  check, not proof of automatic external-spool switching or universal path
  compatibility.
- Preserve existing bindings during device refresh; do not automatically move
  a requirement to another slot. Mark invalid bindings and block submission
  until resolved, including an emptied AMS slot, incompatible material type or
  lost supply path. External-holder type mismatch remains warning-only under
  the exception above. Unknown material information and stale observations are
  handled separately below.
- Bindings live only within the current dialog and selected printer. Reopening
  the dialog or changing printer clears them and performs a fresh match. Do not
  persist them across openings or cache a previous printer's choices for later
  restoration. Refreshing the same printer in the same dialog preserves them.

Orca's
[matching algorithm](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevMapping.cpp)
filters ordinary candidates by material type and scores color distance; it
allows slot reuse and has a sole-external-candidate fallback. The
[manual picker](../packages/slicer-wasm/cpp/src/slic3r/GUI/AmsMappingPopup.cpp)
checks normal AMS material types, while the print dialog disables that check
for external holders and reports a non-blocking mismatch warning. The
[model configuration reader](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevConfigUtil.h)
reads the mixed-supply flag from the model resource's `00.00.00.00` section;
this particular check is not a live firmware-version comparison or reported
capability bit. Keep that vendor policy in the agent.

#### Accepted observation and external assistance behavior

An AMS slot with positively reported filament presence but unidentified material
information is not an empty slot. Do not automatically match it. Allow explicit
manual selection when the supply path is legal and explain that material type
cannot be verified. This is an exception for unknown metadata, not permission
to select a known incompatible type or to treat unknown presence as present.
Orca's [picker projection](../packages/slicer-wasm/cpp/src/slic3r/GUI/AmsMappingPopupUpdate.cpp)
shows an occupied unidentified slot as `?` and permits picking it without the
normal identified-material type comparison.

On opening the modal, wait for a device observation read to complete before
running preparation validation or accepting initial mapping suggestions. Initial
loading and explicit device refresh show a loading status; display diagnostics
only once that refresh completes. A failed read shows its connection/read error;
stale Bambu telemetry reports one blocking status issue rather than cascading
missing-material, nozzle and storage diagnostics. Automatic observation updates
continue to revalidate cached state without initiating a device read each time.

Keep device observations updating while the modal is open. A normal refresh in
progress does not disable printing when the retained relevant state remains
valid. If the device disconnects or critical observations become stale, retain
the bindings but block starting a print. Critical observations include the
connection/readiness, supply paths and selected AMS slot presence needed to
validate this submission. Successful automatic updates and revalidation restore
the start action without requiring a manual refresh. Reported unidentified
material metadata is distinct from stale/unavailable observations and follows
the explicit-selection rule above. Exact freshness timing is an implementation
detail governed by the observation contract, not a requirement to invalidate
state during every refresh cycle.

Include **Multi-color with external** in this delivery. It enables manual
external-spool changes during printing when multiple slice material requirements
share an external holder. Follow Orca's actual device capability reports to
decide whether the option is shown; do not infer support from a model name or
the separate AMS/external mixing configuration. The Bambu agent interprets the
old and new reported capability forms in
[DeviceManager](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceManager.cpp)
and exposes the capability to shared UI.

Default this option to off for each new dialog and require an explicit user
choice to enable it. Follow Orca's mapping eligibility: multiple material
requirements must map to the same external holder before the option is usable.
Do not carry an enabled value onto an unsupported target or ineligible mapping.
The existing mixed-supply and legal-path checks continue to apply. Agent-owned
submission translates the choice into the native print parameter; shared UI
does not send vendor protocol fields. The saved print-option preferences below
must not change this explicit-off decision.

#### Accepted print options and preferences

Include bed leveling, flow dynamics calibration, nozzle offset calibration,
timelapse and Shared PA Profile in this delivery. The Bambu agent exposes the
available choices and applicable constraints using Orca's device capability,
display and effect conditions; shared UI does not hard-code model identities.
Preserve automatic/on/off semantics where supported instead of reducing an
automatic calibration choice to a boolean. Shared PA Profile applies only under
Orca's PA-mode capability and flow-calibration-off conditions; it controls
whether nozzles and filaments of the same type share PA calibration parameters.
Include timelapse storage-location selection when supported and validate storage
conditions. Recording-file browsing and downloads are outside this scope.

When no valid saved preference exists, follow Orca's defaults:

| Option | Initial preference |
| --- | --- |
| Bed leveling, flow dynamics calibration, nozzle offset calibration | Automatic when supported; otherwise on when available. |
| Timelapse | On, subject to device and current-condition checks; disable and turn off when those checks do not permit it. |
| Shared PA Profile | On, subject to its display and effect conditions. |

Persist user changes immediately as preferences for the **physical printer**,
including when the user subsequently cancels the preparation dialog. Saving is
independent of sending: pending or failed preference writes do not block printing
with the current in-memory options. Show a save-failure notice and retain the
ability to retry saving. Restoring a preference still requires validation against
the target's current supported choices and conditions. This is local application
persistence, not a change to
the device's persistent settings or project configuration.

Store these preferences in Electron's existing `printer-config.json`, in a
separate section keyed by stable domain printer identity. The same physical
Bambu printer shares preferences across LAN and Cloud; display-name or IP-address
changes do not select a new preference record. Cloud-only printers must not
require a fabricated Moonraker connection record to store preferences. Keep
provider credentials and native account state under their existing ownership.
Shared application code accesses the host-injected persistence boundary rather
than reading the file directly; preserve the shared Web/Electron architecture.

Persistence now extends the
[configuration schema and normalization](../packages/printer-control/src/configuration.ts)
and the host persistence/merge paths together so preferences survive ordinary
configuration edits and independent application instances do not overwrite
unrelated changes. Preference edits must not change connection configuration
revisions or trigger reconnection. The optional `printPreferences` section is
keyed by physical printer ID; `allowAbnormalStorage` stores the global opt-in.
Electron merges preference edits per printer and option, rejecting conflicting
edits to the same option. Web normalization also preserves the fields. Explicit
preparation-option edits are saved immediately, including when the dialog is
cancelled. Device-refresh normalization and submission-only effective-option
fallbacks do not overwrite the saved preference.

Orca's [option handling](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachine.cpp)
stores these switches by printer type in application configuration when the
user changes an option. Neo deliberately changes that granularity to physical
printer identity. Material mappings remain dialog-local and external multicolor
assistance remains explicitly off on each new dialog.

#### Accepted timelapse storage behavior

Persist the user's storage-location selection per physical printer in
`printer-config.json`, immediately on user change and even if the preparation
dialog is subsequently cancelled. Unlike Orca's dialog-memory-only location,
this preference survives reopening the application. Without a saved preference,
prefer available internal storage, otherwise available external storage. If
neither is usable, apply the submission-only timelapse disabling rule below.

Keep the saved preference separate from the effective choice for this
submission. When restoring preferences or refreshing device state, if external
storage is unavailable but internal storage is available, switch this submission
to internal storage and explain the fallback. Preserve the saved external
preference; only an explicit user change to the location replaces it. If no
recording location is usable, turn off and disable timelapse for this submission,
explain why, and retain the saved timelapse-on preference. Printing may proceed
when its other checks pass. Known unavailable storage is distinct from an
unsuccessful capacity query.

Request recording capacity once during the send-time preparation check. Reuse
that result through warning/action confirmation and do not query again during
submission. Like Orca, submission executes the selected options and any explicitly
authorized cleanup; it does not require a previous preparation call. A direct
submission can therefore omit this optional recording diagnostic.

When the device capacity check confirms insufficient recording space, offer
turning off timelapse for this submission and printing, without changing the
saved preference. Also offer **Clean up oldest videos and print** under Orca's
conditions: internal storage, or external storage reporting existing videos,
with the corresponding agent capability available. Explicit confirmation for
this submission authorizes the Bambu agent to send the oldest-timelapse cleanup
command before starting the print. Do not silently delete videos or treat a
previous confirmation as standing permission. Dismissing the confirmation
returns to preparation without dispatching cleanup or printing. This bounded
cleanup action does not add recording-file browsing or downloads.

If the recording-capacity check fails or times out, keep the effective timelapse
choice and allow printing with a visible notice that recording space could not
be verified and the video might not be saved. This outcome does not authorize
cleanup. Connection, material mapping and other critical print checks still
apply; failure of this optional capacity check is not proof of valid critical
device state. Orca likewise proceeds on capacity-check failure or timeout, and
its insufficient-space confirmation explicitly sends the oldest-video deletion
command before print dispatch. Cleanup/start failure and cancellation outcomes
remain subject to the execution decisions below.

#### Accepted compatibility checks and acknowledgements

The Bambu agent owns printer-model compatibility checks, using Orca's rules and
model resources. Identical model IDs pass; otherwise the slicing model must
appear in the target printer's compatible-model list. A known incompatible
combination blocks sending. An absent model ID follows Orca's advisory behavior:
explain that compatibility cannot be verified without blocking solely on that
absence. After compatibility passes, retain Orca's send-time model-mismatch
confirmation and its P1P/P1S and upgrade-kit exceptions. Shared UI renders the
agent's diagnostics rather than hard-coding model names. See Orca's
[compatibility predicate](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevConfigUtil.cpp)
and [send-time checks](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachine.cpp).

An installed nozzle diameter differing from the slicing requirement may be
overridden through explicit acknowledgement that the user checked the installed
nozzle and wants to print. Display all affected nozzle positions and their
installed versus required diameters for dual-nozzle devices. Acknowledgement is
valid only within the current dialog, for the current printer and current
mismatch content; it is not a saved preference and must not cover a changed
mismatch. It does not waive unrelated blocking checks.

Apply Orca's material prohibition and risk rules for the accepted hardware
scope through the Bambu agent. Evaluate the relevant material, vendor, model,
supply-path and nozzle context rather than reducing these checks to material
type matching. Preserve rule severity: prohibitions block submission with no
user override; warnings show their reasons and require confirmation for this
submission before continuing. Do not persist acknowledgement as a long-term
preference. These checks complement the accepted mapping rules, including
ordinary AMS reuse and the external-holder type-mismatch exception.

For the accepted fixed-nozzle hardware scope, block sending when the material's
required nozzle hardness exceeds the known installed nozzle hardness. This is
not overridable. If nozzle material is unknown, explain that hardness cannot
be verified but do not block solely on that missing material information;
all other checks still apply.

Follow Orca's nozzle flow-type gate: when the device supports that capability,
invalid flow-type data or a mismatch between the installed nozzle and slicing
requirement blocks sending without an acknowledgement override. Devices that
do not support the capability skip this check. The agent determines capability
and matching; the user must correct device nozzle settings or the slicing
configuration to resolve a reported mismatch.

Follow Orca's device-readiness gates for printing or system print tasks,
filament changes, upgrades, AMS setup, and required forced or consistency
upgrades. Keep existing mappings and option selections while blocked. Once
readiness and all other checks recover, enable the print action again and
require the user to click it. Do not queue a submission to start automatically
when the printer becomes available.

Follow Orca's model- and transport-dependent print-file storage checks, including
the supported internal-storage exceptions. Add a persistent application-wide
**Allow Abnormal Storage** option, default off, under **Preferences → Developer
→ Storage**, matching Orca's placement. It is not shown in the print-preparation
modal. Changes save immediately to the existing global `printer-config.json`
field, including when Preferences is subsequently closed with Cancel. Printing
reads the saved value without offering a per-submission override.
When enabled, apply Orca's abnormal-storage override conditions; it does not
waive separate missing-card, read-only or unrelated readiness checks. This is
a global preference, distinct from the per-physical-printer print options.
Keep print-file storage eligibility separate from optional timelapse recording
eligibility.

The Bambu agent also applies Orca's special-material flow-calibration rules
from the relevant model/material configuration. Where automatic calibration is
unsupported for the material, selecting Auto blocks sending until the option
is changed. Selecting On produces the advisory that the device skips calibration
and uses its existing calibration value, while permitting sending if other
checks pass. Do not collapse Auto and On into the same validation outcome.

For other pre-print checks applicable to the accepted hardware scope, follow
Orca's conditions and severity through the Bambu agent. This includes applicable
color-count limits and model/firmware-specific material restrictions. Explicit
Neo decisions in this specification take precedence over the reference behavior.
This baseline does not bring deferred hotend-rack or special dynamic mapping
features into scope.

#### Accepted sending paths, cancellation and closure

The Bambu agent automatically prefers LAN when the target, credentials, firmware
and storage meet the required conditions; otherwise it uses Cloud when available.
Resolve `support_cloud_print_only` from the pinned model/firmware resources,
with explicit device/capability booleans overriding those defaults, including
`false`. For a device with both routes, this flag excludes LAN; a LAN-only
device remains local, following Orca's separate LAN path. Evaluate these
conditions once when sending begins and retain the prepared state and connection
data through the send, as Orca's `PrintJob` does. Device updates during connection
setup or upload do not trigger another route selection or full validation.
Show the actual selected path and any path change in submission progress.
Automatic fallback is permitted only when the agent can
establish that printing has not been initiated. If a start may have been sent
and its outcome is unknown, reconcile device state before considering another
attempt; never blindly resend through Cloud. Do not add a user-facing or hidden
LAN-only sending preference in this delivery. Orca's `lan_mode_only` is a hidden
configuration read, not an existing preference-page control to reproduce.

During preparation or upload, provide **Cancel sending**. Once requested, show
**Cancelling** and wait for the agent to confirm termination and that printing
was not initiated before returning to preparation with the mappings and options
retained. A cancellation request alone is not a cancelled outcome. If cancellation
races with start dispatch and non-start cannot be established, follow the unknown
outcome path instead of enabling an immediate resend.

Once the start command has been sent, or may have been sent, stop offering
Cancel sending and reconcile the start outcome. Stopping a physical print uses
the separate Device cancel-print action; it is never an implicit consequence of
closing this dialog or cancelling transfer. Disable direct window closure and
Escape while sending or cancellation is pending. Allow closure after success,
failure, or an explicit unknown-outcome state. Once the native call settles,
an unknown outcome releases the submission's connection lease and temporary
files; retain its outcome record without holding the printer selection.

Orca's window-close handler requests worker cancellation and immediately closes
the dialog; its progress Cancel action requests cancellation and returns to
preparation. Worker/plugin cancellation is cooperative. Neo deliberately waits
for authoritative cancellation outcome before restoring preparation and does
not equate a closed window with a stopped printer.

#### Accepted success presentation and retry

A successful plugin return completes sending, matching Orca: report **Print job
sent**, close the dialog, open Device and select the target physical printer.
Do not wait for a matching filename, task identifier or observed preparation/
printing state. Actual print progress is shown independently in Device; send
success does not claim physical print start. This post-success navigation selects
the submitted printer; preparation-time selection remains independent of Device.
If the outcome is unknown, retain its explanation and let the user close the
dialog or open Device to inspect the printer instead of navigating as if success
were established. The user can select another printer; the uncertain submission
does not keep a monitoring connection or block subsequent submissions. Reusing
its original request identity returns the recorded outcome without sending again.

For a failed send, provide a direct **Retry** action that re-enters the normal
sending flow with the current preparation choices. Follow Orca's simple retry
interaction rather than adding a recovery wizard or separate user steps to
prove non-start. Normal submission checks still apply. This does not turn an
unknown start outcome into an ordinary failure or authorize automatic resend;
the accepted unknown-outcome reconciliation and fallback boundaries still apply.

#### Reference and implementation boundaries

Orca's reference flow is
[SelectMachineDialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/SelectMachine.cpp):
choose a device, suggest/edit material assignments, evaluate printer/material
checks and print options, then prepare/send the print. Orca also has
device-specific multi-plate, external-feed and hotend-rack paths. Review each
applicable behavior within the accepted envelope rather than claiming universal parity.

Keep preparation, transfer and submission-outcome feedback distinct and report
unknown outcomes explicitly. A plugin success or transfer completion is not
proof of physical print start. Reconciliation timing and operation retention
are implementation validation items under the domain contract; they must not
turn timeout, lost observation or an expired record into proof of non-start.
Application-exit behavior during submission is explicitly deferred from this
clarification round; no quit-confirmation or restart/resume policy is accepted
here. The
existing Moonraker speed/countdown/retry behavior above is not automatically
the specification for a combined Bambu submission.

The shared UI remains host-neutral. Initial concrete execution uses the
existing Electron Bambu provider; a static Web gateway is not introduced by
this direction. Mobile support remains deferred under the shared application
policy. Artifact packaging stays off the renderer thread, and binary transport
must avoid unnecessary copies and keep temporary files host-private; exact
memory/size limits require the artifact feasibility check.

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
automatically starts in heating mode. The initial manual 30-percent Fan 6 test has command/report evidence only;
its physical behavior remains unqualified. Automatic heat-circulation fan
start/stop is separately qualified by the chamber-heating test below.
The provider now derives descriptive fan names from Orca's AIR_FUN mapping,
using the compact labels Parts, Aux, Exhaust and Heat for fan IDs 1, 2, 3
and 6, respectively. Pinned model/mode/submode label overrides take precedence as in
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

### Independent LAN chamber-heating acceptance

On 2026-10-24, the user separately authorized a 40 C chamber target, waiting
for actual temperature to reach 40 C, a ten-second target hold and restoration
to zero, including firmware-controlled fan/airduct interaction. The production
Monitor set the target successfully. Fresh telemetry showed actual chamber
temperature rising from approximately 27 C through 33, 36 and 39 C to 40 C.
The ten-second hold began only after the actual 40 C reading. The zero-target
command then completed and fresh telemetry confirmed its restoration.

During heating, the heat-circulation fan (ID 6) automatically reported 100 percent.
After restoring the chamber target to zero, the fan automatically reported zero;
no independent fan or airduct-mode command was issued. A later read showed actual
chamber temperature about 37 C, all heater targets zero and all four reported
fan setpoints zero. The user confirmed that the chamber sequence matched the
printer screen and that the physical heat-circulation fan ran and subsequently
stopped. Local timestamped evidence is in `.vitest/lan-acceptance/chamber-40.json`.

This qualifies the authorized LAN chamber set/warm-up/hold/restore sequence and
the observed automatic heat-circulation fan behavior in this mode on this H2D.
It does not qualify the earlier manual 30-percent Fan 6 setting, other chamber
temperatures, print-time interactions or Cloud-only operation. No motion,
extrusion or material command was issued in this stage.

### Independent LAN homing acceptance

On 2026-10-24, the user confirmed the bed was cleared and the motion region was
unobstructed, then explicitly authorized one Home axes action. The production
Monitor dispatched it once without resending. The device remained Live and
subsequently reported idle without alerts. The UI retained the outcome-unknown
message after its completion-confirmation timeout because this action has no
reliable terminal predicate. The user confirmed normal physical homing. A later
fresh motion observation reported all X/Y/Z axes homed; position remained unknown.
Local evidence is in `.vitest/lan-acceptance/home-axes.json`.

This qualifies the single authorized physical Home axes action on this H2D over
LAN, independently of automatic operation completion, which remains unqualified.
It does not qualify directional movement or other printers. No additional motion
was performed to investigate the timeout.

The source audit also aligned explicit-zero home-flag interpretation with
[Orca DevAxis](../packages/slicer-wasm/cpp/src/slic3r/GUI/DeviceCore/DevAxis.h):
an explicitly reported `home_flag = 0` permits all axes; other reported values
use their individual axis bits. An absent flag remains unknown and cannot satisfy
a motion precondition. This compatibility rule is for motion gating, not evidence
that a newly submitted Home axes operation completed. No completion predicate
or automatic retry was added by this correction.

### Independent LAN X-axis small-step acceptance

On 2026-10-24, the user authorized positive X Small step followed by negative X
after stopping. Initial pointer attempts did not dispatch: the automation tool
targeted the center of each clipped direction button's full-wheel bounding box,
where Home is located. Read-only DOM hit testing confirmed that the four visible
direction sectors and the central Home region each hit their intended button.
Subsequent keyboard activation of the focused positive-X button was acknowledged;
the user separately requested one further positive-X attempt, which was also
acknowledged, then confirmed positive-X movement and stopping. No automatic
command retry was used.

Before negative X, a fresh observation reported no homed axes, so no negative
command was dispatched. The user confirmed clearance and authorized one further
Home action, then confirmed its completion. With fresh X/Y/Z homed observations
and idle status, the production Monitor dispatched one negative-X Small step.
The printer acknowledged it and the user confirmed the correct negative
direction, movement and stopping. Local timestamped evidence is in
`.vitest/lan-acceptance/x-small-step.json`.

This qualifies physical positive/negative X Small step direction and stopping on
this H2D over LAN. It does not establish exact travel distance or return to the
starting position; rehoming separated the two directions. Position remains
unreported, and these operations still lack a reliable terminal predicate, so
acknowledgment and the UI completion timeout do not prove physical completion.
No other axis, large step, extrusion or material operation was exercised.

### Independent LAN Y-axis small-step acceptance

On 2026-10-24, the user authorized one positive Y Small step followed by one
negative Y Small step after stopping. Fresh observations reported idle status,
Y homed and no alerts. The production Monitor dispatched positive Y once by
clicking inside its visible direction sector; the printer acknowledged it and
the user confirmed correct direction, movement and stopping. The negative-Y
button initially remained disabled while the prior operation awaited completion
confirmation. No second command was dispatched during that interval. After the
operation timed out and the button recovered, fresh state was checked again
and negative Y was dispatched once through its visible sector. The printer
acknowledged it and the user confirmed correct direction, movement and stopping.
No retry or additional Home action was performed in this stage.

The final fresh state was idle with no alerts, all heater targets zero and all
four reported fan setpoints zero. Local timestamped evidence is in
`.vitest/lan-acceptance/y-small-step.json`. This qualifies physical positive and
negative Y Small step direction and stopping on this H2D over LAN. Exact travel
distance and automatic completion remain unqualified because position is not
reported and these operations have no reliable terminal predicate. No other
axis, large step, extrusion or material operation was exercised in this stage.

### Independent LAN Z-axis small-step acceptance

On 2026-10-24, the user confirmed the bed and vertical movement space were clear
and authorized one positive Z Small step followed by one negative Z Small step
after stopping. With fresh idle status and Z homed, the production Monitor
dispatched positive Z once. The printer acknowledged it; the user confirmed
normal motion, stopping and physical bed descent. After the prior operation's
completion-confirmation timeout released the controls, fresh preconditions were
checked again and negative Z was dispatched once. The printer acknowledged it;
the user confirmed physical bed ascent, normal motion and stopping. No retry
or additional Home action was performed in this stage.

The final fresh state was idle with no alerts, all heater targets zero and all
four reported fan setpoints zero. Local timestamped evidence is in
`.vitest/lan-acceptance/z-small-step.json`. This qualifies physical positive and
negative Z Small step direction and stopping on this H2D over LAN, completing
the three-axis small-step direction checks. Exact travel distance and automatic
completion remain unqualified because position is not reported and these
operations have no reliable terminal predicate. No large step, extrusion or
material operation was exercised in this stage.

### Independent LAN X-axis large-step acceptance and observation correction

On 2026-10-24, the user confirmed motion clearance and authorized one positive
and one negative X Large step, with a physical stop confirmation between them.
Fresh motion/status preconditions were checked before each dispatch. The printer
acknowledged positive X; the user confirmed normal direction, visibly greater
travel than Small step and stopping. The first negative-X command was also
acknowledged, but the user initially reported no movement. The step selector was
restored to Small step and no automatic retry was performed.

The user then explicitly authorized one negative-X Large step retry. After fresh
precondition checks, this single retry was dispatched and acknowledged; the user
confirmed normal negative-X movement, greater travel than Small step and stopping.
The selector was restored to Small step. Final fresh state was idle with no alerts,
all heater targets zero and all four reported fan setpoints zero. Local evidence
preserving both attempts is in `.vitest/lan-acceptance/x-large-step.json`.

The source audit found that X uses `xyz_ctrl`, negative `dir = -1` and Large step
`mode = 1`, matching Orca's `DevAxis::Ctrl_Axis`. No mapping correction was made.
The user later clarified that they likely missed the first negative-X movement.
Its physical observation is therefore inconclusive rather than a confirmed
failure to move; no reproducible motion failure or code fix is established by
these attempts. This stage qualifies physically confirmed positive and retried
negative large-step direction, stopping and visibly greater travel, without
claiming the first attempt was physically observed. Exact travel distance and
automatic completion remain unqualified. No other axis, extrusion or material
operation was exercised.

### Independent LAN Y-axis large-step acceptance

On 2026-10-24, the user confirmed motion clearance and authorized one positive
Y Large step followed by one negative Y Large step after stopping, with the step
selector restored afterward. Fresh idle status and Y homed were checked before
each dispatch. Both commands were dispatched once through their visible direction
sectors and acknowledged by the printer. For each direction the user confirmed
normal movement, visibly greater travel than Small step and stopping. The second
command waited until the preceding operation's completion-confirmation timeout
released the controls. No command retry or additional Home action was performed.

The selector was restored to Small step. Final fresh state was idle with no
alerts, all heater targets zero and all four reported fan setpoints zero. Local
timestamped evidence is in `.vitest/lan-acceptance/y-large-step.json`. This qualifies
physical positive/negative Y Large step direction, stopping and visibly greater
travel on this H2D over LAN. Exact travel distance and automatic completion remain
unqualified. No other axis, extrusion or material operation was exercised in this
stage.

### Independent LAN Z-axis large-step acceptance

On 2026-10-24, the user confirmed vertical movement clearance and authorized one
positive Z Large step followed by one negative Z Large step after stopping, with
the selector restored afterward. Fresh idle status and Z homed were checked before
each dispatch. Positive Z was dispatched once and acknowledged; the user confirmed
normal bed descent, visibly greater travel than Small step and stopping. After the
prior operation's completion-confirmation timeout released the controls, negative
Z was dispatched once and acknowledged; the user confirmed normal bed ascent,
visibly greater travel and stopping. No retry or additional Home action occurred.

The selector was restored to Small step. Final fresh state was idle with no alerts,
all heater targets zero and all four reported fan setpoints zero. Local evidence
is in `.vitest/lan-acceptance/z-large-step.json`. This qualifies physical positive
and negative Z Large step direction, stopping and visibly greater travel on this
H2D over LAN. Exact distance and automatic completion remain unqualified. No
extrusion or material operation was exercised in this stage.

### Independent LAN tool-selection and right AMS load acceptance

On 2026-10-24, the user authorized selecting the left nozzle, then restoring the
right nozzle after physical stop confirmation. Each action was dispatched once.
Fresh active-tool observations changed from right Tool 0 to left Tool 1 and back
to right Tool 0, satisfying the selection completion predicates. The user confirmed
both physical changes, stopping and agreement with the printer screen. No heater
target or material command was issued during tool selection. Local evidence is
in `.vitest/lan-acceptance/tool-selection.json`.

The user separately authorized loading AMS 2 Pro 1 Slot 0 (first physical slot,
cyan PETG) to right Tool 0, including firmware heating, feeding and wiping. The
reported path, material identity, slot presence and unloaded tool were checked
before one Load dispatch. Firmware set the right nozzle target to 250 C and later
245 C; all other heater targets stayed zero. The path became selected/loaded while
activity still reported loading, so path selection alone was not taken as physical
completion. The user confirmed the ongoing normal workflow and then its completion,
with cyan PETG at the right nozzle, feed/purge/wiping stopped and screen agreement.
Firmware restored the right target to zero without an additional command. No retry
was issued. Local evidence is in `.vitest/lan-acceptance/right-ams-load.json`.

This run exposed two feedback defects: the normal multi-minute workflow exceeded
the ordinary 30-second confirmation bound, and completed H2D material activity was
unknown despite a loaded path. Material load/switch/unload now allow ten minutes;
ordinary commands retain their 30-second bound. Modern activity follows Orca
`DevExtderSystem::IsBusyLoading/GetLoadingExtder` using the reported system busy bit
and loading-tool ID. Legacy AMS activity uses the main high byte independently of
its low-byte substate. Missing state or an unknown busy target stays unknown.

After correction, a production restart with the same LAN profile performed only
read-only verification: right Tool 0 retained the selected/loaded cyan PETG path,
both tools reported idle, all heater targets were zero and no alerts were present.
No second Load was performed. Root `pnpm test` passed 2,542 tests with four existing
conditional skips, `pnpm typecheck` passed, and the focused Bambu Electron E2E,
renderer CSS check and production build passed. Tests cover multi-minute material
completion and ordinary-command timeouts. The subsequently authorized switch and
unload below qualify the corrected long-workflow feedback end to end. This stage
qualifies tool selection and the right AMS load's physical outcome; later material
actions are recorded separately below.

### Independent LAN right extrusion, retraction, switch and unload acceptance

On 2026-10-24, the user separately authorized right-nozzle extrusion and retraction
at actual 245 C, each using one 10 mm device-controlled action followed by target
restoration to zero. The first extrusion's physical output was not observed or
was uncertain; the user explicitly authorized one retry and confirmed normal
extrusion on that retry. The separately authorized retraction was dispatched once
and confirmed normal by the user. Before each action the fresh loaded cyan PETG
path and applicable temperature prerequisite were checked; the reported minimum
was 220 C. All heater targets were confirmed zero afterward with no alerts.
No exact output quantity, travel distance or automatic extrusion/retraction
completion is claimed. Local evidence is in `.vitest/lan-acceptance/` under
`right-extrude-10.json`, `right-extrude-10-retry1.json` and `right-retract-10.json`.

The user then authorized one right-nozzle switch from cyan Slot 0 to gray Slot 1
in AMS 2 Pro 1, including firmware heating, cutting, unloading, feeding and wiping.
The Monitor's Load entry selected the switch intent because a path was already
loaded. Requested and actual paths initially differed, then both referenced the
gray slot while activity was still loading; the operation remained pending.
The right target was 245 C while the other heater targets stayed zero. After
more than thirty seconds, fresh idle activity and the loaded gray path completed
the operation in the UI. Firmware restored the target to zero. The user confirmed
the physical workflow completed and stopped. No retry was issued; evidence is in
`right-ams-switch.json`.

Finally, the user authorized one right-nozzle unload, including firmware heating,
cutting, rewinding and wiping. Requested path became null while the actual gray
path remained, with activity unloading. Firmware selected a 225 C nozzle target.
Fresh requested/loaded null paths and idle activity then completed the operation;
all heater targets returned to zero without an additional command. The user
confirmed normal return to the second physical AMS slot, stopping and agreement
with the printer screen. Evidence is in `right-ams-unload.json`. No retry occurred.
This group qualifies the right-side material workflow and corrected feedback on
this H2D over LAN. Left-side material operations and external feeding remain
separate.

### Independent LAN left material-workflow acceptance

On 2026-10-24, the user separately authorized each left-side action, including
the associated firmware heating and movement. AMS 0 physical slot 2 (UI Slot 1)
blue PETG was loaded once to left Tool 1. Firmware initially targeted 250 C, then
245 C, and selected the left tool. The reported blue path plus idle activity
completed the operation; firmware restored the target to zero. The user confirmed
normal loading, stopping and agreement with the printer screen. Right Tool 0
remained unloaded and idle throughout.

The user then separately authorized one left Extrude 10 mm and one Retract 10 mm.
Each action waited for actual left-nozzle temperature to reach 245 C and passed
the dynamically reported material prerequisite (minimum 220 C) before dispatch.
Each was dispatched once and the left target was restored to zero afterward;
other heater targets stayed zero. The user confirmed normal extrusion and
retraction and stopping. Exact quantity/distance and automatic completion of
these manual actions remain unqualified.

Next, the user authorized one left-side switch from blue Slot 1 to black PETG
in physical slot 3 (UI Slot 2). Requested and actual paths initially differed,
then matched the black slot while activity remained loading. Firmware first
targeted 225 C, then 245 C. Fresh black loaded path and idle activity completed
the operation; all targets returned to zero. The user confirmed normal physical
switching, stopping and screen agreement. Finally, one separately authorized
Unload returned black PETG to that third slot. Requested path cleared before
actual loaded path; activity showed unloading. A 245 C firmware target was
observed. Null requested/loaded paths plus idle completed the operation, with
all heater targets restored to zero. The user confirmed normal return, stopping
and screen agreement. Neither workflow was retried.

Timestamped local evidence is in `.vitest/lan-acceptance/left-ams-load.json`,
`left-extrude-10.json`, `left-retract-10.json`, `left-ams-switch.json` and
`left-ams-unload.json`. Final fresh observations showed both tools unloaded and
idle, all heater targets zero and no alerts. This qualifies the independently
addressed left-side material workflow and completion feedback on this H2D over
LAN. External holders and real print-task controls remain separate acceptance
items; no such operation was performed in this group.

### Independent LAN nozzle refresh and remaining scope

On 2026-10-24, the user cleared the motion region and authorized one nozzle
identification refresh. The Monitor sent it once and the printer acknowledged it.
Fresh reports retained left/right 0.4 mm hardened-steel standard-flow HS01 nozzles,
idle status, zero heater targets and no alerts. The user confirmed identification
finished normally, stopped and matched the screen. The UI later reported an unknown
outcome at its completion timeout; unchanged nozzle data and an ACK are not a
reliable refresh-completion predicate. This qualifies the physically confirmed
single refresh, while automatic completion remains unqualified. Evidence is in
`.vitest/lan-acceptance/nozzle-refresh.json`.

The user explicitly skipped physical external-holder 254/255 acceptance in this
LAN round. Its earlier mapping/software checks do not establish physical feeding
qualification. Idle read-only evaluations correctly blocked pause, resume, cancel
and print-speed changes without dispatching commands; evidence is in
`idle-print-guards.json`. Real-task control acceptance is recorded separately.

The externally started Cube task exposed stage 74 as a numeric fallback. The pinned
and upstream Orca stage tables did not map it; the official
[Bambu Studio stage table](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.cpp)
defines it as Heatbed surface foreign object detection. The provider now supplies
that label, preserving the numeric code and the unknown-stage fallback. Desktop
tests (268 passed), desktop typecheck and the production build passed. A production
restart reconnected read-only to the same task; its stage had already advanced,
so the stage-74 projection itself is covered by the telemetry regression fixture,
not a repeated physical detection action. Evidence remains in `print-controls.json`.

### Independent LAN real-task controls and round completion

On 2026-10-24, the user started Cube externally and separately authorized each
control. The same device task ID was checked before every action. Pause was sent
once after formal layer printing began; fresh paused state completed the operation,
and the user confirmed the printer stopped and its screen agreed. Resume was then
authorized and sent once; fresh printing state completed it, and the user confirmed
normal continuation and screen agreement.

Silent, Sport and Ludicrous were each separately authorized from Standard. Each
mode was sent once, confirmed by a fresh same-task speed report, held for at least
ten seconds, then restored to Standard once and confirmed by fresh telemetry.
The Silent hold was approximately 22.7 seconds including tool scheduling; Sport
and Ludicrous holds were approximately 10.0 seconds after their observed reports.
The user confirmed each physical speed change, restoration and screen agreement.
The task continued printing without alerts during these checks. No heater command
was sent during the speed tests.

Finally, the user authorized cancelling Cube once. The normal confirmation dialog
identified the printer and task, and the same live task was rechecked before
confirmation. The stop operation completed from observed terminal state. Firmware
initially retained the print heater targets during its finish sequence, then
restored both nozzle, bed and chamber targets to zero. The user confirmed cancelled
status on the printer screen, physical stopping and no other abnormal prompt.
No stop retry, manual cooldown or additional motion/material command was issued.
Timestamped evidence for this group is in `.vitest/lan-acceptance/print-controls.json`.

This exposed a presentation issue: firmware reports FAILED with print error
0300400C for cancellation. Orca's checked-in
[HMS resource](../packages/slicer-wasm/cpp/resources/hms/hms_en_094.json)
defines that code as The task was canceled. The provider now maps that explicit
combination to cancelled/ready, retains the cancellation code as an informational
message, and preserves failure/error handling for other failure reports. Cancellation
completion and inactive-task/recovery guards include the cancelled phase, retaining
same-task checks. Fixtures cover unrelated tasks, real errors, missing error reasons
and an active task carrying the cancellation code; the code alone does not terminate
an active task. This does not introduce an HMS tab.

A normal production restart then reconnected read-only with the same LAN profile:
all heater targets were zero, both material activities were idle and no alerts
were reported. Firmware had already cleared the cancellation code and retained
only FAILED for Cube, so the new process still projected failed/error. The agent
does not infer cancellation from its preceding stop request or persist outcomes
across utility restarts. The explicit-code mapping is covered by regression
fixtures; a second physical cancellation was not performed to demonstrate it.
This round therefore qualifies physical cancellation and its zero-target finish,
not recovery of a cleared cancellation reason after restart.

The agreed development-host H2D + AMS LAN round is complete: read-only dynamic
hardware, lights, authorized heater sequences, motion steps, tool selection,
both AMS load/switch/unload and manual extrusion/retraction workflows, nozzle
identification refresh, and real-task pause/resume/speed/cancel have the specific
physical evidence recorded above. External-holder feeding was explicitly skipped.
Manual Heat fan 30-percent execution remains physically unconfirmed; its automatic
run/stop during chamber heating was confirmed. Exact manual travel/extrusion
distance, automatic completion of commands lacking a terminal predicate, fault
recovery, forced transport loss, cross-instance live account invalidation, other
models/hosts and the full release matrix remain unqualified. Moonraker's existing
function scope is unchanged.

Final checks passed: `pnpm test` (2,557 passed, four existing conditional skips),
`pnpm typecheck`, `pnpm --filter @orca/platform-contract test:import-guard`, the
mock E2E build, renderer CSS smoke and seven Electron cases across
`bambu-control.e2e.ts`, `bambu-provider.e2e.ts`, `bambu-account.e2e.ts` and
`printer-control.e2e.ts`. The normal production build was restored and passed
the read-only reconnect above. No C++/bridge/runtime artifact changed, so a new
dual-WASM build, full Web/packaged release matrix and additional physical commands
were intentionally not run for these provider fixes.

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
