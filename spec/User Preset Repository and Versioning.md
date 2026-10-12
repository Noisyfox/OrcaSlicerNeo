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
- Follow Orca's naming workflow: provide Save As and Delete, without adding an
  identity-preserving direct Rename action. A new-name save creates a separate
  user profile; it does not delete the original automatically.

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

Saving from an outdated snapshot requires confirmation before overwriting the
newer head. Offer Overwrite, Save As and Cancel. Overwrite uses the current
effective values and preserves the outgoing newer head as well as already
retained older versions. It does not implicitly merge them. This confirmation
concerns a known repository update, not an undetected external file edit.

Profile dirty state compares the session's effective profile values against the
currently saved, non-snapshot version, not against the selected old snapshot.
For a deleted profile, compare against its last saved version immediately before
deletion. The Deleted indication is independent of dirty state. This profile
comparison does not replace the existing project-file saved-checkpoint rules.
Account-switch snapshots use the frozen baseline defined in section 2.5.

Field, category and preset Reset use the latest saved version as their value
baseline, or the last saved pre-deletion version when the profile is deleted.
Reset must not obtain obsolete values from the selected old snapshot merely
because it remains the session source. Field/category Reset only resets the
corresponding values. Full Reset preset also adopts the latest saved version
identity and clears Update available, in one Reset history entry. For a deleted
profile, full Reset keeps snapshot identity and Deleted status while restoring
the final saved values; it cannot recreate the repository record.
Full Reset acts on every active reference to the profile in the session,
including shared Filament slots, as that single history operation. Invocation
from the independent editor does not select an otherwise unused profile in the
project.

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
**Update available** with an adjacent Update action. Clicking Update explicitly
adopts the latest saved version and creates the corresponding history entry.
Ordinary selection cannot bypass adoption; local Save and full Reset have the
separate adoption rules in section 2.1. Preserve the displaced version as an
immutable snapshot. Update changes all active references to this profile in
the session together, including every Filament slot sharing it, as one history
operation.

When there are unsaved parameter edits, offer three choices:

- Discard edits and update: use the latest saved values.
- Keep edits and transfer to latest: actual user-edited fields take precedence;
  all other fields use the latest saved values. Native validation must succeed
  before publication; failure stops the update and preserves the session.
- Cancel: leave the session intact.

Head-relative dirty differences alone are not user edits to transfer. Native
field/index ownership and the recorded draft edits determine the transfer set.
Successful adoption, including transferred edits and native normalization, is
one history operation across all active references.

Before that explicit adoption, every profile-selection surface in the current
session must resolve this profile to its retained snapshot, rather than expose
an ordinary selection path to the latest version. This includes selectors
outside the surface where the update was first noticed. Undo to an older version
also restores this session-wide selector pin and the Update available state;
Redo can restore the adopted version. Neither navigation changes the repository
head.

A profile never used by the current session, either in active project references
or in retained history, follows the latest head automatically and silently.
Merely browsing it in the independent editor does not make it used and must not
pin an obsolete version or introduce an Update button/history entry. A profile
referenced only by history does not qualify for this exception; preserve its
historical versions. Clicking Update for such a history-only profile in the
independent editor updates its session version binding and creates one history
entry without changing the project's current profile selection. Undo/Redo
restores that binding just as for an active-profile adoption.
Editing that records a source in history is use; it is no longer merely browsing.

Repository changes and transparent reference migration do not themselves create
project-history entries. Explicit manual deletion and explicit adoption are the
project actions described above.

### 2.5 Account switches

On an account switch, convert **all** current user-preset references and all
user-preset references in retained history from the outgoing library to
snapshots, even if an identically named or otherwise matching preset exists in
the incoming library. Preserve references already bound to snapshots and each
reference's exact effective values and edits. Migrate both Undo and Redo sides,
not only the current project selection or records missing from the new library.

This is transparent reference migration, with no new project-history entry or
implicit selection of the incoming account's presets. Switching accounts does
not delete outgoing records and must not label them Deleted merely because
their library is inactive. Network loss alone is not an account switch.

For these detached snapshots, dirty uses the owning library's last saved
version at the time of the switch. Saving offers only Save As into the current
library. Switching back to the original account does not automatically restore
the association. This frozen comparison baseline is distinct from an ordinary
old-version snapshot that still compares against its active library's live head.
An already deleted profile retains its final pre-deletion baseline.

### 2.6 Inherited user profiles

Block manual deletion of a parent while user child presets still inherit it,
following Orca's existing restriction. If a parent content update changes a
child's effective values, process the child's effective version change through
the same used/unused rules: preserve used versions and offer adoption, or
silently refresh a never-used child. A retained child snapshot must include
enough dependency content to remain stable when its parent changes.

If synchronization deletes a parent, preserve the child's original effective
configuration so the child remains usable. The parent deletion must not cascade
into silently deleting or changing child configurations. How to persist the
child's now-missing dependency is an implementation choice subject to native
serialization and the accepted effective-value preservation requirement.

### 2.7 Project boundaries and 3MF

New Project and Open Project establish a new session version-selection view.
Do not carry the previous project's pins into the new project. Successful Setup
Wizard activation retains its existing history-clear rule and establishes a
new baseline from the current effective parameters. These boundaries do not
authorize silently adopting newer values over the project's effective values.

3MF uses Orca's existing format to preserve active effective configurations.
Do not add Neo-specific revision identities, snapshot provenance or Deleted
markers. Reopening follows the ordinary embedded-profile path; it does not
reconstruct the old session's MVCC history or reconnect user presets merely
because their names match installed records. Geometry-only import does not
start a new project or replace its version-selection view.

## 3. Observable state and examples

The accepted rules distinguish three independent states:

| State | Meaning |
| --- | --- |
| Selected version | The immutable content plus session edits currently used by the project/editor. |
| Repository head | The current saved, non-snapshot version, or absence after deletion. |
| Profile dirty | Effective parameter differences from the live head, final pre-deletion baseline, or frozen pre-switch saved baseline, as applicable. |

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
target. Use the edit-resolution choices in section 2.4.

### 3.5 Unused versus historical sources

An editor that only browses unused P at V1 silently shows V2 when P updates.
There is no project-history entry or version pin just from browsing. If retained
history used P at V1, updating the repository must preserve that historical V1,
even when P is not currently selected. Undo must not resolve that frame to V2.

### 3.6 Account switch with matching names

Account A and account B can both contain a preset named P. Switching A -> B
retains A's active and historical P versions as snapshots; none becomes B's P
through name matching. Actual Deleted status, if already applicable, survives.
Returning to A does not automatically reconnect these snapshots. Their Save As
action creates a new user identity in the currently active library.

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
- Maintain a session version binding for profiles used actively or by retained
  history. All selectors and native implicit-resolution paths consult it.
  Merely browsing an unused profile follows head without creating a pin.
  History captures bindings so Undo can restore the complete pinned view.
- Retain version-specific drafts. Replacing a head must not reapply an old
  sparse overlay to a different baseline. For a shared Filament version, slots
  continue sharing one source-local draft.
- Preserve enough old native content and dependency information to reconstruct
  the version independently of later parent updates or deletions. A snapshot
  containing only a name and delta against a mutable parent is insufficient.
- Separate the last saved pre-deletion baseline from an older selected
  snapshot. If V3 is deleted while the session uses V1, dirty compares V1's
  effective values against V3, not against V1.
- Retain the last saved baseline when an account switch detaches a reference.
  Do not reuse a later head from another library or silently reconnect it after
  switching back. Detached, deleted and outdated are distinct lifecycle states.
- Use a separate synchronization deletion record and a retained content
  snapshot. A server deletion acknowledgement can clear retry work without
  freeing data still referenced by the session or history.

Snapshot materialization may use native project-embedded profiles, but those
objects must preserve explicit snapshot identity and update/deleted status.
They are never normal writable user records. Embedded projection must not hide
the status by collapsing a Process snapshot into an apparently current source
row. No UI parses status suffixes out of profile names.

## 5. Scenario coverage

This matrix applies the accepted rules to related scenarios. Handling not
explicitly established in sections 1-3 remains a proposed consequence, rather
than a claim of delivered behaviour or implementation approval.

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
| Save an old snapshot while a newer head exists | Confirm Overwrite, Save As or Cancel. Overwrite preserves outgoing newer head, not only the session's older snapshot; successful Save adds no history. |
| Import with a new identity | Add to the library without switching the current project automatically. |
| Import over an existing user identity | Treat as a head update after normal overwrite confirmation; retain observed old versions and show updates to existing sessions. |
| Same JSON discovered again | A read of unchanged content is not a new save and must not manufacture snapshot events. |
| External file change | No immediate effect. A later deliberate read reconciles it as an update/deletion; application writes may overwrite it before that read. |
| Malformed external/imported data | Do not publish it as a valid head or destroy a previously valid session version; report parsing/validation failure. |
| Field/category Reset on old version | Copy corresponding fields from current head, or final pre-deletion baseline; keep unrelated values and version pin. |
| Full Reset preset on old version | Restore latest saved values and adopt latest identity for all active references in one Reset history entry; clear Update available. A Deleted snapshot stays Deleted and uses the final pre-deletion baseline. |
| Reset a snapshot detached by account switch | Use its frozen saved baseline, retaining detached identity; do not reconnect or write to the previous account. |

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
| Delete a parent still used by user children | Block manual deletion. If synchronization deletes the parent, preserve each child's original effective configuration and its reconstructable historical versions. |
| Change a preset's name | Save As creates a separate identity and retains the original. No direct Rename action; deleting the original is a separate explicit operation. |
| Recreate an old name | New identity/incarnation; historical Deleted snapshots do not automatically reconnect or become writable. |

### 5.3 Update and adoption

| Scenario | Required result or proposed handling |
| --- | --- |
| Remote update to active profile | Preserve old version and effective values; show Update available and use pinned candidates everywhere; no new history. |
| Update a never-used source, including a browsed-only source | Silently follow latest head; no pin, update prompt or project history caused by browsing. |
| Update an inactive source referenced by history | Preserve referenced versions; it does not qualify as unused. |
| Click Update with no unsaved parameter edits | Adopt latest head for all active references in one history entry. |
| Click Update with unsaved edits | Offer discard-and-update, transfer actual edits onto latest, and Cancel. Native validation failure aborts transfer; successful adoption is one history entry. |
| Update clicked in an independent editor for a history-only source | Update session binding in one history entry; project selection stays unchanged. Never-used sources already follow head silently. |
| Several head updates before adoption | Retain session pin; advertise latest head. Unobserved intermediate revisions need not become artificial project-history entries. |
| Undo adoption | Restore old version, drafts and session-wide selector pin. Dirty compares with the current head, which Undo does not change. |
| Redo adoption after another remote update | Restore the version originally adopted by that history entry, not whatever is newest now; show another update if necessary. |
| Remote deletion while Update is being confirmed | Revalidate; cannot adopt a deleted head. Preserve session and present Deleted state. |
| Updated Printer changes capabilities/compatibility | At explicit adoption, native normalization handles Process/rack/bed changes atomically in the same history entry. |
| Updated Filament changes default colour | Use the accepted source-transition and actual-slot-colour policy; undo restores captured colours, not current defaults. |
| Update causes no effective slicing-input change | Version/history semantics still apply; avoid invalidating results solely for a repository notification. Validate against existing native invalidation rules. |
| Parent content changes effective child content | Apply the same used/unused rules to the child's effective revision: retain used versions and offer adoption; silently update never-used children. |

### 5.4 Orca reference behaviour for naming and inheritance

The checked native [save entry](../packages/slicer-wasm/cpp/src/slic3r/GUI/Tab.cpp)
uses `SavePresetDialog` and calls `PresetCollection::save_current_preset`.
The [collection implementation](../packages/slicer-wasm/cpp/src/libslic3r/Preset.cpp)
overwrites an existing writable target or inserts a new preset under a new name,
clearing its cloud setting ID and preserving the original preset. Changing the
name in this dialog is therefore Save As, not an identity-preserving rename of
an ordinary Printer, Filament or Process preset. Neo follows this workflow and
does not add a direct Rename action.

The same native GUI rejects manual deletion when another preset inherits the
target. Neo adopts this restriction. Its additional parent-induced child
versioning and cloud-deletion preservation rules are defined in section 2.6;
native reload alone cannot preserve this document's version pins.

## 6. Every selection and restoration path

A shared widget alone cannot enforce the rule: candidate construction and native
resolution must also obey the session's selected revision. Required coverage:

| Surface/path | Version-aware responsibility |
| --- | --- |
| Printer selector | Native candidate identity, selected label, Deleted/Update available status, Update action. |
| Printer model/nozzle variant resolution | No same-name/model fallback that bypasses a pending version pin. |
| Process selector | Preserve snapshot command identity even when a project child shares its source's display row. |
| Every Filament slot selector | Same retained revision for the same session profile; shared Update action and consistent dirty state. |
| Independent Printer/Filament editor source picker | Browse pinned used versions without changing project selection; never-used sources silently follow latest. Refresh after save, history navigation and head changes. |
| Future user-preset manager, duplicate and Save As source pickers | Expose status explicitly; never use selection of a normal-looking row as implicit latest-version adoption. |
| Remembered racks and native compatibility fallbacks | Resolve through the session binding before native validation; do not seed a newer version accidentally. |
| Undo/Redo and direct history navigation | Restore exact snapshot and pin, then native configuration/draft/slot state. |
| Startup and New/Open Project | Establish a new version-selection view; restore opened project values without carrying over the previous project's pins. |
| Account switches | Convert all outgoing current/history user-preset references to snapshots; preserve effective values, history and account scope. Use frozen saved baseline and Save As only; no automatic reassociation when returning. |
| Setup Wizard | Keep existing history-clear behaviour and establish a baseline from current effective parameters. |
| 3MF load | Restore effective values through ordinary embedded handling, without Neo version/deletion metadata or same-name user-library reassociation. |

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
Account-switch-detached snapshots retain their detached state and frozen
baseline instead of resolving through whichever account happens to be active.

Do not evict a snapshot independently while any retained frame, live selection,
draft or in-flight prepared operation needs it. Account for retained content in
the history resource budget; share immutable payloads and release references as
history is evicted. Pending cloud deletion retry and project-history retention
have different release conditions.

Profile dirty is recalculated against the applicable baseline after navigation:
live head, final pre-deletion version, or frozen pre-switch saved version.
Historical UI dirty booleans must not override that comparison. Project-file
dirty remains owned by the saved history checkpoint: transparent migration and
Save preserve it; manual active deletion and explicit project Update are normal history
operations. The existing specification must explicitly allow reference migration
without pretending it is a new project operation.

## 8. Storage, synchronization and project interchange

Proposed repository adapters are Electron JSON folders and Web IndexedDB under
one shared contract. Keep account credentials outside profile files. Use native
serialization for inherited/sparse/vector configuration; do not serialize form
state or the complete assembled project as a user profile.

Persist saved user content, synchronization baselines and pending operations
reliably. Session snapshots and undo history do not become a new global preset
library. A restart is not assumed to persist the Undo/Redo timeline. New/Open
Project creates a fresh version-selection view; release old session snapshots
only once their history, draft and in-flight operation owners have released them.

Cloud updates use version-aware reconciliation; the external-file overwrite
rule does not remove cloud concurrency checks. A response acknowledges only the
local version it sent. Changes made while a request is in flight stay pending.
Pull cursor advancement must follow reliable application of its change set;
retries must not duplicate history or cause a local-delete acknowledgement to
resurrect a profile. Login failure and network loss leave the active local
library usable without switching identities.

Switching accounts is not cloud deletion. Convert all outgoing-library current
and historical user-preset references to snapshots under section 2.5, rather
than retaining only records missing from the incoming library. Do not enqueue
deletion against the old account or silently adopt matching incoming presets.
Late replies must remain scoped to their originating account and session.
First-login copying from `default`, name collisions and whether to switch a
currently used copied preset need explicit migration UX before implementation.

3MF export must preserve active effective Printer, Filament and Process values,
including snapshot-backed selections, through the normal embedded-profile path.
It must not export the whole history or install snapshots into the recipient's
library. Secure-export exclusions remain unchanged. Do not persist Neo-specific
revision identity or Deleted markers, or re-associate by matching user-preset
names on reopen. Geometry-only import leaves this project's version bindings
intact.

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

## 10. Implementation boundaries still requiring design

The version-transition questions are resolved in sections 1-3. This does not
approve an implementation or settle every repository/cloud integration detail.
Before implementing the dependent areas, complete the following designs:

- Stable local/cloud identity mapping, durable revision metadata, atomic file
  and IndexedDB commits, and recovery after interrupted publication.
- Cloud conflict reconciliation and first-login migration UX, including any
  explicit copying from the default library and target-name collisions. Account
  switching itself must continue to detach references as section 2.5 requires.
- Native persistence for children whose parent was deleted remotely, preserving
  their effective values without assuming a missing parent will become available.
- The history-root migration mechanism, dependency retention and resource
  accounting across current, historical and saved-checkpoint references.

These are implementation work areas, not permission to change the accepted
transition behaviour. Any newly exposed product choice needs explicit review.

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
  history-only references; multiple versions and multiple shared slots. Merely
  browsed never-used profiles update silently; history-only ones retain versions.
- Manual deletion yields a native system-capable replacement and one history
  operation; Undo/Redo changes selection only and never recreates files/uploads.
- Explicit Update changes all active references once; Undo/Redo restores exact
  version pins in every picker; intervening cloud updates do not change a
  recorded Redo target.
- Dirty/highlight/order computed against latest head; final pre-deletion
  baseline; empty overlays that are dirty and nonempty overlays that are clean;
  field/category Reset retains pins; full Reset adopts latest identity in one
  history entry across all active references; deleted full Reset does not
  recreate the record.
- Update dialog discard, transfer and Cancel; transfer actual edits rather than
  every head-relative difference; native validation failure leaves state intact;
  concurrent newer update, deletion or account switch while awaiting a decision.
- Stale-snapshot Save confirms Overwrite, Save As or Cancel; successful overwrite
  retains the outgoing newer head and adds no project-history entry.
- Native inheritance, multi-toolhead vectors, Process ownership, rack colours,
  flushing, compatibility and bed normalization across save/update/navigation.
- Reused names/cloud identifiers never reconnect old Deleted snapshots;
  Save As leaves the original record intact and creates a separate identity;
  manual parent deletion is blocked, parent updates version affected children,
  and remote parent deletion preserves usable child configurations.
- Current and uncaptured history roots, both navigation directions, saved
  checkpoint, direct history jumps, history eviction and retained snapshot
  lifetime. No geometry archive duplication from reference migration.
- Account switch migrates all current/history user references, including both
  history directions and same-name incoming profiles; it adds no history and
  implies neither deletion nor upload. Compare against the frozen saved baseline,
  offer Save As only, and do not automatically reattach on return to that account.
- 3MF effective-value round trip, geometry-only import and session-boundary
  transitions: New/Open starts a fresh version view; Setup Wizard resets history
  using current effective values; reopened 3MF has no Neo revision/deletion
  metadata or automatic same-name user-library association.
- Failed validation/write/publication, duplicate cloud changes, interrupted
  commit recovery and stale responses. No partially published history or head.

Shared logic is verified at the lowest useful layer; host-specific persistence
requires Electron/Web coverage and the common bridge requires both WASM variants
at the appropriate handoff gate. This design document does not claim any of
those product checks have run or passed.
