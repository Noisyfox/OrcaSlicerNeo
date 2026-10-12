# User Preset Repository and Versioning

**Date:** 2026-10-12

**Status:** Local management implemented for the default library. Account
libraries, synchronization and cloud update notices remain design only.
Sections 1-3 record accepted product requirements; section 12 describes the
delivered local subset and its verification boundaries.

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
and interchange. This document defines their user-repository extension;
cloud-specific requirements do not imply delivered cloud functionality.

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

### 2.0 Compact rules and operation semantics

The accepted behaviour can be expressed by five core rules and the operation
table below. Sections 2.1-2.7 clarify these rules; section 3 supplies worked
acceptance examples, not additional per-scenario state machines. This is a
compact restatement, not a change to the accepted product decisions or a claim
that cloud conflict/recovery protocols have been specified.

**R1 — Preserve exact versions.** Identity is library-scoped and independent of
name. Before replacing, deleting or detaching a referenced source, retain the
old version and its effective dependencies; migrate affected non-snapshot
references without changing their values/edits or existing snapshots. Each
successful overwrite has a distinct revision. Keep content while any current,
historical, checkpoint, draft or prepared-operation reference needs it.

**R2 — Undo session state, not repository effects.** History restores exact
selected versions, values and drafts. It never rewinds saved files, resurrects
records, changes accounts or reopens handled cloud notices. Only the successful
session actions identified below add history; repository reconciliation and
reference migration do not. Overwrite Save is deliberately history-neutral but
records its post-save binding in the saved session state for later Redo. New
history actions truncate Redo; history-neutral changes preserve it. Project
dirty follows the project saved checkpoint.

**R3 — Separate current use from historical use.** Incoming repository changes
preserve current active effective values; inactive sources follow local head
automatically while historical versions remain snapshots. Only an active source
with an unresolved cloud update shows Update available and its action. Explicit
adoption, overwrite Save or inactive automatic updating handles that event;
Undo does not unhandle it. Local revision differences never create notices.
All selectors obey the current active binding while its cloud update is pending;
historical references alone do not pin normal browsing or selection.

**R4 — Compare and reset against one applicable baseline.** For a linked source,
use its latest saved local head; for a deleted source, its final pre-deletion
saved version; for an account-detached source, its frozen pre-switch saved
version. Native effective-parameter comparison drives dirty/diff/highlighting.
Reset takes values from the same baseline. Partial Reset retains identity;
full Reset also adopts head identity when still linked. Deleted/detached sources
remain snapshots and cannot be restored by Save or Reset. Actual edits to
transfer are recorded edits, not all differences from this comparison baseline.

**R5 — Commit one coherent action.** Validate and prepare retention, persistence,
bindings and native dependent normalization before publishing. Update, full
Reset, Save As selection and deletion replacement affect all active references
to that source together. Each history-producing action is one entry regardless
of slot count; editor browsing alone does not select a project source. Cancel,
failed validation and no-op session actions produce no history. Revalidate
identity/head after async waits; never publish a partially applied action.
Durable commit/recovery details remain implementation design.

| Operation | Repository effect | Session effect | New project history |
| --- | --- | --- | --- |
| Edit / partial Reset | None | Change corresponding effective values | One if changed |
| Overwrite Save | Save a new revision of the same identity | Adopt saved revision; resolve its pending cloud update | None |
| Save As | Create a new identity under an unused name | Switch all active source references; otherwise editor target only | One for active-reference switching; otherwise none |
| Explicit Update | Do not overwrite the saved head | Adopt latest head; discard edits, transfer actual edits, or cancel | One successful adoption |
| Full Reset | None | Restore applicable baseline; adopt linked head identity; resolve pending update | One if values or identity change |
| Manual Delete | Delete the user record | Replace active references with usable sources; otherwise advance editor target only | One for active replacement; otherwise none |
| Incoming content update | Advance valid local head, retain old versions | Preserve active effective values; inactive sources follow head; R3 controls notice | None |
| Incoming deletion | Remove live record, retain required snapshots/baseline | Preserve active values on Deleted snapshot | None |
| Account switch | Select another library; delete neither library's records | Detach all outgoing current/history user references and freeze baselines | None |
| Undo / Redo | None | Restore recorded session state, then derive current status under R3/R4 | No new entry |

For an unresolved cloud update, overwrite Save still requires the accepted
Overwrite / Save As / Cancel decision. Explicit Update with edits requires
Discard / Transfer / Cancel and native validation. These choices select the
transaction to run; they do not introduce another history or versioning model.

The following independent scope constraints are inputs to the rules, not
consequences of them:

- Host storage and library separation remain section 1's requirements: editable
  Electron files, shared Web behaviour, no-account default library, per-account
  libraries, explicit external-file reads and direct application overwrites.
- Save As needs an unused name; no direct Rename or bulk Delete. Deleted and
  account-detached sources allow Save As only. Returning to an account does not
  automatically reconnect its detached snapshots.
- Manual parent deletion is blocked by user children. Parent-induced effective
  child changes use R1/R3; remote parent deletion preserves usable child content.
- New/Open creates a fresh project/version view; Setup Wizard keeps its accepted
  history reset and effective-value baseline. 3MF stores ordinary Orca effective
  configuration without Neo revision/deletion metadata; geometry-only import
  does not replace the session.

Coverage of all existing worked examples:

| Worked examples | Rules and operation/scope input |
| --- | --- |
| 3.1-3.2: overwrite Save and repeated saves | R1, R2, R4; Overwrite Save row |
| 3.3: manual/cloud deletion | R1-R4; distinct deletion rows |
| 3.4-3.5: repeated cloud updates and history-only sources | R1-R3; Update/incoming-update rows |
| 3.6: account changes | R1, R2, R4; Account switch row and detachment constraint |
| 3.7: Save As | R1, R2, R5; Save As row and naming constraint |
| 3.8-3.10: edited updates, outdated Save and Reset | R1-R5; confirmation choices and relevant operation rows |
| 3.11-3.12: shared slots and Redo branches | R2, R3, R5; common action scope and history-column decisions |
| 3.13: parent/child changes | R1, R3, R5; inheritance constraint |
| 3.14: files, import, no-account and network loss | R1-R3; host/library constraint and incoming-update row |
| 3.15: project/3MF boundaries | R1, R2, R4; project/interchange constraint |
| 3.16: failures and concurrency | R1, R2, R5; protocol/recovery qualification remains explicit |
| 3.17: profile versus project dirty | R2, R4; history-column decisions |
| 3.18: identity reuse and retention | R1, R2, R5; naming/deletion constraints |

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

A local overwrite Save immediately adopts the newly saved version, without an
additional history entry. The option-edit history already records the changes that the
user may undo. Undoing those edits never rewinds the saved repository head.
Redo back to the saved state restores its post-save version identity as well as
its values. Undo to an older locally saved version shows normal override/diff
highlighting against the saved head, not Update available. A later head alone
does not imply an update notice; section 2.4 defines the separate pending cloud
update state.

Save As requires an unused name in the target library/type namespace and creates
a separate profile identity without modifying the original. An occupied name
is rejected before writing, switching references or creating history; Save As
does not offer target overwrite. Overwrite Save remains a separate operation.
All active references to the source switch to the new profile together in one
project-history entry. The entry represents selection switching, not creation
of the durable record: Undo returns to the original references but keeps the
new file, and Redo selects the new profile again without creating another file.
This selection change participates in normal project-file dirty tracking.
For an independently browsed source unused by the current project, Save As only
changes the editor target; it neither selects the new profile in the project
nor creates project history.

Saving while an active profile has an unresolved cloud update requires
confirmation before overwriting that newer head. Offer Overwrite, Save As and
Cancel. Ordinary Undo to an older locally saved version does not introduce this
cloud-conflict prompt. Overwrite uses the current effective values and preserves
the outgoing newer head as well as already
retained older versions. It does not implicitly merge them. This confirmation
concerns a pending cloud update, not an undetected external file edit.

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

This phase provides only individual Delete actions, not bulk deletion. User
children must be removed individually before deleting their parent; no batch
selection bypasses the parent-dependency protection.

### 2.3 Deletion received through synchronization

If synchronization deletes the active profile, keep its effective configuration
and selection in place by converting it to the old-version snapshot. Show
**Deleted**. Do not choose a replacement, append a history entry, move the
history cursor, or create a corresponding Redo action. Retained references are
still migrated under section 2.1.

### 2.4 Active profiles and pending cloud updates

Only a currently active profile receiving a cloud synchronization update shows
**Update available** with an adjacent Update action. Retain its current version
and effective values while that update is pending. A historical reference or
independent editor browsing alone does not make a profile active. An active
Filament reference in any slot is sufficient; all active references share this
update state. Local saves, local imports, external-file rereads and version
differences discovered through history navigation do not generate cloud update
notices.

Clicking Update explicitly adopts the latest saved version and creates the
corresponding history entry.
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
outside the surface where the update was first noticed. Undo/Redo restores the
recorded version and effective configuration; it never changes the repository
head or restores a consumed update notification.

Successful explicit Update, full Reset adopting the update, or local overwrite
Save resolves that pending cloud update. Undo back to the older version then
shows only normal override/diff highlighting against the local saved head.
Do not reintroduce Update available or its action merely because the selected
snapshot is older. A subsequent new cloud update received while the profile is
active can create a new pending notice. Automatic persistence of incoming cloud
data is not, by itself, the user's adoption of an active profile's pending update.

If the profile has no current active references, update its local repository
version automatically and silently, including when it exists in retained
history. Rewrite affected historical references to immutable old-version
snapshots, retaining each frame's values and edits. History preservation does
not pin the inactive profile in selectors: normal browsing/selection uses the
latest local version, with no Update button or adoption history entry.
Undo that later activates one of those old snapshots restores its old values
but only shows override/diff against the local head, not a new update notice.

Repository changes and transparent reference migration do not themselves create
project-history entries. Explicit manual deletion, version adoption and Save As
selection switching are the project actions described above.

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
child's effective values, preserve all historical versions and process the
child through the same active/inactive rules. A cloud-driven change to an active
child can offer adoption; inactive children, including history-only ones, update
locally and silently. Local parent changes do not generate cloud update notices.
A retained child snapshot must include enough dependency content to remain
stable when its parent changes.

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

Update available denotes an unresolved cloud update to an active profile; it is
neither a generic version-mismatch marker nor an alias for dirty. Deleted is a
separate lifecycle indication. An unchanged old snapshot can be dirty relative
to a newer head even with no local overlay. Conversely an overlay can produce values equal to the
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

### 3.1 Local overwrite save followed by Undo

Each table is an independent sequence. V1/V2 are revisions of the same identity
P; Save As creates a different identity Q. Dirty below means profile parameter
dirty, not project-file dirty. Snapshot values and editable overlays remain
distinct even when a row shows only their combined effective temperature.

| Step | Repository | Session and history |
| --- | --- | --- |
| A: select P@V1 | P@V1 = 200 | Effective 200; clean. |
| B: edit temperature | P@V1 = 200 | Effective 210; dirty; one option-edit entry. |
| Overwrite Save | P@V2 = 210 | Snapshot outgoing V1; current binding adopts V2; clean; no new entry. |
| Undo B | P@V2 = 210 | Restore V1 snapshot at 200; normal override/diff highlighting and dirty; no Update available. |
| Redo B | P@V2 = 210 | Restore post-save V2 identity at 210; clean; no Update available. |
| A new cloud V3 = 220 arrives while P is active; repeat Undo/Redo before handling it | P@V3 = 220 | Redo returns to retained V2 = 210; the new unresolved cloud event can show Update available. A mere local head difference cannot. |

### 3.2 Several saves

| Step | Effective values and version | Repository/history effect |
| --- | --- | --- |
| A | P@V1 = 200 | Initial saved version. |
| B: edit, then Save | P@V2 = 210 | One edit entry; Save retains V1 without another entry. |
| C: edit, then Save | P@V3 = 220 | One edit entry; Save retains V2 without rewriting existing V1 snapshots. |
| Undo C | V2 snapshot = 210 | Head stays V3; normal override/diff and dirty; no update notice. |
| Undo B | V1 snapshot = 200 | Head stays V3; normal override/diff and dirty; no update notice. |
| Redo B, then C | V2 = 210, then V3 = 220 | Exact recorded bindings; finally clean at V3. |

### 3.3 Manual and synchronized deletion

| Step | Manual deletion branch | Synchronization deletion branch |
| --- | --- | --- |
| A | P saved at 200 | P saved at 200 |
| B: edit | P effective 210 | P effective 210 |
| Delete P | Select usable Q; one new history entry. | Stay on P snapshot, effective 210; no new entry. |
| History migration | A/B retain P snapshots and their distinct effective values. | Same; existing Redo is preserved. |
| Undo | Undo deletion returns to Deleted P at 210. | Undo option edit B returns to Deleted P at 200. |
| Redo | Select Q; do not repeat repository deletion. | Restore Deleted P at 210; do not recreate its file. |

Both branches compare P snapshots against its last saved 200 baseline. If the
session had retained V1 while head V3 was deleted, the baseline would instead
be V3's final saved values.

### 3.4 Several cloud updates

| Step | Current binding and values | Head/history |
| --- | --- | --- |
| Select P@V1 | V1 = 200 | Head V1. |
| Receive V2 = 220 | V1 snapshot = 200; Update available | Head V2; no entry. |
| Receive V3 = 230 before adoption | Same V1 = 200 | Head V3; no entry; selectors still expose V1. |
| Click Update | Adopt V3 = 230 | One adoption entry; do not first adopt obsolete V2. |
| Undo adoption | V1 snapshot = 200; normal override/diff | Head stays V3; the handled update notice does not return. |
| Receive V4 = 240, then Redo | V3 snapshot = 230; Update available | Redo restores recorded V3, not V4; head stays V4. |

Update targets the latest validated head. If the head changes while an
edit-resolution dialog is open, refresh the decision rather than silently
applying a different target. Use the choices in section 2.4.

### 3.5 Active versus history-only sources

| Initial situation | Event | Result |
| --- | --- | --- |
| P has no active/history use | Receive V2 | Catalogue follows V2 silently; no entry. |
| Editor only browses inactive P@V1 | Receive cloud V2 | Editor follows V2 silently, even if old history used P. |
| Earlier history used P@V1; project now uses Q | Receive cloud V2 | Local P advances to V2; rewrite old P history references to V1 snapshots; Q stays selected; no notice or new entry. |
| Same history-only P | Browse/select P normally | Use local V2; no special Update action or update history is needed. A project selection still has its ordinary history. |
| After that automatic update | Undo to history using P@V1 | Activate V1 snapshot with normal override/diff against V2; no update notice. |
| That restored P is now active | Receive a new cloud V3 | Preserve the active values and offer the new pending update. |
| Earlier editing of P created history, but no active P reference remains | Receive cloud V2 | Preserve historical values/edits in snapshots; historical use alone does not block silent local updating. |

### 3.6 Account switch with matching names

| Step | Current/history references | Dirty baseline and repository |
| --- | --- | --- |
| A owns P; last saved value 220; current value 210 | A's P; histories can include older 200/210 versions | Compare against A's saved 220. |
| Switch A -> B, where B also has P = 240 | Convert all A user references on both sides of the history cursor to detached snapshots; current stays 210 | Freeze baseline at 220; neither account's P is deleted. |
| Undo to old value 200 | A snapshot = 200 | Compare against frozen 220, never B's 240. |
| Redo to 210 | A snapshot = 210 | Frozen 220; no account change or upload. |
| Switch B -> A | Keep detached snapshot at 210 | No automatic reassociation; Save As only. |
| Alternative: network disconnect without account switch | Keep current account and ordinary references | No detachment or frozen-baseline transition merely from network loss. |

Snapshots already marked Deleted retain that state and their pre-deletion
baseline. Merely becoming detached must not produce a Deleted indication.

### 3.7 Save As and project dirty

| Step | Current references | Repository/history result |
| --- | --- | --- |
| Save project using P | P; project clean | Saved project checkpoint. |
| Save As Q without parameter edits | All active P references become Q | P and Q both exist; one selection history entry; project dirty, Q parameters clean. |
| Undo selection | Original P references | Q file remains; return to the saved checkpoint if nothing else changed. |
| Redo selection | Q references | No second Q file; project dirty again. |
| Alternative: source P was only independently browsed | Editor target becomes Q; project references unchanged | Create Q without project history or project dirty change from selection. |
| Alternative: target name Q is already occupied | Keep original references and editor target | Reject Save As; neither file is overwritten; no history entry. |

If P was Deleted or detached by an account switch, Undo returns to that same
snapshot state. Save As never restores the original record or association.

### 3.8 Update with actual edits

Start each choice from active P@V1 `(temperature=200, speed=100)`, with only
temperature edited to 210. The incoming cloud V2 is `(220, 110)`.

| Event/choice | Effective values and identity | History and dirty |
| --- | --- | --- |
| Receive V2 | V1 snapshot plus edit = (210, 100) | No entry; dirty against (220, 110). |
| Cancel Update | Unchanged (210, 100), V1 | No entry; still Update available. |
| Discard edits and update | V2 = (220, 110) | One entry; clean. |
| Transfer actual edits | V2 plus temperature edit = (210, 110) | One entry; dirty; no pending version update. |
| Undo either successful adoption | V1 plus original edit = (210, 100) | Head stays V2; normal override/diff only; handled update notice does not return. |
| Redo | Restore the recorded discard/transfer result | Do not recalculate the transfer against a newer head. |
| Transfer fails native validation | Keep complete original (210, 100) state | No adoption entry or partial changes. |

With no actual edits, an old version differing from head is dirty but needs no
edit-conflict prompt. Conversely edits may happen to equal the new head, making
dirty false while version adoption is still pending. Transfer must use edited
field/index ownership, not all head-relative differences.

### 3.9 Outdated Save and final deletion baseline

| Step | Session | Repository/history |
| --- | --- | --- |
| V1 = 200 is active; local edit = 210; receive cloud V2 = 220 | Retain V1 plus edit at 210 with pending cloud update | Head V2; no incoming history entry. |
| Save, then Cancel confirmation | Keep 210 and V1 binding | Head stays V2; no entry. |
| Alternative: confirm Overwrite | Adopt newly saved V3 = 210 | Preserve outgoing V2 as well as retained V1; no extra Save entry. |
| Alternative: choose Save As Q | Adopt Q = 210 for active references | P remains V2 = 220; one selection entry under section 3.7. |
| Separate branch: head V3 = 230 is deleted while current still uses V1 = 200 | V1 snapshot remains 200, now Deleted | Compare dirty against final saved V3 = 230, not V1. |
| Full Reset in that deleted branch | Snapshot effective 230, still Deleted | Clean against final 230; one Reset entry; P file remains absent. |
| Undo Reset | Deleted snapshot effective 200 | Dirty against final 230; no resurrection. |

### 3.10 Partial and full Reset

Start from active V1 `(200, 100)` with an unresolved cloud update to V2
`(220, 110)` and no local edits. A purely local version difference would not
show Update available at any step.

| Step | Effective values and version | Result |
| --- | --- | --- |
| Reset temperature | V1 snapshot plus values (220, 100) | Dirty; Update available remains. |
| Reset speed as well | V1 snapshot plus values (220, 110) | Clean parameters but Update available remains. |
| Full Reset preset | V2 = (220, 110), all active references | One Reset entry; latest identity adopted, Update available clears. |
| Undo full Reset | Previous V1 binding and (220, 110) values | Clean parameters; the resolved cloud update notice does not return. |
| Redo full Reset | Recorded V2 binding | Compare against current head; only a new unresolved cloud event can show an update notice. |
| Alternative: detached by account switch | Reset against frozen pre-switch saved values | Keep detached identity; never reconnect or write to the old account. |

A Reset that changes neither values nor identity is a no-op under the existing
history contract; full Reset of a clean old snapshot still changes identity.

### 3.11 Shared references and all selectors

Use slots `[P@V1, Q, P@V1]`; each operation row is an alternative from that state.

| Event | Slot/session result | History |
| --- | --- | --- |
| Receive cloud P@V2 | Both P slots remain pinned to V1 with pending update; Q unchanged | None. |
| Choose P in another picker or newly added slot | Resolve P through the same V1 binding; cannot bypass Update | Normal selection/slot action only. |
| Update from either P slot or its editor | Both P slots adopt V2 together; Q unchanged | One adoption entry. |
| Full Reset P | Both P slots use latest saved values and identity | One Reset entry. |
| Overwrite Save P | Both active P references adopt saved version | No extra Save entry. |
| Save As R from P | Both P slots switch to R; Q unchanged | One selection entry. |
| Manually delete P | Replace both P references coherently with usable sources | One deletion-selection entry. |
| Receive deletion of P | Both remain on Deleted snapshots at their prior effective values | None. |

Printer adoption includes native dependent Process/rack/bed normalization in
the same transaction; undo restores the recorded configuration and slot colours.
Independent editor browsing alone never selects a source for the project.

### 3.12 Redo branches and unrelated history

Start at B in history `A(200) -> B(210) -> C(220)`, with C available through Redo.

| Event at B | Redo branch | Subsequent navigation |
| --- | --- | --- |
| Incoming head update | Keep C; migrate outgoing-head references | Redo C restores recorded 220 and version, not latest head. |
| Incoming deletion | Keep C; migrate references to Deleted snapshots | Redo C yields Deleted P at 220. |
| Successful overwrite Save | Keep C; migrate references; update current B's saved binding | Redo C still restores its recorded values; does not save 220 automatically. |
| Account switch | Keep C; detach all relevant references | Redo C stays a snapshot from the old library. |
| Explicit Update, changed Reset, manual active deletion or Save As selection | Commit a new project action and discard old C | Undo/Redo now traverse the new branch. |
| Cancelled/failed action or pure browsing | Keep C | No successful mutation was committed. |
| A history item changes geometry but also captures P | Migrate its P reference too | Geometry and entry labels/timestamps remain unchanged. |

### 3.13 Parent and child sequences

| Initial state / event | Child result | History/repository consequence |
| --- | --- | --- |
| C inherits temperature 200 from parent R; C is active; cloud updates R to 220 | C retains its old effective version at 200 and offers an update | No incoming history entry. |
| Explicitly update C | C adopts effective 220 | One entry; Undo returns to retained effective 200. |
| Alternative: C is inactive, including history-only use | C silently follows effective 220 locally; historical C versions become snapshots | No pending update notice or adoption entry. |
| Alternative: C overrides temperature to 205 | Parent temperature update leaves effective C at 205 | No effective child-content update from that field. |
| Manually delete R while user C inherits it | Reject deletion | No repository deletion or history transition. |
| Synchronization deletes R | Preserve C's original effective configuration and all retained old C versions | Do not silently delete C or mark C Deleted solely because R disappeared. |
| A batch changes both parent and child | Validate/preserve the complete dependency set before publishing | No observable half-updated inheritance chain. |

### 3.14 Files, imports and no-account usage

Each row is independent unless it explicitly describes a sequence.

| Sequence/event | Visible result | Persistence/history |
| --- | --- | --- |
| Electron loads file P = 200; external editor writes 220 | Application still uses loaded 200 | No watcher-driven adoption or history. |
| Before reread, application edits to 210 and saves | Application adopts 210 | Overwrite file to 210 without external-change conflict check. |
| Instead, deliberate reread discovers 220 | Preserve required current/history snapshots; inactive P follows latest locally | No cloud update notice from an external file read; no automatic history entry. |
| External file deleted, then application rereads | Apply missing-record/deletion reconciliation | Preserve used versions and historical reconstruction. |
| Import a new preset | Add new library record | Do not automatically change project selection. |
| Import confirms overwrite of existing P | Advance local head and preserve referenced old versions | No cloud update notice from a local import; no implicit project adoption. |
| Reread identical saved content / duplicate sync acknowledgement | No new semantic transition | No duplicate history or fabricated save event. |
| No-account Save on either host | Use default library and normal Save rules | Electron persists files; proposed Web adapter persists IndexedDB. |
| Logged-in account loses network; edit and Save | Adopt locally saved version immediately | Local saved head is dirty baseline; cloud work remains pending. |

The policy for conflicting queued local changes versus remote updates/deletion
is still part of cloud reconciliation design, not specified by file overwrite.

### 3.15 Project boundaries and 3MF sequences

| Step/event | Effective values and identity | History/lifecycle result |
| --- | --- | --- |
| Current Deleted P has saved baseline 200 and draft value 210 | Effective 210 | Existing session history remains available. |
| Export 3MF | Archive effective 210 using normal Orca format | No Neo revision ID, Deleted marker or entire Undo timeline. |
| Reopen that 3MF, even with an installed same-name P = 240 | Restore effective 210 through ordinary embedded handling | Fresh project/history baseline; no automatic reassociation by name. |
| New Project or replace with another project | Initialize new version-selection view | Previous project pins/history do not carry over. |
| Import geometry only | Keep current preset values and bindings | Normal geometry-import history; no new preset session. |
| Successful Setup Wizard activation | Establish baseline from current effective parameters | Keep existing history-clear behaviour; do not silently adopt newer head values. |
| Restart | Load durable library content through the host adapter | No promise of persisting the previous session's Undo/Redo stack. |

### 3.16 Failure and concurrent-event handling

These rows are proposed implementation consequences of the accepted atomic
transitions, not a completed cloud protocol or recovery design.

| Sequence/event | Required visible boundary | History consequence |
| --- | --- | --- |
| Update dialog targets V2; V3 arrives | Refresh/revalidate the decision; do not silently substitute a different target | No adoption until successful commit. |
| Update dialog is open; P is deleted | Retain effective state as Deleted; no update to a missing head | Deletion itself adds no entry. |
| Save/Update dialog is open; account changes | Reject stale-library operation or restart it against explicit new context | No accidental write or selection in another account. |
| Native transfer validation fails | Preserve old values, drafts and binding | No partial adoption entry. |
| File/IndexedDB write fails | Do not report successful Save or clear dirty | No completed Save/version event. |
| Duplicate Update activation | Serialize/revalidate; do not adopt the same target twice | No duplicate entry for one completed transition. |
| Local save V2 is uploading; V3 is saved before acknowledgement | Acknowledge only V2; V3 remains pending | No rollback to V2 and no new project history from acknowledgement. |
| Crash between durable commit and runtime publication | Recover a coherent committed or previous state | Exact recovery protocol remains to be designed. |

### 3.17 Parameter dirty versus project dirty

| Sequence | Profile parameter dirty | Project-file dirty |
| --- | --- | --- |
| Save project using P@V1 = 200, then receive head V2 = 220 | True at retained 200 | Unchanged: incoming update/reference migration does not move saved checkpoint. |
| Edit to 210, then overwrite Save P | False after saving 210 | Still changed relative to saved project; preset Save is not Save Project. |
| Undo to saved project state using 200 while head remains 210 | True | Clean at the saved project checkpoint. |
| Save As Q with equal values and switch active references | False for Q | Dirty because the selection change has one history entry. |
| Undo that Save As selection | Compare restored source against its applicable baseline | Return to the prior checkpoint if otherwise unchanged; Q file remains. |
| Incoming deletion of unchanged active P | False against its final saved baseline | No new project-history change solely from deletion. |
| Account switch with unchanged effective values | Compare against frozen pre-switch saved baseline | No new project-history change solely from detachment. |

### 3.18 Identity reuse, retention and remaining combinations

| Event | Result / qualification |
| --- | --- |
| Delete P, then create another preset with the same name | New identity; old history stays Deleted and must not bind to the new record. |
| A preserved version is only on the Redo side | Keep it until no remaining history/session/checkpoint owner needs it. |
| History entries are evicted | Release their references, not still-live snapshots or dependency baselines. |
| Explicitly save unchanged values again | A successful overwrite is a separate saved revision/snapshot event; equal bytes may share immutable storage. |
| Repeated cloud delete / acknowledgement of local delete | Reconciliation is idempotent; do not create extra history, restore files or duplicate snapshots. |
| Save As targets a name that already exists | Reject it; require an unused name. Keep files, selection and history unchanged. |
| User wants to delete a parent and its children | No bulk Delete in this phase. Delete children individually, then the parent; each successful active-reference replacement has its own history entry. |
| Multiple application sessions edit the same library | Each session must retain its own observed versions when it learns of a change; cross-session notification and write arbitration remain implementation design. |

These cases cover the accepted transition classes and critical event orderings.
Unbounded permutations of concurrent events reduce to validated, serialized
transitions; the cloud conflict and cross-session implementation designs remain
separate from these accepted user operations.

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
- Maintain version bindings for current active references and exact historical
  snapshots. Historical use alone never pins an inactive profile's normal
  selectors; those follow the latest local head. History navigation can restore
  exact old versions without generating an update notice.
- Track unresolved cloud update events separately from revision identity and
  dirty. Acknowledging an update through successful adoption/local Save, or
  automatic local updating of an inactive profile, is not reversed by project
  Undo/Redo. Preserve the cause and handled state; do not derive notifications
  from `selected_revision != head_revision` or replay old UI booleans.
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
| Overwrite Save while cursor is before existing Redo | Saving is not a new project operation and must not erase Redo; migrate its references as well. A preceding actual option edit still has normal Redo-truncation semantics. |
| Save an independently browsed profile | Save/adopt that editor source without selecting it in the project. Shared active references, if present, remain consistent with the new saved version. |
| Save As from system, embedded or snapshot source | Create a separate identity; switch all active source references in one selection history entry. Undo keeps the new file. For a project-unused editor source, only change the editor target, without project history. |
| Save from a Deleted snapshot | Save As only; old identity remains deleted. |
| Save with an unresolved cloud update | Confirm Overwrite, Save As or Cancel. Overwrite preserves outgoing newer head and resolves that pending update; no extra history. An older local-history snapshot alone does not trigger the cloud warning. |
| Import with a new identity | Add to the library without switching the current project automatically. |
| Import over an existing user identity | Treat as a local head update after normal overwrite confirmation; retain referenced old versions without generating a cloud update notice. |
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
| Delete several profiles | No bulk Delete in this phase; use separate individual actions, each obeying dependency protection and the active/editor-only history rule. |
| Delete a parent still used by user children | Block manual deletion. If synchronization deletes the parent, preserve each child's original effective configuration and its reconstructable historical versions. |
| Change a preset's name | Save As creates a separate identity and retains the original. No direct Rename action; deleting the original is a separate explicit operation. |
| Recreate an old name | New identity/incarnation; historical Deleted snapshots do not automatically reconnect or become writable. |

### 5.3 Update and adoption

| Scenario | Required result or proposed handling |
| --- | --- |
| Remote update to active profile | Preserve old version and effective values; show Update available and use pinned candidates everywhere; no new history. |
| Update a never-used source, including a browsed-only source | Silently follow latest head; no pin, update prompt or project history caused by browsing. |
| Update an inactive source referenced by history | Automatically update the local head and migrate old history references to snapshots; no notification, selector pin or adoption entry. |
| Click Update with no unsaved parameter edits | Adopt latest head for all active references in one history entry. |
| Click Update with unsaved edits | Offer discard-and-update, transfer actual edits onto latest, and Cancel. Native validation failure aborts transfer; successful adoption is one history entry. |
| Independently browse a history-only source | Follow the latest local head automatically; do not offer a pending-update action solely because history references old snapshots. |
| Several head updates before adoption | Retain session pin; advertise latest head. Unobserved intermediate revisions need not become artificial project-history entries. |
| Undo adoption | Restore old version and drafts; use normal override/diff against current head. Do not restore the handled update notice. |
| Redo adoption after another cloud update | Restore the originally recorded version; show a notice only if the new cloud event remains unresolved for this active profile. If it was handled automatically while inactive, show only diff. |
| Remote deletion while Update is being confirmed | Revalidate; cannot adopt a deleted head. Preserve session and present Deleted state. |
| Updated Printer changes capabilities/compatibility | At explicit adoption, native normalization handles Process/rack/bed changes atomically in the same history entry. |
| Updated Filament changes default colour | Use the accepted source-transition and actual-slot-colour policy; undo restores captured colours, not current defaults. |
| Update causes no effective slicing-input change | Version/history semantics still apply; avoid invalidating results solely for a repository notification. Validate against existing native invalidation rules. |
| Parent content changes effective child content | Preserve historical child snapshots. A cloud-driven change can notify active children; inactive/history-only children update locally and silently. Local parent changes do not generate cloud notices. |

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
| Independent Printer/Filament editor source picker | Preserve active source bindings without changing project selection; inactive sources follow local head even when history-used. Show Update only for an active source with a pending cloud event. |
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
   transparent migration and overwrite Save do not. Save As selection switching
   is also one project-history operation; creation of its durable file is not
   reversed by history.
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

Status is resolved against current lifecycle and pending cloud-event state, not
restored from old UI booleans. A history frame captured before a later deletion
still displays Deleted after navigation. A recorded V2 can show Update available
only for a new unresolved cloud update while active; a newer local head alone
is insufficient. Undo/Redo never resurrects an update that has already been
handled, whether explicitly or through automatic updating of an inactive profile.
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
overwrite Save preserve it; manual active deletion, Save As selection switching
and explicit project Update are normal history
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

The version-transition questions are resolved in sections 1-3, and section 12
records the authorized local implementation. Before adding cloud integration,
complete the following designs:

- Stable local/cloud identity mapping, durable cloud revision metadata, and
  recovery across interrupted multi-record cloud reconciliation. Local
  single-file and IndexedDB commits are described in section 12.
- Cloud conflict reconciliation and first-login migration UX, including any
  explicit copying from the default library and target-name collisions. Account
  switching itself must continue to detach references as section 2.5 requires.
- Native persistence for children whose parent was deleted remotely, preserving
  their effective values without assuming a missing parent will become available.
- Incremental snapshot garbage collection and resource accounting beyond the
  delivered session-boundary retention policy.

These are implementation work areas, not permission to change the accepted
transition behaviour. Any newly exposed product choice needs explicit review.

## 11. Acceptance coverage

Implementation must cover the accepted rules and resolved decisions with tests
at the layers specified by the [testing guidelines](../doc/testing_guidelines.md).
Required behavioural cases include:

- Independent local/default and account libraries on both hosts; restart
  persistence; no-account usage; external edit ignored until read; direct
  application overwrite without external conflict prompts.
- Printer, Filament and Process overwrite Save; repeated saved versions; Save adds
  no history; option Undo restores old content but leaves the latest file and
  cloud head intact; existing Redo survives Save. Redo to a saved state restores
  its post-save revision identity, even if a newer revision now exists.
- Save As creates a distinct identity and one history entry for switching active
  references; Undo leaves the created file intact. Editor-only Save As leaves
  project selection/history unchanged. Project dirty follows the selection entry.
  Reject an occupied target name without file, selection or history changes.
- Remote update/delete with active, inactive, editor-only, draft-only and
  history-only references; multiple versions and multiple shared slots. Inactive
  history-only profiles update locally and silently while old history references
  become snapshots; subsequent Undo shows diff only, not a handled update notice.
- Cloud notification gating by active references and unresolved cloud events;
  local overwrite Save, external-file reread and local import do not create such
  notices. Undo after local Save, explicit Update or full Reset cannot resurrect
  a handled notice. A new cloud event while active can notify again.
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
- Save with a pending cloud update confirms Overwrite, Save As or Cancel; successful overwrite
  retains the outgoing newer head and adds no project-history entry.
- Native inheritance, multi-toolhead vectors, Process ownership, rack colours,
  flushing, compatibility and bed normalization across save/update/navigation.
- Reused names/cloud identifiers never reconnect old Deleted snapshots;
  Save As leaves the original record intact and creates a separate identity;
  manual parent deletion is blocked, parent updates version affected children,
  and remote parent deletion preserves usable child configurations. No bulk
  Delete surface is introduced; children must be deleted individually first.
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
at the appropriate handoff gate. The complete cloud matrix above remains
future qualification; local coverage is recorded below.

## 12. Delivered local implementation

The default library is available without an account on both hosts. Printer and
Filament actions live in the independent preset editor; Process actions live
beside its project selector. Save overwrites a writable user preset; Save As
requires an unused name; Delete operates on one user preset and rejects parents
with remaining user children. System and Deleted sources can write a library
preset only through Save As; Reset remains a session parameter operation.
There is no local Update available state, cloud client, account transition,
direct Rename, or bulk Delete.

Save As starts with Orca's default name: `Untitled` for a built-in default,
`<canonical name> - Copy` for a system preset, the bundle alias when available,
or the existing user name. A trailing `.ini` is removed without regard to case.
Session snapshots use their original user name without version/deletion markers.
The unused-name requirement still applies when the suggested name is occupied.

### Storage and ownership

- Electron keeps native Orca JSON under
  `app.getPath('userData')/user/default/{machine,filament,process}`;
  native detached base profiles use each type's `base` subdirectory. Files may
  be edited directly. Startup reads them; no watcher or external-change check
  runs during the session, and application Save overwrites the current file.
- Web stores the same relative paths and JSON in IndexedDB database
  `orca-user-presets`, store `default`. Availability is subject to the browser's
  storage lifetime; this feature does not implement an offline application shell.
- The runtime injects host storage into the typed client/Worker. Native code
  owns names, inheritance, effective values, saved diffs, compatibility and
  session transitions. No application code accesses Emscripten or host paths.
- Only saved JSON is durable. Snapshot aliases and deleted baselines are native
  session state, released at a New/Open boundary. They never become library
  files or Neo-specific 3MF metadata. Session retention currently lasts until
  that boundary; it is not a claim of incremental snapshot garbage collection.

### Commit and history

The native prepare operation stages a complete rollback state and the intended
single-file change. The typed client validates the reply before persistence.
Electron replaces a file through a same-directory temporary file and rename;
Web uses one IndexedDB write transaction. The Worker excludes competing requests
until native commit or rollback. A rejected/failed write restores the previous
native library, drafts, current selection and history without a new entry.
The file commit is authoritative across a process exit; a new runtime loads it
at startup. No cross-process library locking or cross-session notification is
introduced.

Replacing a saved version retains its effective configuration and redirects
historical references to that version. The saved baseline remains independently
addressable for dirty and Reset. History context rewrites share existing model
archives and preserve the saved marker and Redo branch. Overwrite Save rebinds
the current state without another entry; active Save As and Delete each produce
one selection entry for all same-source references. Undo never reverses the
file operation. Deleted snapshots retain their final saved comparison baseline
and cannot reconnect to a later preset that reuses the name.

Native project-embedded Process children keep their separate ownership. Saving
their effective parameters preserves the saved head's parent, preventing a
self-inheritance. Full Reset adopts the current head when still linked; partial
Reset changes values only. Export writes ordinary Orca embedded configurations
with clean project names and effective values.

### Verification entry points

- `pnpm test` and `pnpm typecheck` cover the shared contract, Worker admission,
  write failure rollback, storage adapters and UI actions.
- `scripts\build-windows.bat quick --variant threaded -j 8` and the corresponding
  `--variant serial` command build the common native boundary.
- `node packages/slicer-wasm/harness/user-presets-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js`
  exercises real native Save/Save As/Delete, historical identities, Reset,
  shared slots, independent browsing, inheritance and 3MF. Substitute
  `out/serial/orca_slice.js` for serial qualification.
- The standalone `TimestampedHistory.test.cpp` verifies atomic context rewriting,
  saved markers, retained Redo and shared geometry archives.
- `apps/desktop/e2e/user-presets.e2e.ts` uses real WASM and an isolated user-data
  directory for file writes, restart, deletion and Undo. It requires the staged
  real desktop build and `ORCA_E2E_REAL=1`.
- `apps/web/e2e/user-presets.e2e.ts` uses real WASM and browser IndexedDB across a
  reload. It runs through the existing Web Playwright configuration.

These focused tests do not constitute the full release matrix, a cloud sync
qualification, or a multiple-process write arbitration guarantee.
