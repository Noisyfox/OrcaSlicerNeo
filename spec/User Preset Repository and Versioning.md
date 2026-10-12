# User Preset Repository and Versioning

**Date:** 2026-10-12

**Status:** Design only; not implemented. Sections 1-3 record accepted product
requirements. Proposed extensions and unresolved decisions are explicitly
labelled and do not constitute implementation approval.

**Scope:** Printer, Filament and Process user presets in the shared Electron
and Web application, including local repositories, account separation,
OrcaCloud synchronization, immutable versions, selectors and project history.

## 1. Existing boundaries

The [shared architecture](Web-Electron%20Shared%20Application%20Architecture.md)
owns host/runtime separation. The [Preset Editor](Preset%20Editor%20Dialog.md)
owns independent source browsing and runtime drafts;
[Scoped Configuration](Project%20and%20Scoped%20Configuration.md) owns Process
editing. [Undo and Redo](Undo%20and%20Redo.md) and
[3MF Project Persistence](3MF%20Project%20Persistence.md) own project history
and interchange. This document defines their proposed user-repository extension,
not a claim that repository or cloud features are already delivered.

Previously accepted constraints remain in force:

- Users can manage persistent presets without an account. This does not require
  a Web service worker, PWA, or guaranteed offline application startup.
- Electron stores user presets as editable files in a local folder. External
  edits have no effect until an application-initiated read, such as startup.
  Application writes overwrite the file without external-change detection or
  conflict prompts. No filesystem watcher is required.
- The local `default` library and each OrcaCloud account library are separate.
  Network loss must not be interpreted as logout or a switch of libraries.
- Shared application code uses injected host services and the runtime/client
  boundary. Native preset interpretation remains in C++.
- Reuse the native save logic with `ORC_NEO_WASM` adaptations to remove implicit
  selection; subsequent native writes must target the saved preset explicitly.
  Browsing or saving an independently edited source must not implicitly change
  project selections or bind the editor to a Filament slot.

## 2. Accepted version and transition requirements

### 2.1 Preserve old versions before replacement

Whenever a user profile is deleted or its content is updated, preserve an
immutable snapshot of the old version if any retained history references it.
Rewrite all affected non-snapshot history references to that snapshot. Existing
snapshot references remain unchanged. The model is analogous to MVCC: history
retains the version it observed, independently of the current repository head.

Repeated edits and saves of the same user profile in one session create a new
snapshot for each successful overwrite save. Earlier snapshots must not be
overwritten or coalesced into the latest version. Implementations may share
immutable equal-content storage without collapsing logical version identities.

A local Save immediately adopts the newly saved version, without an additional
history entry. The option-edit history already records the changes that the
user may undo. Undoing those edits never rewinds the saved repository head.

Profile dirty state compares the session's effective profile values against the
currently saved, non-snapshot version, not against the selected old snapshot.
For a deleted profile, compare against its last saved version immediately before
deletion. The Deleted indication is independent of dirty state. This profile
comparison does not replace the existing project-file saved-checkpoint rules.

Field, category and preset Reset use the latest saved version as their value
baseline, or the last saved pre-deletion version when the profile is deleted.
Reset must not obtain obsolete values from the selected old snapshot merely
because it remains the session source. Reset and version adoption are separate
operations; the exact scope of full Reset adoption is an open decision below.

### 2.2 Manual deletion

A successful explicit Delete action switches to the next available profile and
creates a corresponding project-history entry. Undo returns to the previous
profile's snapshot, labelled **Deleted**. Undo must not restore the deleted
configuration file or republish the profile to the account. Redo restores the
replacement selection, not another repository deletion. A system-profile
replacement is always available by product design; the transition must use
native availability/compatibility rules rather than invent an empty state or a
new no-replacement product flow.

Deleting a profile browsed in the independent editor but unused by the project
only changes the editor's browsing target. It does not switch the project's
profile or create a project-history entry. Existing historical references still
undergo snapshot migration.

A deleted snapshot only offers Save As to create a new user profile. Ordinary
Save must not recreate its deleted repository record. Undo/Redo likewise never
recreates its file or enqueues an upload.

### 2.3 Deletion received through synchronization

If synchronization deletes the active profile, keep its effective configuration
and selection in place by converting it to the old-version snapshot. Show
**Deleted**. Do not choose a replacement, append a history entry, move the
history cursor, or create a corresponding Redo action. Retained references are
still migrated under section 2.1.

### 2.4 Updated profile and explicit adoption

If the selected profile receives an update, retain its current version and show
**Update available** with an adjacent Update action. Only an explicit Update
action selects the latest saved version and creates the corresponding history
entry. Preserve the displaced version as an immutable snapshot. Update changes
all active references to this profile in the session together, including every
Filament slot sharing it, as one history operation.

When there are unsaved parameter edits, ask the user what to do before adopting
the update. Neither discarding nor rebasing edits is an automatic default; the
precise choices remain to be confirmed. Cancelling must leave the session intact.

Before that explicit adoption, every profile-selection surface in the current
session must resolve this profile to its retained snapshot, rather than expose
an ordinary selection path to the latest version. This includes selectors
outside the surface where the update was first noticed. Undo to an older version
also restores this session-wide selector pin and the Update available state;
Redo can restore the adopted version. Neither navigation changes the repository
head.

Repository changes and transparent reference migration do not themselves create
project-history entries. Explicit manual deletion and explicit adoption are the
project actions described above.

## 3. Observable state and examples

The accepted rules distinguish three independent states:

| State | Meaning |
| --- | --- |
| Selected version | The immutable content plus session edits currently used by the project/editor. |
| Repository head | The current saved, non-snapshot version, or absence after deletion. |
| Profile dirty | Effective parameter differences from the repository head, or the final pre-deletion baseline. |

Update available and Deleted are version/lifecycle indications, not aliases for
dirty. An unchanged old snapshot can be dirty relative to a newer head even
with no local overlay. Conversely an overlay can produce values equal to the
head, making the profile clean. React cannot infer dirty from overlay presence.
Parameter highlighting and modified-first ordering must consume native
comparison results. UI copy remains English under the repository's current
language policy; Update available and Deleted represent the requested labels.

The comparison is native parameter comparison, including vector/index ownership
where relevant, rather than equality of JSON bytes or version IDs. Filenames,
cloud timestamps and lifecycle labels alone do not make profile parameters dirty.
The update dialog's detection of actual unsaved edits must not be implemented
as a blind test of head-relative dirty: a retained old version can differ from
head without the user having edited it.

### 3.1 Local save followed by Undo

1. Head V1 has temperature 200. An option edit changes the session value to 210
   and creates history entry E1.
2. Save preserves V1, publishes head V2 at 210, migrates references to V1, and
   immediately adopts V2. No E2 is created. Profile dirty becomes false.
3. Undo E1 restores the appropriate old snapshot and value 200. Head V2 stays
   at 210; profile dirty becomes true and the old session version is updateable.
4. Redo restores value 210 and the corresponding version pin. The configuration
   file and synchronization queue are unaffected by either navigation.

### 3.2 Several saves

Saving V1 -> V2 -> V3 preserves distinct old-version snapshots. A history item
already bound to V1 must stay bound to V1 when V2 is replaced. Only references
still bound to the outgoing head are migrated. Undo must not make V1 resolve to
V2 simply because both have the same display name.

### 3.3 Manual and synchronized deletion

Manual deletion of active P selects Q and creates one history entry. Undo
selects P's Deleted snapshot and Redo selects Q. P remains absent on disk and
in the cloud throughout navigation. Synchronization deleting active P keeps P's
effective values as a Deleted snapshot, with no added history entry or new
Redo operation. Pre-existing Redo entries are retained and migrated.

### 3.4 Several remote updates

When a session remains on V1 while head advances V2 -> V3, selectors continue to
offer the session's V1 for that identity. Update targets the latest validated
head at commit time, not an obsolete version captured when the button appeared.
If the head changes while an edit-resolution dialog is open, the operation must
revalidate and refresh the decision rather than silently apply a different
target. The exact conflict-dialog choices are pending section 10.

## 4. Proposed version model and ownership

This section is an implementation proposal, not a second parameter model in
TypeScript. Native configuration continues to own values, inheritance,
compatibility and effective-configuration assembly.

- Give a profile a library-scoped stable identity distinct from its name, file
  path and cloud setting ID. Distinguish a new incarnation after deletion from
  the old identity, even if a name or cloud ID is reused.
- Give every saved revision and retained snapshot an immutable identity. A
  reference must identify a head or an exact snapshot, never just a display
  name. The current name-only internal contract must be replaced coherently
  across producers, consumers, mocks and tests; do not add legacy fallbacks.
- Maintain a session version binding for each encountered profile. All
  selectors and native implicit-resolution paths consult it. History captures
  these bindings so Undo can restore the complete pinned view.
- Retain version-specific drafts. Replacing a head must not reapply an old
  sparse overlay to a different baseline. For a shared Filament version, slots
  continue sharing one source-local draft.
- Preserve enough old native content and dependency information to reconstruct
  the version independently of later parent updates or deletions. A snapshot
  containing only a name and delta against a mutable parent is insufficient.
- Separate the last saved pre-deletion baseline from an older selected
  snapshot. If V3 is deleted while the session uses V1, dirty compares V1's
  effective values against V3, not against V1.
- Use a separate synchronization deletion record and a retained content
  snapshot. A server deletion acknowledgement can clear retry work without
  freeing data still referenced by the session or history.

Snapshot materialization may use native project-embedded profiles, but those
objects must preserve explicit snapshot identity and update/deleted status.
They are never normal writable user records. Embedded projection must not hide
the status by collapsing a Process snapshot into an apparently current source
row. No UI parses status suffixes out of profile names.

## 5. Scenario coverage

Rows marked Pending require the decision in section 10. Other extensions in
this section are proposed consequences of the accepted rules, rather than a
claim of delivered behaviour.

### 5.1 Saving, editing and importing

| Scenario | Required result or proposed handling |
| --- | --- |
| Edit an option without saving | Existing option history and version-specific draft behaviour; repository head unchanged. |
| Save current user profile | Snapshot outgoing saved version, migrate non-snapshot history references, write/adopt new head; no extra history. |
| Repeated saves | Distinct logical snapshot per successful overwrite save; prior snapshots untouched. |
| Save while cursor is before existing Redo | Saving is not a new project operation and must not erase Redo; migrate its references as well. A preceding actual option edit still has normal Redo-truncation semantics. |
| Save an independently browsed profile | Save/adopt that editor source without selecting it in the project. Shared active references, if present, remain consistent with the new saved version. |
| Save As from system, embedded or snapshot source | Create a separate user identity using native serialization; do not install or overwrite the original source implicitly. Post-save selection needs the existing independent-editor boundary. |
| Save from a Deleted snapshot | Save As only; old identity remains deleted. |
| Save an old snapshot while a newer head exists | Pending D3: explicit overwrite versus additional overwrite confirmation. Preserve outgoing head, not only the session's older snapshot. |
| Import with a new identity | Add to the library without switching the current project automatically. |
| Import over an existing user identity | Treat as a head update after normal overwrite confirmation; retain observed old versions and show updates to existing sessions. |
| Same JSON discovered again | A read of unchanged content is not a new save and must not manufacture snapshot events. |
| External file change | No immediate effect. A later deliberate read reconciles it as an update/deletion; application writes may overwrite it before that read. |
| Malformed external/imported data | Do not publish it as a valid head or destroy a previously valid session version; report parsing/validation failure. |
| Field/category Reset on old version | Copy the selected fields from current head, or final pre-deletion baseline. Keep unrelated values. Full Reset binding is Pending D4. |

### 5.2 Delete and identity changes

| Scenario | Required result or proposed handling |
| --- | --- |
| Manually delete active Printer/Process | Select native usable replacement including system profiles; one composite history entry including dependent normalization. |
| Manually delete active Filament shared by slots | Replace all active references coherently; retain slot identities and apply native source-transition rules in one history entry. |
| Delete editor-only source | Advance editor target only; no project-selection change or project-history entry. |
| Delete a source referenced only by Undo/Redo | Migrate those references despite no current selection. Undo can still reach the Deleted snapshot. |
| Remote deletion with active edits | Preserve current effective values and drafts on the Deleted snapshot; do not transfer them to another profile. |
| Remote deletion with an existing Redo branch | Preserve the branch, migrating affected references; do not create a deletion entry. |
| Repeated remote deletion / local-delete acknowledgement | Idempotent repository reconciliation; no duplicate snapshot, history or UI transition. |
| Delete several profiles together | Stage the complete set before choosing surviving replacements; do not temporarily select another member of the deletion batch. One explicit user action should publish one composite history entry. |
| Delete a parent still used by user children | Pending D5: child dependency policy; snapshot reconstruction must remain possible regardless. |
| Rename | Pending D5: retain stable identity; update name-based native dependencies coherently. Never conflate rename with unconditionally deleting an unrelated same-name record. |
| Recreate an old name | New identity/incarnation; historical Deleted snapshots do not automatically reconnect or become writable. |

### 5.3 Update and adoption

| Scenario | Required result or proposed handling |
| --- | --- |
| Remote update to active profile | Preserve old version and effective values; show Update available and use pinned candidates everywhere; no new history. |
| Update an inactive source referenced by history or drafts | Preserve referenced versions. An unvisited, unreferenced new source may be introduced at the current head. |
| Click Update with no unsaved parameter edits | Adopt latest head for all active references in one history entry. |
| Click Update with unsaved edits | Ask user; cancel is side-effect free. Exact alternatives are Pending D1. |
| Update clicked in an independent editor for a project-unused source | Pending D2: browsing independence versus the requirement that explicit Update creates history. |
| Several head updates before adoption | Retain session pin; advertise latest head. Unobserved intermediate revisions need not become artificial project-history entries. |
| Undo adoption | Restore old version, drafts and session-wide selector pin. Dirty compares with the current head, which Undo does not change. |
| Redo adoption after another remote update | Restore the version originally adopted by that history entry, not whatever is newest now; show another update if necessary. |
| Remote deletion while Update is being confirmed | Revalidate; cannot adopt a deleted head. Preserve session and present Deleted state. |
| Updated Printer changes capabilities/compatibility | At explicit adoption, native normalization handles Process/rack/bed changes atomically in the same history entry. |
| Updated Filament changes default colour | Use the accepted source-transition and actual-slot-colour policy; undo restores captured colours, not current defaults. |
| Update causes no effective slicing-input change | Version/history semantics still apply; avoid invalidating results solely for a repository notification. Validate against existing native invalidation rules. |
| Parent content changes effective child content | Pending D5: derived-version notification/adoption policy; never silently mutate a retained snapshot. |

## 6. Every selection and restoration path

A shared widget alone cannot enforce the rule: candidate construction and native
resolution must also obey the session's selected revision. Required coverage:

| Surface/path | Version-aware responsibility |
| --- | --- |
| Printer selector | Native candidate identity, selected label, Deleted/Update available status, Update action. |
| Printer model/nozzle variant resolution | No same-name/model fallback that bypasses a pending version pin. |
| Process selector | Preserve snapshot command identity even when a project child shares its source's display row. |
| Every Filament slot selector | Same retained revision for the same session profile; shared Update action and consistent dirty state. |
| Independent Printer/Filament editor source picker | Browse pinned versions without changing project selection; refresh after save, history navigation and head changes. |
| Future user-preset manager, duplicate and Save As source pickers | Expose status explicitly; never use selection of a normal-looking row as implicit latest-version adoption. |
| Remembered racks and native compatibility fallbacks | Resolve through the session binding before native validation; do not seed a newer version accidentally. |
| Undo/Redo and direct history navigation | Restore exact snapshot and pin, then native configuration/draft/slot state. |
| Startup, New/Open Project and account switches | Explicit lifecycle boundary; Pending D6, not an accidental renderer reset. |
| Setup Wizard | Existing activation/history-reset policy remains separate; Pending D6 for retained version bindings across that reset. |
| 3MF load | Preserve archived effective values without installing user presets; Pending D7 for version identity and update indications. |

Update controls must work with pointer and keyboard and expose accessible state
and action names. Disabled/mutation states must prevent duplicate adoption. Both
hosts share the same behaviour. Mobile product support stays deferred under the
shared architecture; status/action layout must not prevent the existing desktop
controls from scrolling or receiving focus.

## 7. History migration and resource lifetime

Proposed migration order:

1. Resolve the outgoing head and retain its exact native content/version.
2. Collect references from every retained timestamp on both sides of the
   cursor, the saved checkpoint, live uncaptured top, drafts and session pins.
3. Rewrite only references to that outgoing head. Preserve references already
   bound to snapshots and each frame's distinct overrides/effective values.
4. Stage the repository change and corresponding live projection. Manual
   active deletion/adoption also stages its single project-history entry;
   transparent migration and Save do not.
5. Publish coherently or retain recoverable state on failure. Never expose
   history references to a snapshot that has not been retained successfully.

This needs a narrow history-root migration facility rather than re-running
project commands for every frame. Reuse immutable model/mesh archives; changing
preset references must not rewrite geometry or alter entry labels/timestamps.
Account/library scope belongs to references so navigation cannot accidentally
resolve an old account's name in a new account's library.

Restore must materialize referenced versions before validating draft sources,
reconstructing Process embedded records, selecting Printer or restoring slots.
It must not install a snapshot into the durable user repository or enqueue cloud
writes. Native embedded cleanup must not delete still-referenced snapshots.

Status is resolved against the current repository lifecycle, not restored from
old UI booleans. A history frame captured before a later deletion still displays
Deleted after navigation. A recorded adoption of V2 can display Update available
after head reaches V3, without changing that frame's V2 content.

Do not evict a snapshot independently while any retained frame, live selection,
draft or in-flight prepared operation needs it. Account for retained content in
the history resource budget; share immutable payloads and release references as
history is evicted. Pending cloud deletion retry and project-history retention
have different release conditions.

Profile dirty is recalculated against the live head after navigation. Historical
UI dirty booleans must not override that comparison. Project-file dirty remains
owned by the saved history checkpoint: transparent migration and Save preserve
it; manual active deletion and explicit project Update are normal history
operations. The existing specification must explicitly allow reference migration
without pretending it is a new project operation.

## 8. Storage, synchronization and project interchange

Proposed repository adapters are Electron JSON folders and Web IndexedDB under
one shared contract. Keep account credentials outside profile files. Use native
serialization for inherited/sparse/vector configuration; do not serialize form
state or the complete assembled project as a user profile.

Persist saved user content, synchronization baselines and pending operations
reliably. Session snapshots and undo history do not become a new global preset
library. A restart is not assumed to persist the Undo/Redo timeline. Exact
snapshot lifetime across New/Open Project is Pending D6.

Cloud updates use version-aware reconciliation; the external-file overwrite
rule does not remove cloud concurrency checks. A response acknowledges only the
local version it sent. Changes made while a request is in flight stay pending.
Pull cursor advancement must follow reliable application of its change set;
retries must not duplicate history or cause a local-delete acknowledgement to
resurrect a profile. Login failure and network loss leave the active local
library usable without switching identities.

Switching accounts is not cloud deletion. Preserve needed old-library content
for the project/history, but do not enqueue deletion against the old account.
Late replies must remain scoped to their originating account and session.
First-login copying from `default`, name collisions and whether to switch a
currently used copied preset need explicit migration UX before implementation.

3MF export must preserve active effective Printer, Filament and Process values,
including snapshot-backed selections, through the normal embedded-profile path.
It must not export the whole history or install snapshots into the recipient's
library. Secure-export exclusions remain unchanged. Exact cross-session
provenance, status labels and matching against an installed newer head are
Pending D7. Geometry-only import leaves this project's version bindings intact.

## 9. Atomicity and integration constraints

- At a repository/head transition, prepare validation, snapshot retention and
  reference migration before making the old head unavailable.
- File/IndexedDB failure does not report Save success or clear profile dirty.
  Do not add a snapshot/save event for a failed write. A crash between durable
  commit and runtime publication needs deterministic recovery, not silent loss.
- Run migrations at a safe Worker command boundary, outside another native
  history transaction. Slicing, editor mutations and history navigation must
  never see a partially migrated catalogue.
- Revalidate library identity, selected version and latest head after async
  dialogs/requests. Preserve the actual selected version while a dialog is open.
- Snapshot replacement with identical effective values does not itself change
  geometry, slot colours, flushing state or slice inputs. Explicit adoption and
  replacement use existing native normalization/invalidation paths.
- Runtime/client/native snapshots must carry version identity, lifecycle status,
  latest-head availability and native dirty results. Update producers,
  consumers, mocks and tests together; no dual old/new internal payloads.
- Keep session/controller logic out of React field components. All hosts use
  the same lifecycle rules; only persistent storage and auth/network transport
  differ.
- User profile versioning does not automatically redesign vendor package
  updates, community bundle subscriptions or the Setup Wizard's system-profile
  activation semantics.

## 10. Open product decisions

The following recommendations are **not accepted requirements**. Resolve them
before dependent implementation; unrelated documented work can proceed.

| ID | Decision | Proposed direction / alternatives |
| --- | --- | --- |
| D1 | Update with unsaved edits | Offer discard-and-update, transfer edits onto latest, and Cancel; optionally Save As first. If transfer is supported, decide per-key conflict handling and vector/dependency validation. The accepted requirement is to ask, not silently choose. |
| D2 | Update an editor-only profile | Keep project selection unchanged. Decide whether this editor-only adoption creates project history or behaves like browsing; the accepted active-profile Update rule must not accidentally switch the project. |
| D3 | Save from an outdated but not deleted snapshot | Decide whether Save explicitly overwrites the latest head with current effective values, or asks for confirmation/Save As. Preserve newer outgoing head and avoid implicit merge. |
| D4 | Reset preset on an old snapshot | Field/category reset uses head values while retaining unaffected fields. Decide whether full Reset also adopts head identity and clears Update available, or retains the old pin with clean values. |
| D5 | Rename and inherited user profiles | Decide whether rename is a version update requiring adoption; whether manual parent deletion is blocked while user children exist; and whether a parent update creates effective child revisions and Update available indications. |
| D6 | Session boundaries | Recommend New/Open Project initializes a new version-binding view while a loaded 3MF preserves its values. Decide whether pins survive switching projects, successful Setup Wizard activation, and account switch. |
| D7 | 3MF provenance across sessions/devices | Decide whether archives preserve stable user identity/version/deleted status or reopen as ordinary embedded profiles with only effective values. Determine when a newer installed head is offered without same-name rebinding. |

## 11. Acceptance coverage

Implementation must cover the accepted rules and resolved decisions with tests
at the layers specified by the [testing guidelines](../doc/testing_guidelines.md).
Required behavioural cases include:

- Independent local/default and account libraries on both hosts; restart
  persistence; no-account usage; external edit ignored until read; direct
  application overwrite without external conflict prompts.
- Printer, Filament and Process local Save; repeated saved versions; Save adds
  no history; option Undo restores old content but leaves the latest file and
  cloud head intact; existing Redo survives Save.
- Remote update/delete with active, inactive, editor-only, draft-only and
  history-only references; multiple versions and multiple shared slots.
- Manual deletion yields a native system-capable replacement and one history
  operation; Undo/Redo changes selection only and never recreates files/uploads.
- Explicit Update changes all active references once; Undo/Redo restores exact
  version pins in every picker; intervening cloud updates do not change a
  recorded Redo target.
- Dirty/highlight/order computed against latest head; final pre-deletion
  baseline; empty overlays that are dirty and nonempty overlays that are clean;
  field/category/full reset according to D4.
- Update dialog cancel and all choices resolved under D1; concurrent newer
  update, deletion or account switch while awaiting a decision.
- Native inheritance, multi-toolhead vectors, Process ownership, rack colours,
  flushing, compatibility and bed normalization across save/update/navigation.
- Reused names/cloud identifiers never reconnect old Deleted snapshots;
  dependency and rename cases resolved under D5.
- Current and uncaptured history roots, both navigation directions, saved
  checkpoint, direct history jumps, history eviction and retained snapshot
  lifetime. No geometry archive duplication from reference migration.
- 3MF effective-value round trip, geometry-only import and cross-account
  scenarios resolved under D6/D7.
- Failed validation/write/publication, duplicate cloud changes, interrupted
  commit recovery and stale responses. No partially published history or head.

Shared logic is verified at the lowest useful layer; host-specific persistence
requires Electron/Web coverage and the common bridge requires both WASM variants
at the appropriate handoff gate. This design document does not claim any of
those product checks have run or passed.
