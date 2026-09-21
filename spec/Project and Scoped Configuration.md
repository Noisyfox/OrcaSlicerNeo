# Project and Scoped Configuration

**Status:** Design in progress — scope-model decisions accepted 2026-09-20

**Scope:** Add an Orca-like switch between project-wide configuration editing
and selection-scoped configuration editing to the shared Electron and Web
application. This specification is the normative record for the feature and
will be extended only after each related decision group is accepted.

## 1. Configuration ownership

Configuration state remains authoritative in the Worker/WASM session. React
projects the effective values and their sources; it does not retain a second
configuration model. All scoped identities are stable native IDs, never
renderer indices.

The feature has four explicit override scopes:

- **Project** — one project-wide override map.
- **Plate** — one map for a stable plate ID.
- **Object** — one map for a stable `ModelObject` ID.
- **Part** — one map for a stable `ModelVolume` ID. Every volume type with a
  `ModelVolume::config` — normal model parts, parameter modifiers, negative volumes,
  and support helpers — uses this same storage scope. Its type-specific label and icon
  remain a presentation concern.

An override exists only when the key is explicitly stored at its scope. An
effective value inherited from another scope is not copied into local state.

## 2. Editing modes and scoped-target resolution

The parameter surface has a Project / Scoped mode switch. Project mode edits
only the Project map. Scoped mode resolves targets from the authoritative
selection in this order:

1. a whole-object selection targets the selected object maps;
2. a `ModelVolume` selection targets the selected volume maps;
3. an empty model selection targets the active plate map.

Several targets are allowed only when they have the same resolved scope. The
surface renders a shared value normally and a mixed value when target values
differ; a subsequent edit writes the chosen value to every selected target.
Object selection mixed with part/modifier selection has no writable scoped
target. The surface explains that the user must choose one hierarchy level
instead of silently broadening, narrowing, or dropping the edit.

## 3. Effective-value precedence

For any eligible option, the effective value is composed in this order:

```text
printer/process/filament base presets
  -> Project override
  -> active Plate override
  -> Object override
  -> Part or Modifier override
```

Later explicit values win. A part and a modifier have equal precedence because
each is a `ModelVolume`; they do not form separate nested override classes.

When multiple configured volumes overlap geometrically, native Orca region
construction and slicing determines their actual regional composition. React exposes
each volume's local configuration but does not create a separate overlap-priority
model or claim a synthetic final source for a geometrically overlapping region.

This matches OrcaSlicer's engine ordering: its background process overlays the
current plate onto the full project configuration, `PrintObject` overlays the
model-object configuration, and its region resolution overlays the model-volume
configuration last.

## 4. Parameter eligibility

Scopes expose only keys that the native engine gives a meaningful local
semantics. The typed metadata contract is the source for this classification;
the UI must not optimistically offer arbitrary FFF keys and wait for runtime
rejection.

| Scope | Eligible configuration class |
| --- | --- |
| Project | Supported FFF project configuration |
| Plate | Native plate-specific keys |
| Object | `PrintObjectConfig` and `PrintRegionConfig` keys |
| Every `ModelVolume` type | `PrintRegionConfig` keys |

Layer-range configuration has no editing or write path in this feature.

This is deliberately aligned with OrcaSlicer: `TabPrintObject` is built from
the union of `PrintObjectConfig` and `PrintRegionConfig`, generic volume settings use
`PrintRegionConfig`, and the plate tab has a fixed plate-key set.

## 5. Inheritance and reset

Each scoped parameter offers a reset that removes only its local explicit
override. Reset never writes the value currently inherited from a parent.
After reset, the surface displays the selection-limited inherited value and source
defined in section 12. For same-scope multi-selection, reset removes that key from
every target.

The feature also provides a target-level reset of every locally stored key in its
native resettable scoped-key set. It has the same erase-only meaning. The Worker
defines this set from the scope-eligible generic configuration keys; it excludes
`extruder`, typed filament/rack assignment, Layer Range, Custom G-code, and native
unknown or otherwise inaccessible data. Both forms are project mutations and use the
established transaction, dirty-state, invalidation, and Undo/Redo path.

This preserves OrcaSlicer's `ModelConfig::erase(key)` “back to system value”
behaviour: later parent changes continue to flow to a target that has been
reset.

## 6. Mode state

Project / Scoped is an explicit user-selected UI mode. Selection changes only
resolve a new target while Scoped mode is already active; they never switch the
mode automatically. Every newly started, opened, or reset project session
begins in Project mode.

Mode is transient UI state. It is not written to 3MF, recorded in project
history, included in Undo/Redo restoration, treated as a global preference, or
allowed to mark a project dirty. A history restore may change the selection;
when Scoped mode is active, the surface simply resolves the restored selection
under the normal target rules.

## 7. Instance and multi-plate reach

There is no instance configuration scope. An instance selection resolves to
its owning object, and its part/modifier selection resolves to the owning
volume. Object and part/modifier overrides therefore apply to every instance
of the owning object, independent of the active plate at edit time.

An object or volume configuration edit invalidates precisely every plate that
currently contains one of that object's instances. It must not invalidate an
unrelated plate, and it must not leave a plate containing another instance
with an old slice result. This uses the established per-plate input-revision
and result-staleness contract.

## 8. Entity lifecycle

Deleting an object, part, or modifier atomically deletes its scoped overrides;
there is no orphan-override store and no reuse of a deleted entity's identity.
The usual selection clearing leaves Scoped mode active and consequently
resolves the active plate as its target.

Undo and Redo restore or remove the entity and its scoped overrides together
through the existing Worker-owned project-history transaction. They do not
restore the transient Project / Scoped mode itself. A restored selection is
resolved normally if the user has kept Scoped mode active.

Copying, splitting, and cutting that creates a derived Object or Volume adopts the
native structural-operation result directly. Where native clone semantics copied an
Object, Part, or Modifier local configuration, the derived entity keeps that copied
configuration under its new stable ID. Neo establishes no separate old-to-new overlay
mapping and does not clear the copied native configuration merely because the entity
was derived.

The initial generic Project/Scoped surface provides no independent local-configuration
copy or paste command. It therefore creates neither a configuration clipboard nor
cross-scope conversion, filtering, or history semantics; native structural operations
remain the only configuration-copy paths in this milestone.

Reloading or replacing geometry follows the same native-result rule. A surviving
Object or Volume retains the local configuration that the native operation retains; a
newly constructed entity receives only configuration the native operation explicitly
copied. Neo performs no name, index, mesh-similarity, React, or secondary Worker
mapping of old scoped configuration onto rebuilt entities. If native replacement
removes a local configuration, no Neo overlay can revive it.

Moving an entity between plates does not move or duplicate its Object, Part, or
Modifier local configuration: those values belong to the entity and follow it. The
source and destination plate input revisions both advance. Plate-local configuration
remains with its plate, so the moved entity's effective configuration is recomposed
against the destination plate without altering either plate's local values.

Adding an empty plate creates no local Plate configuration. Its configuration initially
inherits Project and base-preset values. A future explicit plate-copy command, if
introduced, requires its own copy semantics and is not implied by Add Plate.

Deleting a plate atomically deletes that plate's local configuration. Its instances
become parked/unassigned under the existing plate-session lifecycle, while their
Object, Part, and Modifier local configuration remains attached to the model entities.
When a parked instance is later placed on a plate, effective values are recomposed
against that plate's configuration; no old Plate override is revived or copied.

## 9. 3MF authority and compatibility

Saved 3MF projects use the native Orca/Bambu locations as their only
configuration authority:

- Project overrides are stored in the project configuration.
- Plate overrides are stored in their plate configurations.
- Object overrides are stored in `ModelObject::config`.
- Part and modifier overrides are stored in their `ModelVolume::config`.

Neo may keep session-only state in runtime memory, but it must not persist a
second configuration authority. A project saved by Neo must preserve these
scoped settings when opened by OrcaSlicer.

On project open, valid recognized native values are restored at their native
scope. The shared UI exposes only the eligible keys in this specification, but
an otherwise valid native value with no current UI is retained and written back
unchanged. Unknown, invalid, or incompatible project configuration follows the
existing explicit 3MF compatibility fallback; it is never silently removed
during a successful project open.

Geometry-only import is deliberately different. It appends geometry, object /
part / modifier structure, and the required extruder assignment, but clears
all other incoming Project, Plate, Object, Part, and Modifier overrides. It
does not accidentally turn an Add Model action into a configuration import.

The private Neo configuration-sidecar archive entry
`Metadata/orca_neo_config_overlay_v1.json` is removed outright. New saves do not
write it and opens do not read, migrate, or replay it. A legacy project whose setting
exists only in that sidecar intentionally loses that setting; native 3MF locations are
the sole supported persistence source.

### 9.1 No Neo-private project metadata

Neo writes no `Metadata/orca_neo_*` member to a project 3MF and does not read,
migrate, preserve, or replay one when opening a project. This includes the former
configuration overlay as well as private plate-session and filament-state entries.
The archive contains only the standard BBS/Orca project data emitted by the native
writer.

The standard BBS plate data remains responsible for persisted plate structure,
membership, names, locks, and the complete native `PlateData::config` and
metadata needed by Orca's slicing path. Neo's currently selected plate and virtual
editing layout are session-only and are reconstructed deterministically on open.
Standard BBS project configuration and embedded preset records remain responsible
for project filament selection and editable filament settings, as in OrcaSlicer.
Live AMS/device state stays in Neo's device-management and runtime session
boundaries; it is never serialized in the project or user profile.

The native Project owner boundary is the upstream `PresetBundle::s_project_options`
set plus Neo's controlled bridge-owned filament-routing extension:
`wipe_tower_filament`, `support_filament`, `support_interface_filament`,
`outer_wall_filament_id`, `inner_wall_filament_id`, `sparse_infill_filament_id`,
`internal_solid_filament_id`, `top_surface_filament_id`, and
`bottom_surface_filament_id`. These existing routing slots stay in native
`project_config`, the Project history root, and the effective slice configuration
because the dedicated filament-routing commands and native slicer already treat
them as Project authority. They are deliberately not generic Project/Scoped
catalogue keys and are rejected by the generic set/reset API; they are never
encoded in or interpreted through `different_settings_to_system`. Other editable
Project-scope Print options are local differences in the edited Print preset and
round-trip through the standard embedded-preset/full-config path.

When the first ordinary Project Print mutation changes an effective value, Neo
materializes the selected native Print preset through Orca's
`PresetCollection::save_current_preset(..., save_to_project=true)` path, with the
selected preset as its parent. Equal-value requests, native Project-owner keys,
and bridge-owned routing keys do not create that child. The child selection and
its real parent-difference values are native Print-preset state captured in the
project history context, so Undo/Redo restores the selection and embedded preset
without a session sidecar. Native preset bookkeeping such as `inherits` and
`print_settings_id` is never exposed as a generic Project override.

Neo exposes a Plate-scoped parameter only when Orca's native BBS
`Metadata/model_settings.config` writer can round-trip it. The supported native
keys are `curr_bed_type`, `print_sequence`, `first_layer_print_sequence`,
`other_layers_print_sequence`, `other_layers_print_sequence_nums`, `spiral_mode`,
`filament_map_mode`, `filament_map`, and `filament_volume_map`. A set or reset
request for any other key at Plate scope is rejected with `unsupported_reference`;
the key is not exposed as an editable scoped override. Other native BBS plate
fields (including structural or derived metadata such as
`enable_filament_dynamic_map` and `has_filament_switcher`) remain intact in the
native plate state, history frames, and standard BBS save path, but are not part
of the generic editable Plate-scope surface.

## 10. Base-preset transitions

Changing the printer, process, or filament base presets is allowed even when a
scoped native value is no longer effective under the new combination. The
transition retains each representable native scoped value, atomically refreshes
the effective-value/source projection and parameter eligibility, and advances
the affected plate input revisions according to the existing configuration
rules.

Neo does not reject the selection solely because of a retained local override,
silently erase it, or place it in a Neo-only inactive store. If the resulting
full native configuration cannot slice, the normal native configuration or
slice validation reports that error. This matches OrcaSlicer's behaviour of
keeping object/volume `ModelConfig` data while a preset transition recomputes
the active configuration and compatibility state.

## 11. Active slice interaction

The slice-runtime policy remains capability-dependent.

In serial WASM, configuration and history mutations are rejected while a slice is
active with the existing `slice_busy` result. They create neither a history entry
nor a configuration change.

In threaded WASM, a configuration edit is allowed during an active slice. The
Worker first commits the authoritative configuration transaction and advances the
input revisions for exactly its affected plates. The application then withdraws
affected visible results. If the active slice target is one of those plates, it
issues the existing cancellation request asynchronously and does not wait for the
worker task to stop; an active slice for an unaffected plate continues.

Cancellation is a latency optimization, not the correctness boundary. A completion
whose captured input revision no longer equals the authoritative plate revision is
stale and must never publish a result, including when cancellation races with normal
task completion.

## 12. Configuration surface and initial validation

The configuration surface has a compact `Project | Scoped` segmented toggle in its
header. In Scoped mode, the header also presents a read-only resolved-target label,
for example `Plate 2`, `Object: Cube`, or `Modifier: Text`. The target follows the
scope-resolution rules in section 2; changing selection does not move the toggle.

The Scoped view is a complete catalogue of parameters eligible for its resolved
scope, rather than an add-parameter-only list. Every parameter presents its
selection-limited value, provenance, and a reset control whenever the resolved scope
owns a local override. Reset deletes that local value as specified in section 5.

The catalogue is organized by native parameter category and supports a search across
categories. Category expansion and the search query are transient session UI state.
Bulk reset for one category or every local key in the native resettable scoped-key set
on the resolved target runs without a confirmation dialog as one atomic history
transaction; Undo/Redo is its recovery mechanism, just as for an individual reset.

Plate, Object, and Volume nodes in the existing scene/Object List receive a
non-interactive scoped-override state marker when, and only when, their local map
contains at least one key in that same resettable scoped-key set. The marker has no
Reset All action; all editing and reset commands remain in the Project/Scoped surface.
Material assignment, Layer Range, and unknown or inaccessible native keys do not
produce this marker because this surface cannot show or reset them.

The configuration view is limited by the current selection, rather than presenting
the full slicing-precedence chain. With no Object or Volume selected, it shows
`Preset -> Project -> Plate` for the active Plate. A whole-Object or instance selection
shows `Preset -> Project -> Object`; a Part or Modifier selection shows
`Preset -> Project -> Object -> Volume`. In particular, Plate values and provenance
are shown only for an empty model selection, never as an Object/instance/Volume
selection's representative inherited value. A field badge and hover detail show only
the nearest source and chain within that visible range. This selection-limited editing
projection does not alter the canonical slicing precedence in section 3 and is not an
independently persisted UI annotation.

Project mode uses a scope-local projection: each value and source is resolved from
the base presets through the Project scope only. A Plate, Object, Part, or Modifier
override on a current selection cannot replace or appear in the Project-mode value,
source, or hover detail.

For a multi-selection resolving to one supported scope level, a parameter whose
selection-limited value or provenance differs is explicitly presented as `Mixed`.
Entering a new value writes the same local override to all selected targets atomically.
Reset erases that parameter from all selected targets atomically. The UI must never
display the first target's value as though it applied to the full selection.

The initial validation policy deliberately implements only constraints available
directly from PrintConfig: option type, allowed enum members, and deterministic
minimum/maximum bounds. A submitted value is normalized by clamping to such a bound
before the one history transaction is committed. Other parseable but semantically
questionable values are retained for now and are reported by normal slice validation
or a later, dedicated validation feature. This is intentionally narrower than
OrcaSlicer's current per-setting mix of warnings, forced corrections, and confirmation
dialogs. A clamp is non-modal and silent: after the commit the control simply reflects
the resulting effective value.

Scalar fields use appropriate dedicated controls. Every other eligible native option
type uses a text editor for the exact native serialized representation accepted by the
Worker, rather than becoming read-only or disappearing from the catalogue. The existing
Custom G-code and material-assignment exclusions still apply.

If native deserialization rejects a submitted text representation, no history entry or
configuration mutation is created. The field keeps its draft and presents a field-level
error until the user corrects it or uses Escape to restore the authoritative value.

## 13. Local-value materialization and unsupported native scopes

An explicit set always materializes a local key at the selected scope, including when
the submitted value is equal to the value that would otherwise be inherited. This
preserves the meaningful distinction between an intentional local override and no
override; only Reset erases the key.

Layer Range configuration is outside the initial Project/Scoped surface. Valid native
Layer Range overrides encountered in a normal 3MF open are opaque, preserved project
data: Neo must retain them unchanged on a later normal save and must not expose or
mutate them through this feature. Geometry-only import continues to clear them along
with all other imported scoped overrides.

## 14. Existing selection constraints remain authoritative

Scoped configuration reuses Neo's existing homogeneous scene-selection contract; it
does not create a broader configuration-only selection model. Whole Object or whole
Instance selections may span objects and resolve their object targets. A Part or
Modifier selection is valid only when all selected volumes belong to one Object and
one Instance. It may contain multiple sibling volumes, but may not span Objects or
Instances, and may not mix with an Object or Instance selection. Modifiers have no
exception to this rule.

A non-empty mixed selection has no writable Scoped target. An empty selection remains
the distinct case that resolves to the active Plate. This retains the existing
selection behaviour in both the viewport and Object List while leaving the already
specified multi-object and multi-part write semantics available only for selections
that the shared interaction controller admits.

If an invalid or mixed non-empty selection nevertheless reaches the configuration
surface, Scoped mode renders a disabled empty state explaining the required homogeneous
selection. It never falls back to the active Plate and never leaves a prior target
silently writable.

## 15. Material boundary and dependency handling

The generic Project/Scoped catalogue excludes `extruder` and every filament-rack or
filament-profile field. Object, Part, and Modifier material assignment remains solely
in Neo's existing typed filament-assignment controls and Worker commands, with their
separate rack/session and Undo/Redo semantics. The generic surface must neither
duplicate nor bypass that authority, including through its target-level Reset All.
The bridge-owned Project filament-routing slots listed in section 9.1 follow the
same boundary: their native values remain available to slicing and history, but
they do not enter the generic catalogue or resettable key set and can be changed
only by the dedicated routing commands.

Initially, every otherwise eligible parameter remains present and editable regardless
of feature dependencies on other parameters. The surface does not disable or hide a
dependent field, validate a dependency graph, or perform dependency-driven automatic
correction. The basic type, enum, and deterministic bound normalization in section 12
is the full initial validation policy; dynamic dependency handling is deferred.

Raw Custom G-code is also excluded from the initial generic catalogue. Valid native
project-level Custom G-code remains opaque, normal-save-preserved data under the
existing persistence contract, but has no generic single-line editor. A future feature
may add a dedicated multi-line editor and its appropriate validation path.

## 16. Commit, history, and dirty-state contract

Textual edits are drafts until a valid Enter or blur commit; Escape discards the draft.
A continuous control such as a slider produces one coalesced transaction when its
gesture completes. A successful multi-selection edit or reset is likewise exactly one
atomic Worker and project-history transaction for every target it covers.

Every successful configuration transaction, including an individual, category, or
all-local-overrides reset, is a normal project mutation: it participates in Undo/Redo
and marks the project dirty. Undoing back to the saved project state restores clean
status through the existing history/dirty mechanism. Project/Scoped mode, resolved
target display, selection, search, category expansion, and other configuration-surface
state are UI context only and never mark the project dirty.

## 17. React-derived configuration projection

At startup React reads the Worker-exported generic native option metadata once. It then
derives the Project/Scoped catalogue from that metadata together with the synchronized
selection, preset, plate, and scoped-configuration state: scope eligibility, category,
basic type/enum/bound presentation, and selection-limited values and provenance are
React projections rather than a dedicated Worker catalogue response. It must omit
sources below the currently selected scope as specified in section 12.

The Worker remains authoritative for native configuration storage, mutation validation,
normalization, and each committed successor state. React may not treat a locally
derived value as committed until the typed Worker command succeeds and its canonical
state has been published.

Dispatch captures the resolved target of a configuration commit. A later selection or
mode change never cancels, retargets, or discards that already-dispatched mutation.
The existing project-mutation ordering serializes committed successors; React publishes
their global canonical state monotonically and then reprojects the surface for its
current UI context. Revisions protect state ordering and stale slice results, not a
selection-dependent rejection of a valid committed configuration mutation.

An uncommitted field draft is reloaded only when that field's resolved target,
authoritative effective value, or provenance changes. A canonical update to an
unrelated field preserves the active draft. There is no client-side cross-request draft
merge: a changed current field yields to the authoritative value before the user can
commit the obsolete draft.

## 18. Native-only configuration history and performance

`project_config_overlay` is removed as live, persisted, and recoverable configuration
state. Native Project config, Plate settings, `ModelObject::config`, and
`ModelVolume::config` are the only configuration owners. Any Worker-to-React map is a
disposable projection, not an additional state root.

History must preserve exact native key membership as well as values: restoring a
predecessor that lacked a Project override must erase that key, not merge the
predecessor's keys onto live configuration. History retains the existing native object
archive sharing, immutable-mesh sharing, lazy topmost snapshots, and budget/eviction
behaviour. Ordinary edits publish an incremental committed receipt; full native
configuration projection is reserved for open, history restore, or an explicit refresh,
so removing the overlay does not reintroduce a full-project serialization cost per edit.

Project config has its own exact native history root. It is restored by replacement,
including removal of keys absent from the target root. Filament/rack history state no
longer serializes Project config; it retains only filament presets, edited filament
state, slot colours, and related rack data. The two roots remain independently
structurally shared when unchanged.

The Project history root includes both the upstream native Project options and the
bridge-owned routing slots from section 9.1. Restoring that root therefore restores
the routing authority used by the effective slice, while the generic Project/Scoped
catalogue still cannot edit or reset those slots.

The history context also records native project-embedded Print preset selection and
the parent-relative editable overrides needed to reconstruct a child after an
Undo removes it. This is native preset state, not a Neo archive member or session
sidecar. A first ordinary Project Print edit creates the child only when the
effective value actually changes; no-op edits and Project-owner routing edits do
not create one.

A user command that changes both Project config and filament/rack state creates one
atomic history entry. Restore applies both native roots together, while an unchanged
root continues to share its retained representation.

## 19. Performance baseline and fixture isolation

Before implementation, capture a performance baseline and repeat it after the change
for history capture, Undo/Redo, project open/save, and peak WASM heap. The change may
not regress those measurements and must demonstrate that sidecar archive bytes and
overlay restore/replay work are eliminated.

The primary real-project fixture is the user-designated source file
`E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf`,
SHA-256 `6DB07E50B4692F95BFEF65595E9FCD0BF902C9660B7B1D7BC1A4F98B4D7D2425`
(45,586,816 bytes when designated). It is immutable test input. Every open, slice,
save, round-trip, or benchmark run first copies it to a newly created temporary test
directory and operates only on that copy; the source file must never be opened for
write, renamed, replaced, or deleted.

Interop acceptance uses a scoped-configuration golden 3MF and temporary copies of the
primary fixture. The golden covers Project, Plate, Object, normal Part, parameter
modifier, negative/auxiliary Volume scopes, plus preservation of `extruder`, Layer
Range, and a native-recognized key that the initial UI does not edit. Neo saves a
project and the test asserts that no configuration sidecar is present. OrcaSlicer then
opens and saves that temporary project; Neo reopens the result and compares native
Project, Plate, Object, and every supported Volume scope. The comparison is key
membership and the Worker's normalized native values, not a Neo-only projection or
ZIP/XML byte identity, so legal archive ordering and serialization changes do not fail
the test. A separate negative 3MF test supplies a genuinely unknown key and asserts
the existing explicit compatibility fallback, rather than treating it as a successful
native round trip.

## 20. Projection transport and history-latency acceptance

On project open, Undo/Redo, or an explicit refresh, the Worker returns one versioned
full native scoped-configuration snapshot in the same committed response as the
project/plate/history receipt. The snapshot contains explicit local maps keyed by
stable native IDs; it does not expand inherited effective values across every entity.
React replaces its disposable projection from that snapshot. Ordinary successful
mutations return only the complete normalized local maps for affected targets plus the
monotonic revision. React replaces those target maps atomically, so erase/reset and
structural deletion are represented without an unsafe shallow merge. A revision gap
requires a full authoritative refresh.

For the primary fixture, the performance acceptance boundary is the renderer event
that invokes Undo or Redo through publication of canonical state and the next editable
rendered frame. It applies to real release/non-mock artifacts, separately to serial
and threaded WASM, and to explicitly recorded idle scenarios. Every valid measured
sample must complete within 200 ms. The warm median target is 100 ms; it does not
excuse an individual sample above the 200 ms gate. First Undo after a fresh mutation
is measured separately from warm steady state so lazy history capture cannot be hidden.

Each variant uses at least three fresh processes, five warm-up pairs per process, and
twenty measured Undo/Redo pairs per declared scenario. The benchmark records raw
samples and separate Undo/Redo distributions, Worker stages, snapshot payload sizes,
history bytes and eviction, WASM heap, and native object/mesh archive reuse. Scenarios
include transform-only, Object/Volume and Plate/Project configuration set/reset,
multi-target configuration, configured-entity delete/restore, and history jumps.
Threaded active-slice measurements are a separately reported population; a serial
`slice_busy` response is not a successful latency sample.

## 21. Device and connection settings

Device, host, and connection settings are not Project, Plate, Object, or Volume
overrides. Neo's independent Device manager and its local device repository are their
sole authority; they are not a part of a user printer profile. The dedicated Device
entry point remains outside the Project/Scoped surface. Device records and credentials
do not enter 3MF, project history, project dirty state, or project Undo/Redo.

A successful Device-manager edit persists immediately to that local device repository.
It creates neither a project/profile dirty-save lifecycle nor any Undo/Redo entry.

The existing Device-manager runtime model is retained: a complete selected device
record, including its API key, may enter the DevicePanel's in-memory renderer state to
drive the current Moonraker console and send flows. This permission does not broaden
the boundary to project state, URLs, diagnostic output, logs, or page-visible console
objects: sensitive values remain redacted or absent there.

This milestone does not change the existing relationship, if any, between Device
selection, printer presets, and Send targets. It creates no new mapping, compatibility
filter, or automatic synchronization between those subsystems.
