# Printer Console and Control Integration

**Updated:** 2026-11-07

**Status:** Console/Send, Moonraker Monitor and the Electron Bambu control
implementation are delivered. Bambu protocol fixtures and desktop interaction
regression cover software behavior. Physical qualification is limited to the
development-host H2D cases recorded below; no complete hardware or six-target
control qualification is claimed.
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
mapping/rebuild dialog when project use or edited Filament presets require
review, and directly rebuilds clean empty plates following Orca. Each accepted project operation applies atomically in
native code. The shared workflow, normalized Bambu observations and native
transactions are implemented. Development-host H2D + AMS read/import/history
acceptance passed; mixed physical nozzles and post-sync printing remain
unqualified, as recorded below.

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
printer. A paused Device monitor or missing/stale material cache must not open
the chooser or substitute the first saved printer; the acquisition rules below
determine whether a device read is needed. Preserve the connected route when
available. If no device is selected, or its agent does not support the required
sync observations, open a device chooser. Choosing a device
connects it and makes it Device's current printer before starting the selected
sync workflow. Failure to connect/read does not apply project changes.
For a source whose required observation topics support push/poll delivery, use
its fresh, coherent cached snapshot directly, as Orca uses its connected
device state. Do not require a post-click telemetry message before showing a
model-mismatch confirmation or applying the local synchronization. Missing,
stale, incomplete or inconsistent required observations fall back to one
explicit device read. On-demand-only sources still fetch on each sync. The
Filament dialog's explicit Refresh always requests device data, preserves the
mapping draft and never treats a failed refresh as a successful cached read.
Both read paths retain the same source/configuration and project revision
validation before native application.
Canceling a necessary Printer confirmation or the Filament dialog leaves the
selected device connected and current in Device; it cancels only the pending
project mutation. Selection in Device alone must not be treated as permission
to rewrite Prepare configuration.
The Printer model-switch confirmation also offers **Choose another printer**.
It returns to the supported-device chooser with another device selected when
available, discards the pending source and releases its temporary observation
lease. The current Device selection and project stay unchanged until the user
chooses **Connect and sync**. The original Printer/Filament workflow then runs
against that device; any necessary model-switch confirmation still applies.
Changing the selected/connected printer in Device never automatically changes
Prepare's Printer preset or materials. A subsequent manual sync invocation uses
the latest connected printer rather than retaining the previous sync source.
Capture the chosen source for each in-flight workflow. The Filament mapping
dialog and any necessary Printer confirmation/configuration dialog are modal:
the main application, including Device selection, cannot be operated behind
them. Printer sync does not open a modal for an ordinary successful update.
Do not silently retarget an in-flight operation if its source changes.

A synchronization modal locks project interaction while retaining the Device
monitor and its existing connection. For streaming-capable sources, retain one
source-scoped material observation across reads and review; refreshing the
proposal updates its validation basis without replacing that subscription.
Snapmaker material inventory revisions track material metadata and load state,
including the raw type/series used for preset matching. Unrelated temperature,
print-progress, preference and observation-time updates do not invalidate an
open mapping review. Actual material changes still require an explicit refresh.
An explicit chooser selection activates the Device observation owner even when
its page is hidden, so canceling the proposal does not undo the connection.
On-demand-only sources still perform no background read or subscription. The
print-preparation modal's independent need to pause Device observations does
not apply to synchronization.

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

For Filament sync, prepare a native-validated material proposal. With every
Plate empty and no modified active Filament, import directly after Sync unless
referenced material removal requires an explicit replacement. Otherwise show
the source device and configuration changes in the modal mapping/rebuild
dialog, allow mapping and replacement choices, and apply on confirmation.
Canceling that dialog does not apply its pending project changes.

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

Follow Orca's `SyncAmsInfoDialog::is_need_show` and `check_empty_project`:
when every Plate has no object instances and no active Filament preset has
unsaved edits, the explicit Sync action directly rebuilds the rack without
mounting a detail/confirmation dialog. Configured rack entries, slice status
and the currently selected Plate do not establish project use. Reuse native
Plate membership and existing Filament draft/baseline dirty detection; Neo's
simultaneous active preset drafts receive the protection of Orca's edited tab.
An object on any Plate or a modified active Filament retains the modal, defaulting
to mapping. Users can choose rebuild there. An empty project that needs explicit
reference replacement still shows rebuild review under the reference rules
below. No eligible source or a rejected direct operation shows an error without
importing; fallback warnings after a successful direct sync use the existing
workspace notifications. Both paths share the same source/revision validation,
atomic native application, preference publication and one-entry Undo. Reading
and direct application do not briefly mount the details dialog. Development
StrictMode replay must not duplicate the automatic commit.

Color-only updates remain available in the review dialog in either mode, but only update
existing slots: never change presets, slot count, logical identities or
references. Rebuild colors follow the eligible source order up to the existing
rack size; excess sources are ignored and remaining project colors stay as-is.
Mapping colors honor the explicit mapping and Keep unchanged choices; do not
apply Orca's implicit index fallback over those explicit choices. Disable
append and omit removal/reassignment proposals while Colors only is enabled.

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
eligible device-material list under its separate replacement semantics. Native
preparation and application share one read-only append planner; the UI displays
its ordered source list and re-queries it after mapping changes. A per-slot
previous-preset fallback alone does not establish material equivalence.
Superseded plan responses cannot enable confirmation for a newer mapping.

Selecting an installed device material may admit its compatible hidden Filament
preset to the ordinary catalogue. If selection fails, restore that visibility
change together with the native project and history; preset configurations
remain immutable and admission does not require copying the preset catalogue.

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

Follow Orca's empty-filament-ID gate before native preset fallback. A source
requires usable metadata, a usable tool path and at least one non-empty
provider-normalized catalogue identity. A type, color, diameter or retained
transparent color alone does not establish eligibility. Unidentified supplies
remain visible with their reported metadata and presence, but are excluded
from rebuild, mapping choices and unused-material append. A submitted mapping
to an unidentified source leaves the destination unchanged; no eligible
sources disables confirmation and native application rejects without mutation.
Reported identities that are unknown to the native catalogue remain eligible
for the full fallback below. Apply this rule to every supply kind and provider,
not only external holders or Bambu IDs.

Sources with an identity may participate even when explicitly empty or with
unknown presence. Retain namespaced provenance and never fabricate physical
presence from metadata. Importing retained metadata is a project configuration
operation, not a claim that the spool is installed or can supply a print; Send
retains its independent inventory/path validation.

Like Orca's shared `filament_ams_list`, Filament sync and installed-material
dropdowns share the normalized source/provenance conversion and native source
eligibility and matching foundation. Do not introduce a separate provider
parser, catalogue matcher or network subscription for the dropdown. Their final
match policies differ intentionally: the dropdown accepts exact native bases
or same-type Generic presets, while full synchronization uses the complete
fallback below. Source eligibility is native-authoritative for preview and
apply; the typed client accepts its ordered subset without implementing a
second eligibility policy.

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
Auto For Match is owned by the separate accepted Convenience extension below,
not by project-material import. Dynamic switcher-based slicing, hotend racks
and multi-nozzle inventory selection remain outside this delivery; their
presence in Orca is not authorization to enable them here.

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
model, transport or host. Hotend racks, dynamic switcher-based mapping and
physical sub-nozzle inventory selection remain deferred under the scope
exclusions above.

The separate [accepted Convenience Mode extension](Multi-Filament%20Support.md#147-convenience-mode-extension)
uses a current device-material session list for native slicing without requiring
project Filament import. It preserves automatic input/result separation and
unavailable saved modes, uses selection/model-based eligibility without an
online gate, and adds no slice-time hardware-sync prompt. Printer/Filament Sync
remain explicit existing workflows. Same-source cache reuse, existing-only pull
acquisition, failed-pull candidate withdrawal and native candidate/fallback
behavior are defined by that topic owner. Its initial fixed-dual coverage
includes native-supported mixed diameters and flows. The extension is
implemented with real-WASM and Electron/Web software acceptance, plus LAN-only
H2D device reads, grouping and local slicing/export without submission. Physical
printing remains unqualified. Its topic owner records the evidence and limits.

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

### Development-host H2D synchronization acceptance

On 2026-10-31, after staged software verification, the macOS ARM64 Electron
development build used the existing account-backed Bambu connection to a real
H2D. Its reported hardware was two 0.4 mm Standard-flow nozzles, AMS 0 and
AMS 2 Pro 1 with four present slots each, and two external holders with unknown
presence and retained transparent-color metadata. No fixture provider was
installed for this round.

Direct Printer sync succeeded without a generic preview and exposed the
independent Filament continuation. The ordered tool configuration remained
0.4 mm Standard / 0.4 mm Standard, with five reachable material slots per tool
(four AMS slots plus its external holder). The run established source reading
and project/history transactions, but does not qualify Orca-equivalent source
eligibility: its ten-record rebuild included eight AMS materials with their
PETG-CF/PETG/PC presets and colors and two unknown external-holder records with
Generic ABS fallback. Unidentified external records must now be displayed but
excluded under the eligibility rule above. The corrected filtering, colors-only rack preservation and clean-empty
direct-sync path require a final hardware acceptance rerun;
software fixtures and WASM tests do not establish that hardware qualification.

The first hardware attempt exposed an observation-ownership defect: entering
the synchronization modal released the hidden Device monitor, and refreshing a
proposal replaced its sole source subscription. The corrected workflow retains
the existing monitor and one source-scoped observation across review/refresh.
After repository tests, typechecks and the Electron fixture journey passed
again, the hardware rerun kept Apply enabled after refresh. Rebuild applied as
one Sync Filament history entry; Undo restored the original five-material rack,
and Redo restored all ten imported records. A separate mapping run assigned two
distinct existing project materials to the same physical AMS slot, with append
disabled: both received the reviewed color, all three unmapped materials stayed
unchanged, and Undo restored both original colors. Printer and Filament Undo
entries remained independent. Canceling a later proposal left the project
unchanged and Device still reported Live. The local test project was restored
to its original clean state.

This round qualifies connected-device reads and local project synchronization
on that development host. It issued no heating, motion, loading, upload or print
commands. Different physical nozzle diameters/flows, actual empty AMS slots,
external-holder feeding, slicing/sending after sync, other models/transports,
and the packaged/Web release matrix remain unqualified. Software fixtures and
both native WASM variants cover mixed-diameter transitions, atomic failures,
reference remapping and persistence; they do not replace those physical checks.

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

Add and Edit use a shared agent-defined configuration form. Adapter choices
come from the locally reported printer types with supported manual
configuration. Each agent supplies its connection fields and optional model
selection support. The selected agent owns validation and persistence, including
explicit reads of editable credentials. Failed saves retain the entered values
and show a generic error. Loading the type catalogue or editing a connection
does not contact the printer. Bambu uses its existing discovery/account flows
and reports manual configuration unsupported.

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

### Optional model for manually configured printers

The manual Add/Edit printer form includes a searchable, optional **Printer
model** selector. It starts at **Not specified** and can be cleared. Its choices
come only from already loaded, enabled **system Printer profiles**, grouped by
resource vendor and `printer_model`, without separate nozzle variants. User
profiles, project-embedded profiles and frozen project copies are excluded;
there is no vendor inference or fallback to local profiles. Opening or using
this selector neither opens Setup nor downloads or enables additional vendors.
Selecting a model does not switch the project's Printer.

Persist the vendor/model reference with the physical device's local configuration
in both hosts. The association survives restart and project/preset changes;
editing or clearing it is explicit. Existing entries without an association
remain unrestricted when the provider also has no known model. Saved-device
enumeration exposes this user-configured association separately from the
provider's reported identity.

Send and Send & Print first retain their existing route/capability eligibility,
then filter devices through the existing native Printer/device match query.
Use the configured association when present, otherwise the provider's reported
identity, including exact `orca-printer-model` references. Devices with neither
a model nor an exact catalogue reference pass without a native query.
Match the model rather than the preset's display name or nozzle variant.
A selected device excluded by the filter is cleared without choosing a
replacement. Device's own saved list remains complete.

Matching belongs to the open send modal, where the project Printer is fixed.
Reuse each device's pending or completed query while its effective manufacturer,
model and exact catalogue references are unchanged. Repeated catalogue
notifications, reordering, renaming and changes to other devices must not recreate
the current print preparation or discard its manual slot mappings, options or
job name. Checking another device must not interrupt the current matched device.
Actual model changes invalidate that device's match; removing a device clears
its selection, and late replies cannot restore an obsolete result. Closing the
modal ends the matching session. Existing status/material validation continues:
an unavailable chosen slot stays selected and blocks printing, rather than being
replaced by an automatic suggestion. No project-change handling inside the modal
is required.

Bambu's agent resolves its bundled model catalogue locally and exposes the exact
model reference in the saved-device catalogue as well as live descriptors. This
does not require device probes, profile downloads or renderer-side Bambu model
translation. Bambu print validation and existing Printer/Filament synchronization
decisions are unchanged. This feature does not add Moonraker synchronization
capabilities, submission-time rechecks, a new
configuration revision policy, or model-catalogue invalidation handling.

Acceptance covers saving, reopening, editing and clearing the association in both
host repositories; enabled-only choices without vendor requests; empty/model
match/mismatch send filtering for configured and provider-reported models,
including U1 rejecting H2D and H2D accepting its exact catalogue reference;
unchanged Bambu synchronization; and preservation
of existing device and print preferences. The shared selector supports keyboard
and pointer input and uses a bounded, scrollable popup. Mobile product support
remains deferred; this control uses the existing responsive form and introduces
no additional profile downloads or native catalogue allocation.

### Device Storage design

**Decision status:** A shared, capability-driven Storage feature with Bambu as
its first agent is selected for initial Electron delivery. The host-owned download
boundary and feature behavior below are selected; detailed contract implementation
and qualification proceed in independently verified increments. Implementation
is authorized. The initial shared Storage browser is implemented with explicit
capability resolution, collection/storage switching, loaded-file filtering and date
grouping, manual refresh, snapshot pagination and scoped selection. Shared UI tests
and Electron renderer/preload/main fixture E2E pass. Desktop host-owned download
tasks, default-folder/Save As selection, progress, cancellation/retry, completion
notices and saved-file opening are integrated. Fixture E2E covers task persistence
across navigation and cancellation; separate utility tests verify actual saving.
Confirmed single/batch deletion now distinguishes confirmed, failed, unconfirmed
and unexecuted entries, with explicit continuation of a paused batch. Fixture E2E
checks local removal after confirmation and retained entries without automatic
refresh after uncertain outcomes. Visible-card thumbnails now use optional managed
image resources with cancellation and bounded concurrency; unsupported image reads
retain placeholders. A shared frontend cache retains independent thumbnail
snapshots and missing-preview results across scrolling, filtering and regrouping.
Provider leases close after copying, and cache hits issue no new agent read.
Refresh or browsing-scope changes clear this session cache; inactive entries may
be evicted to meet its entry/byte retention targets; pinned images may exceed
these targets without rejection. Storage thumbnails add no per-image size or
decoded-dimension limit. Bambu thumbnail requests are batched on short-lived reusable
browser connections, so one missing resource does not discard successfully read
images in the batch. The [thumbnail transport and measured acceptance](Printer%20Domain%20and%20Control%20Architecture.md#91-device-storage-and-host-owned-downloads)
owns connection/resource limits and the H2D timing evidence. Device-file printing now has an independent inspection dialog,
agent-provided target selection and plate thumbnails, shared material/options UI,
warning confirmation and one-shot start dispatch. It does not read/export the
current slice or lock/modify the Project. Fixture E2E selects a second plate and
observes a provider submission receipt; component tests cover late inspection
cleanup and uncertain-start duplicate prevention. Stored video now has an explicit
single-selection Play action, progressive embedded playback, a cached-range seek
control and an explicit managed-download/system-player alternative. Closing the
viewer or leaving Storage releases its lease and temporary cache. Generated AVC
acceptance exercises real Electron decoding, seeking and utility cleanup; component
tests cover unsupported-format fallback and cancellation of late opens.
LAN authorization recovery now reuses scoped discovery and masked access input
for the existing physical printer. Component and Electron fixture acceptance cover
identity filtering and the successful return to Storage. Read-only H2D + AMS
acceptance now covers USB listing, sampled thumbnails, managed downloads including
a 240 MiB recording, cancellation cleanup, and downloaded-video playback/seeking
in QuickTime. Real timelapse/recording samples have a tail-positioned MP4 index,
so they show the explicit download alternative; embedded progressive playback
is not physically qualified. Advertised internal storage returns unavailable on
the tested firmware. Deletion and actual printing were excluded by the user.
The [physical qualification boundary](Printer%20Domain%20and%20Control%20Architecture.md#initial-qualification-boundary)
records the device/firmware and exact limits; the complete initial delivery is
not yet qualified.

The [printer-domain Storage design](Printer%20Domain%20and%20Control%20Architecture.md#91-device-storage-and-host-owned-downloads)
owns provider contracts, binary transport, host save ownership, the pinned Bambu
execution boundary, contract implementation boundaries and qualification gates.
Shared UI uses those capabilities for every provider. Storage selects its own eligible printer route; it must not
inherit a Monitor route merely because that route is currently selected.

The initial implementation target is Electron. The shared contract separates
provider reads, task orchestration and host saving so a future Web host can use
browser-direct agents or a native-agent gateway without a second Storage UI.
Default directories, save dialogs, filename collisions, external-player launch,
temporary disk cache and last-window shutdown below describe the selected desktop
experience; Web exposes its actual capabilities rather than claiming parity.
Distinguish a verified managed save from handing a download to the browser. A
gateway-side transfer completion does not establish local saving. Browser save
adapters and the native-agent gateway are not part of this first delivery.

The interaction reference is Orca's
[MediaFilePanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/MediaFilePanel.cpp):
storage selection, Timelapse/Video/Model collections where available, date
grouping, thumbnail browsing, refresh and selected-file download/deletion. Orca
retrieves model metadata before opening device-file print preparation. Its video
action downloads the file and opens the saved file with the system application.
Neo's initial delivery includes browsing/thumbnails, file download and deletion,
and printing existing device files. Implementation can proceed in independently
verified pieces, but completion of this delivery includes physical device-file
printing acceptance rather than deferring that feature to a later delivery.

Stored recordings and timelapses have both an in-app player and an action to
download and open the completed local file with the system application. A
standalone download action remains available. The in-app player supports
playback while downloading for qualified media; full-file download is not the
default prerequisite for starting playback. If progressive playback is not
supported for the media, explain the limitation and offer download followed by
opening with the system application. Do not fall back to full-file buffering for
another in-app playback attempt. The same external-player action is available
when the in-app decoder cannot handle the media. Exact format/codec qualification
remains to be specified; support is not inferred from an extension alone.

In-app playback uses host-owned temporary disk cache. Closing the player,
leaving Storage or switching printers stops playback, cancels outstanding media
reads and cleans the cache. No floating player or persistent reusable playback
cache is included in this delivery. Explicitly saved downloads are not cache
entries and must not be deleted by playback cleanup. Independent download tasks
and an already-open system player are unaffected by leaving Storage. The printer-domain specification records the implemented cache limits and
crash/cleanup-error behavior; physical format and resource-limit qualification
remain open.

Seeking follows the effective capabilities of the reader and the media:

- When range/random access and media indexing permit it, allow seeking to any
  position in the known timeline. A target without available media data enters
  a visible buffering state while the required data is acquired.
- When that access is unavailable, permit seeking only within downloaded,
  playable ranges and communicate the available range in the timeline. Do not
  accept an arbitrary undownloaded target and wait for sequential downloading
  to catch up.

This is one capability-adaptive player. Read support alone does not prove that
a container can seek or decode at a requested timestamp. Downloaded byte ranges
and playable time ranges are distinct; the UI uses actual media seekability.

Opening Storage may reuse existing authorized LAN access information for the
same physical printer, including a cloud-paired printer. A separately configured
LAN connection is not a prerequisite. Missing address or credentials prompts
the user to supply them; cloud account binding alone does not establish file
access. The initial pinned Bambu implementation requires LAN reachability.

The initial delivery supports both removable SD storage and internal printer
storage where the device supports them. Each storage advertises its own content
kinds and actions. Bambu follows the capability-gated External/Internal browsing
of [Bambu Studio master 79df7ae](https://github.com/bambulab/BambuStudio/blob/79df7ae309be398ed30c9f397c13c9911c2edc57/src/slic3r/GUI/MediaFilePanel.cpp#L475-L488):
External is the initial choice and provides print files, timelapses and recordings.
Internal print files require reported `fun2` bit 17; internal timelapses require
`fun` bit 28. Internal recordings are not offered. Discovery identifiers such as
`emmc` do not establish those browsing capabilities. These restrictions belong to
the Bambu agent and do not constrain other agents.

The shared browser presents the union of agent-provided collections, retaining
collection selection while switching storage. It offers only storages supporting
the current collection and hides the storage selector when fewer than two choices
exist. Changing collection or refreshing capabilities falls back to the first
eligible storage when the current one no longer qualifies, resets the old scope's
selection and cancels obsolete reads. Bambu orders External first. Explicit Refresh
re-resolves storage capabilities before loading the collection; ordinary selection
does not poll the printer.

The shared browsing contract supports classification-based collections and
hierarchical directories according to provider capabilities. Bambu initially
uses collections. Folder navigation and breadcrumbs are implemented with the
first agent that needs directory browsing; this delivery does not require a
directory UI unsupported by the initial agent. Paths do not imply directory
navigation support or require flattening future directory-based providers.

The proposed shared page provides storage and file-kind selection,
a thumbnail/list surface and capability-driven actions.
It distinguishes unsupported capability, unknown capability, unavailable storage,
empty results and failed reads. Storage names and kinds come from the agent;
internal/removable storage and Bambu-specific category combinations are not
hard-coded for all providers. Layout, filters and grouping can be refined during
implementation within the selected browsing and selection behavior.

When Storage capability is unknown, explicit entry into the page allows the
agent to perform one bounded capability-resolution attempt as needed, followed
by listing supported storage/collections. Show failures with a manual retry
action rather than repeating probes in the background. Unknown, unsupported and
temporarily unavailable remain distinct; no separate initial Check Capability
button is required. This does not authorize probing during application startup
or passive printer enumeration.

Load the current list on Storage entry and when switching storage, collection
or directory. Provide manual refresh and update the list after file mutations.
Do not periodically poll while the page remains open. Changes made by the
printer or another client are discovered on re-entry or manual refresh.

Selection is scoped to the current printer, storage, collection or directory;
switching that scope clears it. Already-started download tasks have independent
lifetimes and continue when selection is cleared. The bulk selection action
selects only loaded items matching the current filters, including items outside
the viewport that require scrolling. It neither fetches additional pages nor
recursively selects other directories. Label the action and selected count so
that it does not imply selection of unloaded results. Selection is an explicit
set; loading another page does not automatically select newly loaded items.

Saving uses the injected host download service, exposing task progress and
results without exposing private destination paths or Bambu protocol payloads.
Ordinary downloads use an application-wide default download directory without a
destination prompt. Configure it under Preferences → Downloads; it is shared by
all printer agents and committed with the Preferences Save button. Choosing a
folder edits the dialog's draft; cancelling the chooser preserves that draft,
and cancelling Preferences leaves the saved location unchanged. Storage has no default-folder
configuration action. The setting displays the full current path, with the full
value available on hover when the text is truncated. The initial desktop location is the OS Downloads folder;
Web explains that browser facilities manage the location. A separate Save As action chooses a file destination for a
single item or one destination folder for a batch. Ordinary downloads preserve
existing files by adding a numeric suffix on name collisions. Save As requires
overwrite confirmation when the chosen destination already exists.

A batch records per-file success, failure and cancellation, with a summary and
an action to retry failed items. An isolated file failure does not block the
remaining items. A failure affecting the batch, such as a disconnected source
or an out-of-space destination, pauses the affected queue and prompts the user
to resolve the problem before continuing. Continuing a queue does not itself
promise byte-level resume for an interrupted file.

The initial delivery does not implement interrupted-download resume. Failed or
canceled downloads clean up their temporary output; retries start from the
beginning. This is independent of range reads used for media playback.

Downloads continue when leaving Storage or switching printers while the
application remains open. Task details, cancellation and retry live within
Storage, including access to tasks started for a previously selected printer;
do not introduce a global download task panel. Completion/failure notifications
inform users outside Storage, and file entries also reflect their task state.

Closing the last application window with unfinished downloads prompts the user
to return and wait or cancel the tasks and close. Explicit application quit uses
the same unfinished-task decision. Do not keep the application running without
a window solely to finish downloads. Confirmed cancellation cleans temporary
output before normal closure; cleanup failures must be reported rather than
presented as successful cleanup. The domain design defines owned temporary-file
cleanup; platform-specific crash recovery details remain implementation work.

The initial delivery runs explicit downloads sequentially per physical printer;
different printers can progress independently. Playback reads and downloads
share one transfer slot for that printer. Opening media while the slot is occupied
shows a waiting state. Use strict FIFO admission across queued downloads and
playback requests: playback waits for all previously queued downloads, not merely
the currently running file. Cancellation removes only the canceled request; it
does not promote playback past other earlier requests. Do not automatically
preempt an existing task. Leaving the playback context also removes its queued
request. Keep the playback slot until its remote reading ends or is canceled; a player
using only completed local cache does not require the remote transfer slot.
Future agent-specific concurrency remains an extension, not a first-delivery
capability negotiation requirement. A file-read cancellation does not cancel a
printer's physical print job. Playback's temporary cache and page-bound lifetime
are separate from these explicit download destination and lifetime decisions.

Single-file and batch deletion both require confirmation identifying the printer,
storage and file name or count; a batch has one confirmation with an expandable
file list. After confirmation, submit deletion without an additional client-side
in-use veto for downloading, playback or known printing activity. Let the printer
decide whether deletion is allowed. Do not automatically cancel downloads, stop
playback or cancel a physical print to enable deletion. Concurrent reads may
continue if the device permits them or fail with their actual read errors; show
those results independently. Ordinary capability, authorization and scoped-file
reference validation still apply.

Storage does not perform remote-file content version checking or expose a strict
versus best-effort choice. Download, delete, preview and print target the file
currently addressed on the device, including a replacement at the same path.
Do not add a version-conflict dialog or an extra metadata/hash check solely to
detect replacement. Device/route/configuration and authorization checks remain;
download completeness/integrity checks and ordinary missing-file/format errors
are separate from content version checking.

If a deletion request has an uncertain outcome, retain the entry and show that
the deletion result is unconfirmed. Do not automatically re-query or resend the
request; the user can manually refresh. A clearly confirmed deletion can update
the list normally. Manual refresh establishes current file presence, not proof
of which earlier request changed it.

Batch deletion continues after isolated, explicit per-file failures. Disconnection
or an uncertain outcome pauses remaining deletion work for user handling. Report
confirmed successes, explicit failures, unconfirmed outcomes and unexecuted items
separately; do not roll back successful deletions. Only report per-file certainty
that the provider's actual response supports. A batch-level response with ambiguous
item outcomes must not be converted into invented per-file success or failure.

Device-file printing and stored-media playback are independently gated features.
Remote viewing/inspection preserves the open project and retained slice result.
Remote printing needs its own source and plate selection,
then shared material mapping, options and current-device validation. A video
download does not establish playback compatibility, and a printable extension
alone does not establish that a file can be started.

The agent decides which formats and individual remote files it can print and
supplies normalized preparation information or an unavailable/unsupported reason.
Shared UI must not branch on provider brand or file extensions to determine
printability. The initial Bambu implementation supports sliced `.gcode.3mf`
printing; ordinary `.gcode` printing is deferred for that agent, without limiting
formats supported by other agents. Browsing, download and deletion remain
independently capability-driven for files that cannot be printed.

The initial workflow selects and prints one target at a time. Multi-plate files
offer a plate choice with the selected plate's thumbnail and preparation data;
agents without a plate concept supply a single print target. Multi-target or
consecutive-plate execution is outside this delivery. Show available material
requirements, estimated time and other preparation metadata without fabricating
missing values. The first delivery uses thumbnails and preparation information;
full G-code toolpath preview is deferred and is not a prerequisite for printing.

Bambu's preparation data comes from reuse of Orca C++ parsing through an isolated
runtime/Worker inspection service, followed by agent normalization. The inspection
does not replace the user's current project or slice result. This is a Bambu
implementation choice; other agents can supply the same normalized preparation
information through different parsers without depending on slicer WASM.

The first Storage physical acceptance target is H2D + AMS. Other Bambu models may
expose capabilities without being part of that acceptance matrix; distinguish
reported availability from actual device qualification. Transfers that continue
making effective progress have no total file deadline. Connection establishment
and loss of progress have separate timeouts, with values chosen through device
and slow-link qualification; cancellation remains available throughout.

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

The original Bambu control increment's accepted feature envelope is:

| Area | Accepted coverage |
| --- | --- |
| Current print | Name, phase, progress, remaining time, detailed stage and layer counts; pause, resume, cancel and speed selection. Display a current-task thumbnail when obtainable, otherwise a placeholder. The typed contract includes task previews, detailed observations and speed modes. Object skipping has a separately accepted [follow-up design](#object-skipping), not delivered behavior. |
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

#### Object skipping

**Decision status:** Design accepted; implementation authorized in independently
accepted and committed increments under the domain specification's sequence.

The first delivery targets Electron Bambu printers over both LAN and Cloud
remote access. Obtain objects from the printer's current task, including prints
started by another client; do not require the active Neo workspace to contain
the printed model. Availability follows device support and valid task-object
information rather than an H2D-only model allowlist. H2D is the first physical
acceptance target, with other models' qualification recorded separately.
The [domain specification](Printer%20Domain%20and%20Control%20Architecture.md#object-skipping-follow-up)
owns provider execution and access boundaries.

Place the Skip Objects entry alongside Monitor's current-print controls. Hide
it for a device that does not support skipping; for a supported device with an
inapplicable task or unavailable current conditions, keep it visible but disabled
and explain the reason. Normalized unknown support does not authorize commands.

Allow list-only selection when the object catalogue and current-task association
are reliable but the picking image is unavailable. Explain that the graphical
view is unavailable and preserve object names and reported skipped state in the
list. Duplicate names can be ambiguous without the image; the user may abandon
selection. Missing or untrusted object identities, task association or skipping
support must disable the operation rather than substitute workspace objects.

Open object selection in a modal dialog from Monitor. The dialog blocks
interaction with the underlying application without automatically pausing the
print, and continues receiving relevant printer state while open.
Present a top-down picking view with a synchronized multi-select object list;
the list remains usable in the accepted image-unavailable fallback. Already
skipped objects are marked and cannot be selected for restoration.

Allow skipping during ordinary running or paused prints, without requiring a
pause or automatically resuming afterward. Downloading, queued/cloud-slicing,
completed and system/calibration tasks do not enable skipping.

Every batch requires a second confirmation before dispatch. For a partial skip,
identify the printer, selected objects and their count, and explain that skipping
cannot be undone. Allow selecting all remaining objects, counting previously
skipped objects when determining whether any would remain. In that case,
explicitly confirm that the entire print will stop, then issue print cancellation
rather than an all-object skip command.

Close the selection dialog after the operation submission is recorded and show
subsequent operation feedback on Monitor. An immediately rejected submission
keeps the dialog open with the rejection reason. Closing the dialog does not
establish successful device execution. Follow Orca's consecutive-batch behavior:
the user may reopen selection and submit another batch without waiting for the
previous batch's device confirmation. A pending or uncertain earlier batch does
not by itself impose a global submission lock. Reported object state remains
device-derived. Existing unknown-outcome feedback and no-automatic-replay rules
still apply; pending-operation tracking must not introduce a forced confirmation
barrier between batches.

The displayed skipped-object count includes only device-reported skipped
objects. Monitor shows the count only when a known report contains at least one
skipped object; merely loading and closing selection must not add a zero/unknown
count beside the action. The selection dialog retains its zero-count statistics.
Do not optimistically increment it after submission. Pending, rejected
or uncertain operations use ordinary Monitor feedback independently of that
count, and do not block another batch merely because an earlier result is
pending or uncertain. This intentionally differs from Orca's temporary local
count prediction; a recorded submission or send acknowledgement is not evidence
that an object was skipped.

A change of current print task closes selection and any pending confirmation,
discards the selection, and explains that the task changed. Reopening obtains
the current task's object information. An old-task operation that has not yet
been dispatched must be rejected rather than retargeted.

Temporary disconnection or stale status retains the selection dialog and local
selection but disables submission and invalidates any pending confirmation.
Explain the unavailable state. Restore operation only after fresh information
establishes that the task is unchanged; the user must confirm again. A detected
task change follows the close-and-discard rule above.

When another client skips selected objects, mark them skipped and remove them
from the pending submission set, preserving the remaining selection. Update
the count and explain the change. Dismiss an open confirmation and require a
new confirmation. Concurrent object-state changes must not silently convert a
partial skip into cancellation of the entire print.

Orca's [reference dialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/PartSkipDialog.cpp)
loads picking and configuration resources as a group and shows a retry page
when acquisition fails. Its modal selection dialog confirms partial skipping or
stopping all objects, then closes after invoking the command without waiting for
reported object state. Neo retains this interaction shape while distinguishing
submission from successful execution. List-only operation is an intentional
Neo extension.

The shared Monitor implementation now includes this modal workflow, an on-demand
catalogue read, synchronized canvas picking/list selection and image-decoding
fallback. The modal keeps existing observations alive and tracks submitted
operations independently; it adds no pending-batch lock. Component checks cover
confirmation invalidation, stale recovery, external skipping, immediate rejection,
explicit stop intent and cancellation of undispatched evaluation on unmount.
The Electron fixture journey covers actual PNG decoding/pixel selection, modal
isolation, list fallback, count semantics and consecutive submissions. These
software checks do not establish physical-printer or remote-tunnel acceptance.

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

Material metadata is read-only in the original control increment. Its
material-preset, color and temperature-range exclusions have a separately scoped
[configuration design](#material-information-configuration) below; that design
is not delivered behavior. Direct K/N/calibration-result editing remains excluded;
do not import or modify project presets through device controls.
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

#### Material information configuration

**Delivery status:** Implemented in independently verified increments, using
Orca as the behavioral reference. The shared editor, native catalogue and Bambu
executor are delivered. Development-host H2D LAN acceptance is recorded below;
Cloud has software coverage only.
The [domain follow-up](Printer%20Domain%20and%20Control%20Architecture.md#material-information-configuration-follow-up)
owns execution, native query and command-contract boundaries.

The accepted feature scope is configuring the material identity, color and
associated nozzle-temperature range of AMS slots and external holders. Follow
Orca's existing information-setting workflow rather than designing alternative
material filtering, temperature overrides or material-version conflict dialogs.
Direct K/N editing, a calibration-result selector and calibration launch remain
separate follow-up work. Confirm/Reset retain Orca's automatic calibration
parameter/association updates even though those editing controls are absent.
Manual RFID re-read, drying control and AMS behavior settings are outside this
scope.

Use Orca's current
[AMSMaterialsSetting](../packages/slicer-wasm/cpp/src/slic3r/GUI/AMSMaterialsSetting.cpp)
and the AMS/external edit handlers in
[StatusPanel](../packages/slicer-wasm/cpp/src/slic3r/GUI/StatusPanel.cpp)
as the behavioral reference:

- AMS slots and external holders expose a per-slot action opening the same
  modal information dialog, populated from the selected physical slot. Preserve
  device/tool labels and identities, including in read-only presentations.
- Build compatible candidates for the connected machine through Orca's native
  preset rules, including its root-preset eligibility, firmware user-preset
  support check, filament-identity deduplication and alias display. Preserve
  the reference nozzle-information fallback and selection behavior.
- Preserve the reference order: materials used by the project are promoted,
  followed by vendor, material type and name ordering. The current Prepare
  picker is not a replacement for this device-oriented catalogue. Keep Orca's
  single ordered list; this device-material catalogue does not adopt the
  project/library preset selectors' section grouping.
- Selecting a material supplies its type, preset association and applicable
  temperature-range variant. The temperature range is displayed read-only;
  it is not a heater target or a free-form override. Color editing follows
  the reference picker behavior and slot restrictions.
- Following [Orca #16538](https://github.com/OrcaSlicer/OrcaSlicer/pull/16538)
  and [upstream main 06bccd5](https://github.com/OrcaSlicer/OrcaSlicer/tree/06bccd5570c979df6c5fd2d835519773c014fa76),
  allow alpha in every solid color. Offer 2–4 ordered gradient colors, each with
  independent alpha, only when the device reports manual-multicolor support.
  Reuse the shared color picker with a caller-specific four-color limit; project
  editing and saved favorites keep their seven-color contract. Preserve an
  existing partitioned or oversized group on Cancel or unchanged Confirm;
  show its first color as the fallback picker seed with a preservation notice.
  Material selection alone does not replace colors. Preview the full reported
  group and transparency in both the dialog and Monitor.
- Preserve the reference material checks before dispatch, including applicable
  device, slot and nozzle restrictions. Prohibitions block the operation;
  warnings are presented using the reference interaction. Vendor-rule
  evaluation belongs to the provider rather than shared React.
- Preserve RFID-derived material information as read-only and follow the
  reference's printing/resumable-task restrictions and firmware support flag.
  Non-FDM processing modes remain view-only.
- Retain the reference information-clear confirmation, metadata-clearing
  behavior and automatic calibration coupling. Confirm performs the applicable
  reference calibration write/selection; Reset also resets calibration
  parameters or their result association as required by the device/protocol.
  This is not a calibration measurement or an additional calibration editor.
- RFID-identified slots retain Confirm/Reset subject to the reference's device,
  task-state and data requirements. These actions skip material-information
  writes but still perform the applicable calibration operations. Explain this
  effect in the dialog and in Reset confirmation: they cannot clear RFID-derived
  material information. Read-only information does not imply that every action
  in the dialog is read-only.

Device configuration and project material synchronization remain separate.
Reading candidates and editing a physical slot do not select project presets,
rebuild the project rack or add a project Undo/Redo operation. Existing explicit
Prepare synchronization retains its own rules.

Catalogue candidates come from the system library and saved user library only,
and still have to satisfy Orca's native root-preset, device-compatibility and
firmware user-preset rules. This does not offer every saved user preset.
Project-embedded presets, unsaved edits and retained history snapshots are not
independent device-material candidates. Use saved definitions rather than
temporary effective project values; project-use promotion must not introduce
those temporary identities into the device catalogue.

The shared React presentation must use normalized capabilities, observations,
the slicer runtime and printer service. Initial Bambu execution uses the existing
Electron provider; this design adds no browser Bambu transport or gateway.
Snapmaker printers with a manually associated model reuse this same Material
information dialog and native device catalogue. The agent supplies physical-head
nozzle context and supports Confirm with solid RGBA colors. It translates the
selected material's vendor, type and canonical-name series to the U1 metadata
command, retaining color unless explicitly edited. This does not enable Reset
or Bambu calibration operations. Without an associated model, the existing
capability-driven direct metadata editor remains available without a catalogue.
Material system cards display the normalized material type for every agent.
For U1 SnapSpeed material, the card label is PLA HIGH SPEED. The material editor
shows the matched preset name, such as Snapmaker PLA SnapSpeed. Exact system
material-name matching resolves the library identity without consulting the active project's
compatibility flags. The dialog resolves that identity in the target device's
catalogue, so an unrelated Bambu project cannot preselect Generic PLA instead.
Mobile interaction remains deferred under the shared architecture. The native
query stays on the existing slicer Worker and returns bounded catalogue data;
this feature requires no additional renderer-side profile parser or background
polling loop.

Both existing Bambu LAN and Cloud command paths are in the functional scope.
The first physical acceptance target is H2D with AMS and independently addressed
external holders over LAN. Cloud receives software verification in this initial
round and remains explicitly unqualified on real hardware. Neither that
software coverage nor H2D LAN acceptance qualifies other devices or firmware.

After local validation and provider submission have succeeded, Confirm/Reset
close the dialog without waiting for printer acknowledgement or final state,
following Orca. A local validation or submission rejection keeps the dialog open
with its explanation. Closing does not mean the device confirmed the change.
The Monitor owns later failure, partial-result and unknown-outcome feedback;
dialog lifetime must not cancel a submitted physical operation or its tracking.

Retain Orca's ordered, independent dispatch of the applicable information write
and automatic calibration commands. Even if an earlier step returns an explicit
send failure, still attempt the later calibration step on the original target.
Do not add a preceding-step acknowledgement barrier or turn the workflow into
an atomic transaction. Record each step's result separately and explain partial
effects. A late failure cannot retract a command already dispatched. Never
automatically retry or roll back the sequence, and do not report whole-operation
success merely because one step succeeded or the transport returned success.

Opening the modal binds its printer, route, configuration and physical slot;
it cannot follow a later selection to a different target. If that context becomes
unusable before submission, invalidate the editor and require reopening it from
the current device. Once submitted, the existing target-bound operation rules
apply: switching printers or closing the dialog does not reassign, repeat or
cancel its commands. Late responses update only the original operation and
applicable device cache. Existing freshness, permission and configuration checks
remain in force, without adding a material-version conflict dialog.

Acceptance must cover native candidate/temperature parity, RFID and task-state
restrictions, AMS and independently addressed external holders, information
clear, automatic calibration effects including RFID-only actions, writeback
feedback, and absence of project mutation. Physical acceptance must retain and
restore the original material and calibration settings changed by the tests.
Cover ordered dispatch after an earlier send failure, partial results, missing
or late acknowledgements, dialog closure and target changes independently.
Software tests do not establish device write permission, firmware acceptance or
physical qualification. Follow the repository
[testing guidelines](../doc/testing_guidelines.md); keep LAN/Cloud and
device-specific acceptance limits explicit.

##### Material configuration verification and LAN acceptance

The implementation uses the shared
[material dialog](../packages/slicer-app/src/components/device/MaterialInformationDialog.tsx),
[native catalogue bridge](../packages/slicer-wasm/src/bridge_profiles.cpp), and
[Bambu configuration owner](../apps/desktop/src/utility/bambu/materialSettings.ts).
The editor queries with the device descriptor's normalized model associations,
not the saved printer's descriptive model alone. Each slot entry and dialog
retain the reported unit and tool labels, including the two external holders.

Software verification on 2026-11-02 passed repository `pnpm test` and
`pnpm typecheck`, the platform import guard, both WASM quick builds, comprehensive
threaded bridge smoke and the targeted native catalogue smoke on threaded and
serial variants. The catalogue smoke checks device identity/nozzle variants,
identity deduplication, saved-root eligibility, independence from the selected
project printer, and unchanged project/draft/history owners. Affected shared UI
checks and all three focused `bambu-control.e2e.ts` desktop journeys passed after
the LAN-discovered model-association and compact-slot-entry corrections, plus
the late-receipt/remounted-Monitor regression. Renderer
CSS smoke passed. One initial native camera fixture run timed out awaiting its
first sample; the isolated rerun and subsequent complete repository run passed.
No camera implementation was changed and the timeout has no established cause.
A later UI-suite run overlapped desktop bundling and three existing Preset Editor
cases reached their five-second deadline; the final standalone UI-suite run
passed all 1,579 tests without changing those tests or their timeouts. These
reruns do not establish a root cause for either transient failure. Existing
real-resource/performance test gates remain conditional skips.

Commands used for the round are below. `<variant>` was run separately as
`threaded` and `serial`; affected package checks were also run before each
implementation commit. After the final UI correction, the shared application
suite (1,579 tests), affected typechecks and focused Electron journeys passed
again; no native bridge source changed after its two-variant verification.

| Check | Command | Result |
| --- | --- | --- |
| Repository regression | `pnpm test` and `pnpm typecheck` | Passed; five existing conditional test skips |
| Shared host boundary | `pnpm --filter @orca/platform-contract test:import-guard` | Passed |
| WASM builds | `bash scripts/build.sh quick --variant <variant> -j 8` | Both passed |
| Comprehensive bridge | `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js packages/slicer-wasm/fixtures/cube.stl` | Passed |
| Native material catalogue | `node packages/slicer-wasm/harness/device-material-catalogue-smoke.mjs packages/slicer-wasm/out/<variant>/orca_slice.js` | Both passed |
| Final shared UI suite | `pnpm --filter @orca/slicer-app test` | 1,579 passed |
| Final affected types | `pnpm --filter @orca/slicer-app --filter @orca/desktop typecheck` | Passed |
| Desktop interaction | `pnpm --filter @orca/desktop exec playwright test e2e/bambu-control.e2e.ts` after `pnpm --filter @orca/desktop exec electron-vite build --mode e2e` | Three passed |
| Production build | `VITE_USE_MOCK=0 pnpm --filter @orca/desktop build` | Passed |
| Renderer styles | `pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs` | Passed |
| Documentation | `git diff --check` plus changed local-link/heading and command validation | Passed |

The production Electron build, with real WASM and the real pinned native plugin,
was exercised on the macOS ARM64 development host using the existing independent
LAN profile, a signed-out account and no E2E fixture handlers. A pass-through IPC
observer captured production request/operation receipts without replacing their
execution. H2D reported two 0.4 mm standard-flow nozzles, AMS 0 and AMS 2 Pro 1,
external holders 255/254, and calibration version 0. Its prior task was completed;
no print, load/unload, heating or motion operation was started by this round.

Seven user actions covered AMS slot 0:1 color configuration, information Reset
and restoration; independent holder 255 material/RGBA configuration and Reset;
and holder 254 material/RGBA configuration and restoration. Temperature ranges
came from Generic PETG (220–270 °C) and Generic PLA (190–240 °C), with no editable
temperature override. Confirm/Reset closed after provider submission. Every
operation eventually completed with independently recorded material-information
and calibration steps; direct device replies and newer matching status reports
were distinguished. Status can initially lag a successful setting reply, so
writeback assertions waited for a newer matching status. Clearing AMS metadata
preserved its reported physical presence.

The baseline and final read-only acquisition compared all ten reported slot
snapshots, including material/setting identities, RGBA, temperature bounds,
calibration index, RFID and color-representation fields. They matched exactly;
calibration version and nozzle snapshots were unchanged. The private single-color
representation flag normalized by a manual external-holder color write was also
restored from the baseline. Restoration does not expose arbitrary protocol
fields in the shared configuration contract.
Credentials are absent from the ignored local evidence under
`.vitest/material-settings/`.

All reported calibration indices were already Default (-1), and no RFID-tagged
spool was present. Retaining a non-default PA association, legacy K behavior and
RFID calibration-only actions have software coverage and remain unqualified on
physical hardware. Cloud was exercised through provider/IPC software fixtures;
no Cloud physical write was attempted. This round does not qualify other devices,
firmware, hosts, external filament feeding or a release matrix.

The alpha/gradient extension was verified against upstream main `06bccd5` and
Orca #16538 on 2026-11-02. Repository `pnpm test` and `pnpm typecheck` passed,
including 1,587 shared application tests and 449 desktop tests; five existing
conditional skips remain. The platform import guard, all four mock Electron
control journeys, both focused real-WASM material-configuration journeys, the
production desktop build and renderer CSS smoke passed. Coverage includes
firmware gating, full ordered RGBA protocol confirmation, repeated colors,
the caller-specific four-color limit, seven-color project/favorite retention,
and Cancel/unchanged Confirm preservation for unsupported groups. No native
bridge or core source changed, so this extension required no WASM rebuild.

Additional production-build H2D LAN acceptance used external holder 254, whose
firmware reported manual-multicolor support. Four UI submissions covered a
two-color gradient, a four-color gradient with a repeated stop and independent
`00`/`80`/`FE` alpha, a single color with `40` alpha, and restoration. Every
information/calibration step completed, and subsequent device status matched
the complete selected color group. An independent final read-only acquisition
matched all ten slots' baseline material, temperature, calibration, RFID and
raw color-representation fields exactly; nozzles and calibration version were
unchanged. Cloud, solid-only firmware and other physical supply paths retain
software coverage without new physical qualification.

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

## Application exit with unfinished sends

**Status:** Implemented with shared service tracking and artifact-preparation
leases. Windows Electron close-handshake acceptance passes; Web uses the
browser-limited behavior below. Apply this
policy to all sending flows, including the existing Moonraker Send / Send & Print
and Bambu submission paths, their manual retries, and the planned Snapmaker
agent. It does not extend any provider's supported hosts or protocols.

While a send is unfinished, closing the main desktop window or explicitly
quitting must offer returning to wait or stopping unfinished sending and exiting.
Use the shared Dialog surface with the return action initially focused. Keep
Tab navigation inside this confirmation, including when a send dialog remains
open underneath it. Escape returns to the application, matching the return action.
Coordinate this with project-save and managed-download close guards. Track
actual sends independently of the currently visible page or dialog, from their
active artifact preparation through upload, preparation commands, start dispatch
and pending completion/cancellation. An open but idle preparation dialog alone
is not an unfinished send. A printer already printing independently after the
send has settled does not keep this exit guard active.

If the user confirms exit, stop unfinished local sending through each provider's
cancellation/shutdown contract and prevent later unsent stages from running.
Preserve required native callback and worker lifetime safety during teardown.
This does not promise to recall commands already dispatched or stop a physical
print; print-stop remains a separate user action. Existing provider-specific
outcome, settings and remote-file cleanup rules remain applicable.

For Web, closing/reloading the tab or leaving the application uses best-effort
browser-native leave confirmation while sending is unfinished. Browser wording,
activation requirements and whether the event runs are outside application
control; do not promise custom prompt text or completion of asynchronous
cancellation during page teardown. See the
[beforeunload constraints](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event).

After application restart or page reload, do not automatically resume an
interrupted send, re-upload its file or reissue preparation/start commands.
The user initiates a new valid sending flow when needed. This application-exit
rule is distinct from each provider's ordinary send-dialog closure behavior.

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
modal. Changes are staged in Preferences and written to the existing global
`printer-config.json` field only on Save. Cancel discards unsaved changes. Printing
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
The shared [application-exit contract](#application-exit-with-unfinished-sends)
applies to this submission path as well as the existing Moonraker flow. The
existing Moonraker speed/countdown/retry behavior above is not automatically
the specification for a combined Bambu submission.

The shared UI remains host-neutral. Initial concrete execution uses the
existing Electron Bambu provider; a static Web gateway is not introduced by
this direction. Mobile support remains deferred under the shared application
policy. Artifact packaging stays off the renderer thread, and binary transport
must avoid unnecessary copies and keep temporary files host-private; exact
memory/size limits require the artifact feasibility check.

## Snapmaker agent design

**Status:** Implemented and software-qualified on Windows in Electron and Web.
The selected scope includes U1 independent project materials, preparation and
submission, Device metadata/individual material controls, persistent preferences,
consumer-owned monitoring and all-agent unfinished-send exit handling.
Non-printing real-U1 LAN acceptance and one completed single-head PLA print are
recorded below. Physical qualification covers that recorded case.
Protocol ownership, slicing semantics and evidence limits are maintained in
[the Snapmaker agent architecture](Printer%20Domain%20and%20Control%20Architecture.md#25-snapmaker-agent-design).

### Accepted Snapmaker delivery and connection

- Support Electron and static Web with shared agent logic. Web connects directly
  under browser CORS, mixed-content and local-network permission restrictions;
  this delivery does not add a gateway.
- Add `snapmaker` to the manual printer agent dropdown. Reuse the existing API
  base URL, optional API key and optional Console URL. Do not add automatic
  discovery in this delivery.
- Initially support and qualify U1. Other Snapmaker models are not included
  merely because the agent has a vendor-wide name.
- Keep model association optional. A connection can be saved and supported
  device information viewed before associating a U1 profile; enabling that
  profile is not a prerequisite for saving the connection. Model selection
  does not change the agent or the project's Printer. Missing association
  does not waive send-time protocol and slice-requirement validation.
  Follow the existing model-filter priority: use the configured association
  when present, otherwise the provider-reported model. Do not add a separate
  configured-versus-reported model conflict block. This priority does not
  replace observed toolhead, nozzle or material data.
- Deliver the SnapSend functional scope with the explicit top-cover deferral,
  individual-only loading/unloading and the accepted Neo behavior differences.
  Implementation may be incremental, but a basic sending workflow alone does
  not complete this scope.

The accepted functional scope includes automatic/manual filament mapping,
upload and upload-and-print, bed leveling, flow calibration for selected used
heads, timelapse, device filament brand/type/color editing, individual toolhead
loading and unloading with progress, device-page top-cover status and live fan control,
live printer status, and firmware-supported printer preferences. These include spaghetti,
foreign-object and air-printing detection with sensitivity, auto-refill and its
different-color allowance, and turning off lighting after printing. Feature
behavior, persistence and failure policy follow the accepted sections below.
Use Neo's shared UI and capability contracts; completing the selected scope
does not require copying plugin-specific installation or presentation. Automatic
top-cover mode selection and job-specific top-cover preparation are deferred
and are not completion requirements for this delivery.

Determine availability per function rather than imposing a minimum firmware
version on the whole connection. A confirmed unsupported optional feature
disables its corresponding entry without disabling unrelated supported
functions. Missing required submission capabilities, such as material mapping
for Send & Print, block that submission; upload-only retains its own requirements.
Unknown support remains unknown rather than being inferred solely from a
firmware version. Use the shared capability and parameter contracts to present
the choices supported by each function. A capability decision does not waive
the existing failure rules: an explicit preparation-command failure stops print
start, and device operations retain their error and manual-retry behavior.

### Accepted Snapmaker mapping and compatibility

U1 profiles gain offline independent project-filament editing and plate manual
mapping, retaining 64 project slots. Firmware logical-ID and metadata limits
are enforced at sending rather than imposing a 32-slot project limit. The
[project specification](Multi-Filament%20Support.md#148-u1-independent-project-filaments)
owns this U1-only extension and its unchanged automatic-mode boundary.

The plate mapping editor remains useful: it selects slicing tool parameters,
changes the generated G-code where those parameters differ, and requires
re-slicing. Seed the send dialog from that completed slice's tool assignments.
Keep this default even when another head has a closer material/color match;
the user explicitly invokes automatic matching or changes a head manually.
Each newly opened dialog starts from its slice's plate mapping; do not persist
temporary send bindings as defaults for the next dialog.
Device refresh preserves manual choices while updating compatibility and
availability diagnostics. A send-time change selects the physical head that
executes the existing G-code; it does not recalculate sliced paths.

Allow multiple project filaments to use one physical head. Explain that all
such regions print with that head's loaded filament. Differing temperatures
and other shared-heater conflicts require explicit confirmation. Retain the
original G-code, including logical temperature, retraction and tower actions;
do not imply that the slicer merged those project materials or removed redundant
tool changes.

Automatic material matching stays within supported material families. Manual
selection may cross families after the user confirms the difference; execution
continues with the project's original material settings. The agent owns material
normalization and classification rather than placing vendor rules in shared UI.

For hardware attributes, the accepted Snapmaker policy is:

| Condition | Sending behavior |
| --- | --- |
| Reported nozzle diameter differs from the slice | Explain the values and allow explicit acknowledgement to continue. |
| Reported flow type conflicts with the slice | Explain the conflict and allow explicit acknowledgement to continue. |
| Known nozzle hardness is below the material requirement | Explain the deficiency and allow explicit acknowledgement to continue. |
| Nozzle diameter, flow type or hardness is unreported/unverifiable | Preserve the unknown value, explain which check cannot be performed and allow explicit acknowledgement to continue. |

These confirmations do not modify the retained slice, substitute a new material
profile or turn unknown attributes into observed values. A user who wants the
toolpaths/parameters adapted changes the project or plate and re-slices. This
Snapmaker policy intentionally differs from the Bambu flow-type/hardness blocking
rules; those rules remain unchanged. The decisions above do not waive protocol
address validity, receipt freshness or operation-outcome handling.

The shared preparation view consumes agent-provided candidates and calibration
addresses. `snapmaker/preparation.ts` reads actual extruder diameter/flow fields,
keeps unreported hardness unknown, and checks command availability separately.
The retained-slice manifest supplies nozzle and first-layer nozzle temperatures;
shared-heater diagnostics do not inspect the exported G-code. Remote-file
inspection may report these temperatures as unknown (`null`). Preparation is read-only. The agent advertises a plain-G-code submission format;
the shared view exports the retained slice directly and transfers only that artifact.

### Accepted Snapmaker print options and material readiness

Remember bed leveling, flow calibration and timelapse choices in Neo per
physical printer, rather than per model or project. These are defaults for a
submission; changing a local choice does not immediately change the device.
Apply the selected options as part of Send & Print, with the unchanged-G-code
policy below. Treat successful command responses as the application result for
submission mapping, used heads, bed leveling, flow calibration/head selection
and timelapse. Do not add a field-by-field device readback comparison before
starting. An explicit preparation-command failure stops automatic print start;
the submission failure and retry rules below apply.

Persistent device preferences, including detection, auto-refill and lighting,
have an independent Save action. Read their current values from the device,
write only changed fields and read back to verify the saved result. Canceling
the send dialog does not undo device preferences already saved. Preserve
unsaved edits during refresh while reporting changed availability.

Send (upload only) transfers the file without applying the current submission's
tool mapping, bed leveling, flow calibration or timelapse choices, and without
starting a print. It does not require loading filament first. An independent
device-preference Save retains its own effect, including its readback rule.

This delivery accepts only a current valid Neo slice result for submission.
Defer starting a file already stored on the printer and history-based reprint
entry points. Repeating a print may re-send the current valid slice through the
normal preparation flow. Upload-only does not create a later-start/reprint
workflow in Neo or persist a prepared remote-file binding for such a workflow.

When flow calibration is enabled, default its head selection to every physical
head used by the current send mapping. Allow the user to deselect individual
heads. List only used heads and deduplicate many logical filaments assigned to
one physical head. Do not remember this head subset across dialogs. Within a
dialog, a mapping edit preserves selections for heads that remain in use,
removes unused heads and selects newly used heads by default. This is separate
from the remembered flow-calibration on/off choice.

Allow a head explicitly reported as having inserted but not yet loaded filament
to be selected for Send & Print. Explain that the U1 print-start workflow will
load it automatically; do not require a separate completed manual load before
submission. Manual loading remains available. Distinguish this observed state
from empty, unknown or stale data; those states are not evidence that filament
is inserted. Qualification must verify the selected firmware and supported
startup G-code actually perform the automatic loading.

### Accepted Snapmaker submission order and failure behavior

`U1Submissions` owns the host-lifetime operation, independently of its observers.
Repeated request IDs with the same parameters resolve to the same operation;
altered parameters reject. A second unfinished local submission to the same
saved printer rejects instead of interleaving mapping/start transactions or
creating a queue. This is independent of observed printer busy/idle state.

After ordinary validation of the retained slice, target and structured request,
Send & Print uploads the file first, without starting it. Only after successful
upload does it apply the submission's tool mapping, used heads and selected
print options, then dispatch print start after successful preparation responses.
An upload failure therefore does not apply those job settings. Independent
Device preference saves are outside this sequence.

If preparation partially succeeds and a later command fails explicitly, stop
the submission without starting the print. Do not automatically restore the
previous mapping or settings; report that device settings may have been partly
applied. No rollback snapshot or compensating settings writes are required.

Use the generic **Send print task failed, please try again** presentation for
submission errors, including a lost response after start may have been sent.
Do not add a separate start-outcome-unknown screen, a mandatory Device visit or
an extra confirmation step before manual retry. Preserve the preparation choices
and offer the ordinary manual Retry action. Retry re-enters the complete normal
flow with a current valid slice: validate, upload, apply mapping/options and
start. It does not offer start-only retry or starting an arbitrary remote file.
Automatic reconnection must never trigger this retry or replay a device command.

The generic presentation does not prove that a dispatched start was rejected or
that the printer is idle. Preserve the actual execution evidence internally;
manual retry remains subject to normal current-state and receipt validation.
This is Snapmaker-specific behavior and does not change the existing Bambu or
Moonraker unknown-outcome presentation and retry rules.

Provide an explicit **Cancel sending** action until print start is dispatched.
Cancellation attempts to interrupt an active upload and prevents subsequent
preparation/start commands. Check cancellation between stages, including after
an in-flight preparation command returns; do not dispatch the next stage merely
because that command succeeded. Already applied settings remain in place.
Ordinary dialog closure remains separate from this explicit cancellation action.

Once print start has been dispatched, Cancel sending cannot recall it. Stopping
a print is a separate user action on Device; cancellation must not automatically
send a print-stop command. Do not report that printing was prevented merely
because a cancellation request raced with dispatch. Preserve execution evidence
and use the accepted ordinary submission result/failure presentation.

Do not actively delete remote files after a canceled or failed submission.
Explain that an uploaded file may remain on the printer for later user management.
This also avoids promising cleanup of partially transferred files; the device's
own temporary-file handling is independent. A successful upload-only operation
continues to retain its file normally.

Application shutdown follows the shared
[unfinished-send exit contract](#application-exit-with-unfinished-sends): offer
waiting or stopping local sending and exiting, with browser-native limitations
on Web. Do not stop a physical print or automatically resume sending on restart.

### Accepted Snapmaker G-code and top-cover boundaries

Transmit the existing G-code unchanged. The Snapmaker send workflow must not
scan, parse or rewrite its contents, or prepend/append preparation or cancellation
commands. Obtain preparation inputs from structured retained-slice metadata and
device observations. Do not add checks for conflicts between device options
and startup G-code, or require re-slicing because of such conflicts. Assume
the submitted G-code needs no conflict handling and send the selected device
commands normally; commands already in the file execute as written.

Keep top-cover presence/status, current circulation-mode display and live fan
speed controls on the Device page, subject to the device's current supported
controls and limits. These operate directly on the printer, independently of
submission. Do not add manual circulation-mode switching as part of this scope.

Defer automatic circulation-mode calculation from either project or device
filaments, and all job-specific top-cover preparation. This delivery does not
introduce `chamber_cooling_mode` or its supporting high-temperature filament
field for that purpose. Existing top-cover commands in submitted files remain
unchanged, with no inspection or adaptation by the send workflow.

### Accepted Snapmaker control placement and status observation

Place device filament metadata editing, loading/unloading and persistent device
preferences on the Device page only. The send dialog presents device status,
submission mapping and print options; it does not duplicate those device
operations as quick actions. Device metadata edits remain distinct from the
project's filament profiles and do not silently replace slicing settings.

Loading/unloading operates on one explicitly selected physical toolhead at a
time. After that operation finishes, the user may select a head and start
another operation. Do not offer multi-selection, batch execution or a pending
load/unload queue. Show progress and the result for the individual operation.
This deliberately excludes SnapSend's multi-head batch controls from the
accepted delivery; no batch continuation or skip-on-failure policy is needed.
Do not provide a cancel-load/unload action in this delivery. Keep showing the
individual operation's progress and result; closing its page does not cancel
the device action. Cancel sending and Device print-stop remain separate controls.

For individual loading/unloading, device filament metadata edits, persistent
preference saves and live top-cover fan controls, let the printer decide whether
the requested action can execute. Do not add an idle-only requirement or disable
these controls because Neo observes printing, paused or busy state, or predicts
a conflict with another device activity. Submit the requested command and show
the printer's acceptance or rejection. Do not add a readiness query solely to
enforce such a state gate. Preserve valid targets/parameters, supported-capability
boundaries and the individual load/unload workflow above. Preference saves still
write changed fields and verify them by readback; this decision does not change
the separate submission validation rules.

For Device operation errors, including rejection, transport failure or a
preference-save readback mismatch, report the error and retain the user's edits.
Do not automatically retry or roll back device changes that already took effect.
The user may initiate another operation manually. A save whose verification
fails is not presented as successfully verified, and an interrupted response
does not prove that no device change occurred. Preserve the actual response and
execution evidence without adding an automatic recovery sequence.

After the selected printer's Monitor starts, retain its observation while the
application is open, including on Prepare, Home and the Web Interface tab, as
for Bambu. Selecting another printer, removing the connection or closing the
application releases that Monitor subscription. The Prepare model-match
indicator reuses these fresh observations. Send dialogs and unfinished
upload/device operations retain their own acquisition leases. When the final
consumer leaves, stop acquisition and retain the last snapshot with its
observation time and non-live indication. Leaving a page or closing a dialog
does not cancel a submitted operation or stop printing on the device.

While observation is needed, connection loss triggers a bounded sequence of
automatic reconnection attempts with backoff. Keep manual retry available;
after automatic attempts are exhausted, wait for manual retry. Mark retained
readings stale and make operations that require live state unavailable until
current state has been reacquired. Preserve manual send mappings and unsaved
device edits, then revalidate compatibility and availability against the new
observations. Reconnection must not automatically replay device commands or
start printing. This policy restores observation; it does not resolve an
interrupted command's outcome or authorize retrying that command.

### Snapmaker interaction boundaries and exclusions

Reuse the existing Device configuration and shared Send / Send & Print surfaces.
The configured model and native model matcher narrow the target list, while
fresh agent observations supply actual toolheads, nozzles, loaded materials
and readiness. Model equality alone does not validate a material binding.

The [Storage follow-up](#snapmaker-u1-storage-browsing) and
[camera follow-up](#snapmaker-camera-live-view) have separate delivery scopes.
The current-task image in Monitor uses the printer's available thumbnail,
including for jobs started outside Neo. It remains scoped to the reported task
and route, and uses the shared placeholder when no image is available.
The accepted SnapSend scope covers the timelapse recording switch, upload and
Send & Print. Downloads, deletion, starting remote files and history-based
reprinting remain deferred.

Persistent printer preferences, the current submission's choices and Neo's
remembered defaults retain the separate save/apply behavior above. UI state
refresh should preserve user assignments and unsaved edits, while reporting
changed compatibility or availability.

### Snapmaker U1 Storage browsing

The shared Device Storage page presents an internal and a USB G-code collection
for a configured Snapmaker LAN route in Electron and browser-direct Web.
It uses the existing loaded-file filter, date grouping, pagination and
viewport thumbnail loading. Read-only collections omit selection and file
action controls. Refresh and entry load a fresh list. An absent thumbnail uses
the file placeholder. If the printer reports no USB G-code files, the page
reports that result while the mount state stays unknown.

This increment covers G-code browsing and thumbnails. File downloads, deletion
and starting existing device files remain deferred.
The [provider implementation and qualification](Printer%20Domain%20and%20Control%20Architecture.md#read-only-u1-storage-follow-up)
define the HTTP and host boundaries.

### Snapmaker U1 stored timelapses

Device Storage offers an internal **Timelapse** collection for the configured
Snapmaker route. It shows completed videos with their print name, optional cover,
size and date. Select a video and choose **Play selected video** to open the
shared stored-video dialog. Close the viewer, change storage scope or leave the
page to release playback. This delivery covers browsing and playback.

Electron plays through a document-scoped streaming relay. Web plays directly
when the browser can reach and authorize the printer's media URL without a
custom API-key header. The
[timelapse protocol and qualification](Printer%20Domain%20and%20Control%20Architecture.md#u1-stored-timelapse-follow-up)
record the host behavior and physical acceptance.

### Snapmaker camera live view

**Decision status** — Snapmaker live view uses WebSocket camera control,
HTTP JPEG acquisition and the shared Camera card/player. Web/shared UI
and Electron utility/binary delivery have fixture acceptance.
Windows development-host real-U1 viewing passed for over 30 minutes per host,
with the tested Web HTTP loopback origin and qualification limits recorded in
the [camera acceptance](Printer%20Domain%20and%20Control%20Architecture.md#windows-development-host-camera-qualification).
The [camera architecture](Printer%20Domain%20and%20Control%20Architecture.md#82-snapmaker-u1-lan-live-view)
owns protocol evidence, transport, media resources and qualification boundaries.

Electron and Web are initial delivery targets, each with host-specific
acceptance. Initial playback supports plain JPEG. An encrypted image source
shows an explicit playback-unavailable explanation. Browser networking or
permission restrictions are camera-specific failures and do not disable
unrelated Monitor controls.

Initial qualification covers stock U1 firmware on the selected WS/JPEG route.
Compatible community firmware can use the same path; its additional streaming
services remain follow-up work. Completion includes software checks and at
least 30 minutes of real-U1 viewing per host, including renewal, recovery,
lifecycle and coexistence cases owned by the architecture. Mobile
qualification follows the shared application's deferred first-release status.

The camera reuses the saved Snapmaker address and optional API key through its
host adapter. It introduces no separate camera-connection form. A connected
Snapmaker route with unknown camera support shows a card and permits explicit
Play to validate the function. Loading Monitor alone does not start a camera.
Confirmed lack of support shows its reason. Authentication, access permission
and temporary connection failures retain distinct explanations; a missing
capability report is not presented as confirmed hardware absence.

Use the existing Monitor camera presentation and managed viewing intent as the
baseline. User Play, connection progress, first displayed image, Stop, Retry and
fullscreen follow the [shared Camera interaction](#camera-live-view). The
current-task thumbnail remains a separate task-scoped presentation. Viewing
does not enable recording or change a print job's timelapse setting.

Connection readiness and the first displayed image are separate states.
Acquisition permits at most five image requests per second, with one request
in flight. Actual source FPS remains unknown unless established independently.

During a recoverable network interruption or consecutive invalid images, keep
the last valid displayed image with a visible recovery state. Automatic
recovery lasts at most 30 seconds. Recovery requires valid displayed playback
and restoration of any failed required control path. A successful start/renew
response alone does not end recovery. After that window, stop the view and
provide explicit Retry. Authentication, permission, unsupported-camera
and unsupported-encryption errors require user action directly. Explicit Stop
or leaving the viewing context cancels recovery. This Snapmaker policy extends
the shared Camera baseline with bounded recoverable-frame handling.

Each application instance permits one Snapmaker camera view. Switching devices
releases the old view before a new one opens. Stop clears viewing intent;
temporary hiding follows the shared release/reopen behavior for the same
device. Release cancels local acquisition and renewal and makes a bounded
best-effort stop request with the session's client ID. Local cleanup completes
even if that request fails. Device capture shutdown and isolation from other
applications remain subject to unqualified firmware behavior. The UI reports
the local viewing state. Device-side capture state remains unknown.
The presentation exposes connection and recovery status. Last-received time
and source-freshness indicators are outside the selected UI. An unchanged
scene alone must not be reported as a failed camera.

LAN viewing renews every 300 seconds after an acknowledged start/renew.
Direct user interaction with the active camera card can trigger an extra
renewal, throttled to once per minute. These operations use the existing
session and preserve displayed playback when delivery is unchanged. A failed
required renewal enters the same bounded recovery policy. The architecture
owns serialization and the separation from Neo media-resource lease renewal.

Electron owns protocol/acquisition in a utility-process host with main-frame
lifetime coordination and binary frame delivery. Web uses the browser host
adapter. Shared UI continues to consume the same media/player boundary.

### Snapmaker acceptance and physical qualification

Implementation may be delivered and marked complete after the full accepted
scope passes automated acceptance, including protocol fixtures and the affected
Electron and Web host boundaries. Real U1 qualification is a separate track;
unavailable hardware does not block code delivery. Record unrun physical cases
as unverified, never as passed or implied by mocks. A basic upload-only increment
does not complete the broader accepted scope.

The separate [live-camera follow-up](#snapmaker-camera-live-view) adds real-U1
completion gates for that feature. The software-only completion policy above
continues to govern the delivered agent/send scope.

Follow the [testing guidelines](../doc/testing_guidelines.md) for execution
levels. Prove shared behavior at its lowest practical layer and exercise each
affected host seam; do not duplicate the whole shared matrix in both hosts.
Real-WASM checks cover the changed native project/mapping contract and actual
logical tool/temperature numbering. Neither those exports nor a simulated
printer establish physical printing behavior.

| Area | Required software acceptance |
| --- | --- |
| Configuration and project editing | Manual `snapmaker` selection, optional model association and its priority; offline U1 1–64-slot editing, manual plate mapping, persistence/invalidation, and unchanged eligibility for other printers and automatic modes. |
| Mapping and options | Retained-slice defaults, explicit automatic matching, manual overrides and acknowledgements, many-to-one bindings, logical-ID boundary rejection, deduplicated calibration heads and per-printer remembered switches. |
| Submission protocol | Unchanged artifact transfer; upload-only versus upload/preparation/start ordering; failure at each stage, partial application without rollback, cancellation/dispatch races, generic failure and explicit full-flow retry, and no automatic remote-file cleanup or command replay. |
| Device operations | Individual load/unload and progress, metadata editing, supported preference fields and ranges, changed-field writes/readback, device-decided state admission, preserved edits and manual retry after errors, and the retained top-cover controls. |
| Observation and hosts | Consumer-owned acquisition, stale/unknown state, bounded reconnect without mutation replay, preserved drafts, host transport boundaries and browser networking failures. Web tests do not imply unrestricted access from every deployed origin. |
| Application exit | All existing Moonraker and Bambu sends plus Snapmaker: wait versus stop-and-exit, hidden-dialog ownership, pending work and teardown races, Web leave limitations, and no physical print-stop or automatic resume after restart. |

Maintain a separate real-U1 checklist covering actual upload/print start,
more than four logical filaments, multiple logical materials using one loaded
physical head, and the retained logical temperature/tool-change behavior and
shared-heater effects. Include inserted-but-unloaded startup, individual
loading/unloading, preference application/readback, and the retained device
controls. Record the tested firmware, printer/profile configuration and host,
with passed, failed and unrun cases distinguished. Physical tests qualify those
conditions only; they do not create a universal firmware or platform claim.

### Software acceptance record (2026-11-06)

The implementation was rebased onto main `84f5c420` with Orca submodule
`e2cd10ba84a6f96e23827d2f851d0c4064a9eea3`. No libslic3r source or
submodule pin changed for this feature. U1 eligibility/configuration adaptation
is in the existing native bridge; send code does not inspect G-code contents.

| Verification | Result and boundary |
| --- | --- |
| `pnpm typecheck` | Pass across the workspace. |
| `pnpm --filter @orca/printer-control test` | 233 passed: protocol, observations, hardware commands, preferences/readback, upload/start/failure/cancel/retry and shared exit ownership. Includes stable U1 material revisions and Confirm-only catalogue editing with physical-head and series translation. |
| `pnpm --filter @orca/slicer-app test` | 1696 passed, including capability-driven metadata edits without a model, retained drafts on failure, visibility lifetime, preparation choices and exit confirmation. |
| Affected package tests | Web 46; WASM client/bridge contracts 700 with 28 skipped; runtime 65 with 3 skipped; platform contracts 57; profile resources 4 passed. Skips remain excluded from acceptance. |
| Electron production-path E2E build | `pnpm --filter @orca/desktop exec electron-vite build --mode e2e` passed; this test build uses the mock slicer and real host IPC/HTTP transport. |
| Electron printer E2E | All nine cases passed for Snapmaker manual setup, physical-head control while printing, metadata without a model, verified preference save, model filtering, Moonraker send/start retry, and dirty-project then unfinished-send exit decisions. Focused follow-up covers retained polling in Prepare and the model-match indicator after U1 Printer/Filament sync with real WASM. |
| Electron Prepare/device material E2E | All three `prepare-synchronization.e2e.ts` cases passed with real WASM. A Bambu project shows U1's normalized PLA HIGH SPEED card labels and preselects SnapSpeed in the editor, then writes its series to physical head 3. The other cases cover Bambu mixed-hardware import and nonempty U1 Printer-to-Filament sync with telemetry, material change and Refresh. Acceptance uses loopback protocol fixtures. |
| Native device material catalogue | Both threaded and serial quick builds and `device-material-catalogue-smoke.mjs` passed. Covers Bambu root/variant selection, U1 heads 1–4, exact 0.4 variant selection despite the mixed 0.4+0.6 variant, 0.6 lookup, and preservation of an unrelated Bambu project. |
| Bambu submission E2E | Both `bambu-print.e2e.ts` cases passed for model selection, remembered options, cancellation, unknown outcome and successful closure. |
| Bambu Storage E2E | Both `bambu-storage.e2e.ts` cases passed. The preference-persistence fixture uses keyboard submenu navigation and waits for dialog closure; the initial mouse-hover version was blocked by an inert overlay when reopening Preferences. This is not physical transport qualification. |
| Web E2E | Both `snapmaker.e2e.ts` cases passed using real Web WASM and a CORS-enabled loopback printer: manual persistence/reload, direct transport, individual load and verified preferences. No gateway or U1 hardware is involved. |
| Native U1 project/mapping | Both threaded and serial quick builds/validation/staging and `u1-material-mapping-smoke.mjs` passed: 1–64 project slots, more than four materials, sparse logical `T5`, mapped physical parameters, temperatures, invalidation, undo/redo and 3MF roundtrip with SEMM false. Existing threaded nozzle-mapping projection smoke also passed. |

The exact focused host commands are:

```powershell
pnpm --filter @orca/desktop exec playwright test e2e/printer-control.e2e.ts
pnpm --filter @orca/desktop exec playwright test e2e/bambu-print.e2e.ts
pnpm --filter @orca/desktop exec playwright test e2e/bambu-storage.e2e.ts
pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts snapmaker.e2e.ts
```

Independent review found that a stopped preparation watcher was not restarted
by manual Refresh. The fix restarts only a stopped watcher after a successful
read, preserving manual mappings and never replaying submissions. Component
regressions cover both thrown errors and ended streams, failed refresh, later
observations, retained mapping and unmount cleanup.

Repository-wide `pnpm test` and `pnpm typecheck` now pass. The initial seven
Windows failures were reproduced and fixed in separate Bambu-native and desktop
test commits. Bambu-native has 50 passing tests: trace assertions accept LF/CRLF;
bounded native reads resume on consumer demand; project-resource reads yield to
I/O after progress instead of delaying each batch; and storage reads inspect
arrived packets before declaring inactivity. Deadlines, queue bounds, integrity
checks and cancellation remain covered. The desktop suite has 568 passed and
one skipped after making the download-path expectation platform-aware. The
Bambu print-submission suite, including cancellation plus callback/file lifetime
at shutdown, retains its 34 passing tests.

### Real U1 non-printing acceptance (2026-11-06)

Tested one LAN U1 on Windows, reporting Klipper firmware
`2.0.0.205_20260914173503` and Moonraker `2.0.0`. The printer began and ended in
`standby` with no active filename, all heater targets zero, all tested fan
speeds zero and the cavity light off. The four nozzles reported 0.4 mm,
`standard` flow, with four loaded Snapmaker PLA-SnapSpeed filaments. The top
cover reported disconnected (`power_detected=false`, mode 0).

The opt-in [hardware acceptance](../apps/desktop/e2e/snapmaker-hardware.e2e.ts)
uses the actual provider and real HTTP responses. Its Electron case uses the
real threaded WASM worker and renderer/preload/main transport. Configuration is
copied into an isolated host directory and selects `snapmaker`; the user's
existing Moonraker connection is not rewritten. Service-level preparation and
write probes use Node HTTP transport, separately from the Electron UI case.

| Case | Result and exact boundary |
| --- | --- |
| Read-only acquisition | Four heads, material colors/types/presence/loading, five temperatures/targets, fan/light states, top-cover state and all ten persistent preference fields read successfully. |
| Printer sync identity | The Snapmaker agent publishes the manufacturer/model selected manually in Device settings in its descriptor. Hardware objects never infer the model; an absent selection remains unknown. Existing observation streams use the latest selection on their next acquisition. Generic sync consumes the agent descriptor without substituting models. A real LAN read supplied the identity and four nozzle parameters to the real threaded-WASM Printer sync transaction, which selected `Snapmaker U1 (0.4 nozzle)` successfully. No printer write was sent. |
| Filament sync identity | The agent retains the reported vendor/type/series name separately from upstream Orca type normalization (SnapSpeed/HS becomes `PLA HIGH SPEED`). For reported-present supplies, a Snapmaker-Orca-style exact compatible system-preset base-name match runs first, case-insensitive and ignoring the local `@variant` suffix. If absent, use upstream Orca visible/compatible base-preset vendor/type/nearest-RGB matching, then native `filament_id_by_type` fallback. No SKU or hardcoded ID is used. Four real LAN supplies selected `Snapmaker PLA SnapSpeed @U1` by name and retained their RGBA colors through rebuild; without name priority that catalogue selected Generic PLA by type fallback. The native matcher is read-only and injected through both host runtimes. Metadata saves retain unchanged raw type/series rather than writing the normalized display type. Generic sync eligibility is unchanged. |
| Shared monitoring | Live subscriptions repeatedly acquired device state. Releasing the last subscription stopped further reads; cached inventory was retained as stale. This did not disconnect the printer's network. |
| Electron Monitor | Real data and enabled per-head controls rendered. Manual Refresh preserved an unsaved preference draft; leaving Device and closing the host required no printer action. |
| Six logical materials | Structured requirements produced plate-derived head defaults `[0,1,2,3,0,1]`. Manually binding all six to head 0 preserved the bindings, reported warnings and deduplicated calibration to one head. No mapping/calibration command was applied and no print was started. This does not establish physical shared-heater behavior. |
| Cavity light | Toggled on, observed the reported white channel, then restored it to off. No visual brightness claim is inferred from the status response. |
| Persistent preferences | All ten reported booleans/sensitivity fields were changed to another advertised value, verified through fresh reads, then restored and verified. This proves command/readback, not detection accuracy, auto-refill during printing or persistence across a firmware reboot. |
| Fans | Four part fans and the cavity fan accepted 20%, reported 20%, then were restored to 0 and verified. RPM, airflow and cooling effectiveness were not measured. Disconnected top-cover fans were not operated. |
| Upload only | Uploaded the existing real-WASM artifact unchanged (871,406 bytes), downloaded it for exact byte comparison, and verified unchanged print state and job preferences/mapping. The only file write was upload; no preparation/start/delete request was sent. |

The upload intentionally remains on the printer as
`NEO_acceptance_DO_NOT_PRINT_1793936034438.gcode`. No cleanup or print was
performed. Source bytes came from the prior six-material real-WASM slice;
the acceptance harness compared bytes and did not parse or rewrite G-code.

Real hardware exposed a capability-discovery defect: `/printer/gcode/help`
omits registered commands without help text, including U1 preparation,
preferences, feed and purifier commands. Discovery now queries the `gcode`
object's `commands` map. The firmware reported 391 registered commands,
including the previously hidden commands. A regression explicitly covers
empty command descriptions; updated Electron and Web protocol fixtures pass.
Repository `pnpm test` and `pnpm typecheck` pass after the correction.

To run the explicitly selected hardware cases (requires an accessible idle U1
and a configuration containing exactly one U1):

```powershell
$env:VITE_USE_MOCK = '0'
pnpm --filter @orca/desktop exec electron-vite build --mode e2e
$env:NEO_U1_ACCEPTANCE_CONFIG = '<absolute-path-to-printer-config.json>'
pnpm --filter @orca/desktop exec playwright test e2e/snapmaker-hardware.e2e.ts
# Optional writes: restored lights/preferences/fans and an upload retained on the printer.
$env:NEO_U1_ACCEPTANCE_WRITES = '1'
$env:NEO_U1_ACCEPTANCE_GCODE = '<absolute-path-to-existing-sliced.gcode>'
pnpm --filter @orca/desktop exec playwright test e2e/snapmaker-hardware.e2e.ts
```

Without explicit configuration, the hardware cases skip. Without the write
opt-in, only the read/Monitor cases run. The write transport rejects print-start,
heater, movement, material-feed and deletion requests. Test reports retain
observation snapshots, command/upload evidence and a Monitor screenshot; they
must not include API keys.

Still **unrun**: physical many-to-one material and
shared-heater behavior; inserted-but-unloaded startup; flow-calibration subsets;
individual load/unload; standalone heating/motion controls; successful non-official material-metadata
writes (which may alter the association with RFID-reported metadata); disconnected top-cover controls;
physical disconnect/cancel/exit races; real-Web-to-U1 networking; other models,
firmware or installer platforms. The calibration-subset field discrepancy
remains a physical qualification item. No claim of universal U1 compatibility
is made by this bounded acceptance.

#### Material information write admission (2026-11-07)

The same Windows/LAN U1 and firmware were tested through the real Electron
Material information dialog and threaded WASM catalogue. All four heads
reported official Snapmaker PLA SnapSpeed, `filament_official=true` and
`filament_edit=false`. Toolhead 1's color was changed locally from `080A0DFF`
to `12A4EFFF` and submitted through Confirm. The firmware rejected the command
with `official filament, not configurable!`. Monitor displayed the generic
printer-rejection feedback. Reopening the editor showed the original material
and color. Fresh reads verified all four heads' vendor/type/series/color,
presence, official/edit flags and SKU against the baseline, together with
unchanged standby/filename state and five zero heater targets. No restoration
write was needed. This qualifies the device-decided rejection path. Successful
non-official material writes remain unqualified.

The separate [material hardware test](../apps/desktop/e2e/snapmaker-material-hardware.e2e.ts)
requires the real-WASM build and selected configuration above, plus the explicit
`NEO_U1_ACCEPTANCE_MATERIAL_WRITES=1` opt-in. Run it with
`pnpm --filter @orca/desktop exec playwright test e2e/snapmaker-material-hardware.e2e.ts`.
The test records before/after values and a rejection screenshot without API
keys. Production behavior continues to let firmware decide admission and
preserves the existing exclusion of forced official-filament edits.

### Real U1 single-head print (2026-11-07)

The operator confirmed a clear, installed build plate. Windows Electron with
real threaded WASM used the U1 0.4 mm Printer, `0.20 Standard` Process and
Snapmaker PLA SnapSpeed preset to slice a nominal 10 × 10 × 3 mm block into 15
layers. Plate Manual mapping assigned logical filament 0 to physical Toolhead 1.
The Send & Print form selected the real U1 with bed leveling On, flow
calibration Off and timelapse Off. The sole warning concerned unreported nozzle
hardness with a required value of zero and was acknowledged explicitly.

The uploaded job was
`NEO_U1_10x10x3_1794043971969_PLA_0.3g_1m28s.gcode`. The printer heated Toolhead 1
and the bed, performed its preparation/probing sequence, printed and reported
`complete` at 15/15 layers with progress 1. The operator confirmed normal
printing. Firmware recorded total duration 465.66 s, print duration 102.20 s and
104.69 mm filament used. During printing only Toolhead 1 was marked used, and
the other three nozzle targets stayed zero. At completion all five heater
targets were zero. Dimensional accuracy was not measured.

The [explicit print harness](../apps/desktop/e2e/snapmaker-print-hardware.e2e.ts)
requires `NEO_U1_ACCEPTANCE_CONFIG` and `NEO_U1_ACCEPTANCE_PRINT=1` together with
a freshly cleared plate. Its original final assertion expected the used-head
flags to survive completion, while the firmware clears them. The harness now
checks a retained printing observation. The corrected completion checks passed
against the 91 retained observations through its recorded-telemetry test. The
full modified print harness has not been rerun on a second physical print.

This run exposed missing layer/stage normalization. The agent now consumes
`print_stats.info` and the firmware machine-state/action codes. A subsequent
read-only real-Electron check against the completed job rendered `Layer 15 / 15`,
zero remaining minutes and an idle-stage dash. Active stage labels have
protocol-fixture coverage.
The device status has no remaining-seconds field, while file metadata provides
an 88 s slicer estimate. The agent now derives remaining time from executable-byte
progress, with protocol-fixture coverage. The subsequent four-head print below
qualifies live estimate rendering during printing. The queried filament inventory also supplied no
valid remaining-spool quantity.
Many-to-one logical materials, inserted-but-unloaded startup and shared-heater
execution need their own physical cases.

### Real U1 four-head print (2026-11-08)

The operator confirmed a clear, installed build plate. The same Windows/LAN U1
with firmware `2.0.0.205_20260914173503` reported four inserted Snapmaker PLA
supplies and four 0.4 mm nozzles. An isolated real-Electron project used four
10 × 10 × 1 mm blocks, the U1 Printer and Snapmaker PLA SnapSpeed presets,
with project colors copied from the device's black/red/white/yellow observations.
Plate Manual mapping assigned the four logical materials to heads 1–4 in order;
the Send & Print preparation retained the same four physical bindings. Bed
leveling was On, flow calibration and timelapse Off. The four unreported-nozzle-
hardness advisories each required zero hardness and were acknowledged.

`NEO_U1_4heads_1794105416233_PLA_1.8g_7m1s.gcode` completed at 5/5 layers and
progress 1. Firmware reported total duration 862.78 s, print duration 517.80 s
and 649.00 mm filament used. All five heater targets were zero at completion.
The 167 retained observations showed each physical head active and heated to
printing targets during deposited layers, with mapping `[0,1,2,3]` and all four
used-head flags set while printing. The operator confirmed normal first-layer
adhesion and switching, followed by four complete black/red/white/yellow pieces.
Dimensions were not measured.

An independent read-only real-Electron check during this same job decoded the
printer's 300 × 300 thumbnail and rendered `Layer 4 / 5`, `Stage Printing` and
`Remaining 2 min`; the initial Monitor showed 7 min. Completion readback rendered
5/5 layers, zero remaining minutes and the idle-stage dash. This qualifies live
status/preview rendering for this job; estimate accuracy is not established by
those displayed values.

The existing [print harness](../apps/desktop/e2e/snapmaker-print-hardware.e2e.ts)
accepts `NEO_U1_ACCEPTANCE_HEADS=4` with its existing explicit print/configuration
opt-ins. `NEO_U1_ACCEPTANCE_PREPARE_ONLY=1` stops after slicing and reviewing the
prepared form. Both retained single-head and four-head telemetry passed the
completion verifier, including a check that each requested head was active and
heated during nonzero layers. Local ignored evidence is under
`test-results/u1-four-head-print/`, `test-results/u1-four-head-live-monitor/` and
`test-results/u1-four-head-completion-monitor/`. This case qualifies four distinct
logical-to-physical bindings with PLA. More than four logical materials,
many-to-one mappings, shared-heater effects, unloaded startup and calibration
subsets retain their separate physical qualification requirements.

### Comparison baseline and evidence limits

Distinguish inspected source or shipped client code from public documentation
and unverified behavior. Plugin documentation cannot establish undocumented
implementation details. The inspected references do not establish the products'
complete release-qualification criteria.

Upstream Orca has a distinct Snapmaker agent that inherits Moonraker upload/start
and adds Snapmaker filament synchronization. Its native desktop integration is
separate from the plugin's setup window; see the source references in the
[architecture evidence](Printer%20Domain%20and%20Control%20Architecture.md#reference-evidence-and-qualification-limits).

[SnapSend 0.9.58](https://cloud.orcaslicer.com/p/51b695a195de) documents desktop
Windows/macOS/Linux support, uses the active Orca printer connection, and runs
before upload or upload-and-print. It prepares mappings/settings and delegates
the transfer/start to Orca. Its documented material operations and printer
preferences are additional to upstream Orca's built-in Snapmaker agent.
No browser-host implementation or source-level verification of SnapSend is
established by this investigation.

The comparison is a reference for decisions, not a requirement to reproduce
plugin installation, desktop-specific UI, or legacy cancellation workarounds.
Mobile product support remains deferred under the shared application policy;
shared code does not imply additional mobile or browser networking guarantees.

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
