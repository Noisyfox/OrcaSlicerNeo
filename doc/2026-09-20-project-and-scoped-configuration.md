# Project and Scoped Configuration

**Date:** 2026-09-20
**Status:** Local implementation accepted — Steps 1–8 complete; fixed external
Orca round-trip input remains to be provisioned for release qualification

The normative, incrementally accepted feature specification is
[`Project and Scoped Configuration`](../spec/Project%20and%20Scoped%20Configuration.md).

## 2026-09-21 persistence-boundary correction

Neo-private `Metadata/orca_neo_*` archive members are prohibited. New saves must
write no such member, and opens must not read, migrate, preserve, or replay one.
This supersedes the prior decision that the private plate-session and filament-state
members were permissible non-configuration sidecars.

The Orca-compatible BBS writer is the sole project persistence path. It retains
native plate structure, membership, names, locks, scoped configuration, project
configuration, and embedded presets. On open, Neo reconstructs its selected plate
and virtual layout as runtime session state. Filament selection and edited filament
settings are restored only through the standard BBS project config and embedded
presets, matching OrcaSlicer; live AMS/device state belongs to Neo's device-management
and runtime session, not the project or user profile.
This living record contains the implementation sequence and verification evidence. It
intentionally does not duplicate the normative decisions.

The editable Plate-scope surface is constrained to the nine native keys that
Orca's BBS `Metadata/model_settings.config` path can emit and read:
`curr_bed_type`, `print_sequence`, `first_layer_print_sequence`,
`other_layers_print_sequence`, `other_layers_print_sequence_nums`, `spiral_mode`,
`filament_map_mode`, `filament_map`, and `filament_volume_map`. A Plate mutation for
any other key is rejected with `unsupported_reference`; it is not retained in the
editable scoped surface. The native `PlateData::config` and metadata remain intact,
including BBS structural/derived fields such as `enable_filament_dynamic_map` and
`has_filament_switcher`, and are preserved through history and the standard BBS
writer.

## Approved implementation sequence

Each numbered step is implemented by one new subagent. That subagent must complete its
own focused verification. The parent independently reviews the resulting diff and
runs the stated acceptance checks before any later step starts. No step may redefine
the approved semantics in the normative specification.

1. **Fixture-safe baseline and history measurement harness**
   - Implement the test-only fixture-copy mechanism and refactor the real-project
     history profile so the immutable source helmet project is verified by identity but
     every operation targets a freshly created temporary copy.
   - Establish structured baseline measurements for the specified history scenarios;
     do not claim the 200 ms gate before the later post-change measurement.
   - Acceptance: source SHA-256/length are unchanged; profile refuses a non-identical
     fixture; a temporary copy is the only opened/saved/sliced path; the profile emits
     raw per-sample timing and metadata without production instrumentation.

2. **Native persistence authority and sidecar removal**
   - Remove `project_config_overlay` as live state and from 3MF read/write. Make native
     Project, Plate, `ModelObject`, and `ModelVolume` configuration locations the only
     persisted owners, retaining valid native values not exposed by the first UI.
   - Keep geometry-only import clearing semantics and preserve only its required native
     extruder assignment.
   - Acceptance: normal save writes no sidecar; open does not read/replay a legacy
     sidecar; native scopes survive normal open/save; unsupported Plate keys are
     rejected; geometry-only import clears the specified override scopes.

3. **Native scoped mutation, exact history roots, and invalidation**
   - Add Worker-owned typed set/reset/category-reset/reset-all operations over native
     scope maps, native option parsing and clamp validation, and exact Project-config
     history replacement. Remove Project config from the filament/rack history root.
   - Preserve native entity lifecycle and copy semantics, emit affected-Plate input
     changes only, and keep material, Layer Range, Custom G-code, and inaccessible keys
     outside generic reset-all.
   - Acceptance: atomic multi-target mutations and erase-only reset undo/redo exactly;
     missing historical Project keys are removed on restore; unrelated plates stay
     valid; Object/Volume edits invalidate every and only their instance plates.

4. **Versioned bridge/client/runtime configuration transport**
   - Expose versioned full native scoped snapshots on open/history/refresh and complete
     affected-target map replacements on ordinary mutations through the typed client and
     runtime boundary. Include monotonic revisions and deleted-target representation;
     remove overlay client APIs, mocks, and store authority.
   - Acceptance: no shallow merge can retain erased keys; stale/gapped responses force a
     full refresh; history/open responses publish scene, plate, history, and config at
     one committed revision; shared code remains free of direct Emscripten access.

5. **Shared Project / Scoped React surface**
   - Implement the transient mode toggle, existing-selection target resolution,
     selection-limited React projection, categories/search, mixed multi-edit, typed and
     serialized fields, draft/error behaviour, reset controls, and non-interactive tree
     markers.
   - Acceptance: Project always starts a project session; Scoped never auto-switches;
     Object/Volume selections hide Plate provenance while empty selection exposes Plate;
     invalid selections are disabled; material/Custom G-code remain outside the generic
     surface; all UI writes use committed runtime commands and one history transaction.

6. **Slice-time and structural-operation integration**
   - Connect scoped transactions to the existing serial `slice_busy` policy, threaded
     commit-then-asynchronous-cancel path, revision-based stale-result rejection, and
     native structural-operation receipts for delete, clone, split, cut, replacement,
     and plate movement.
   - Acceptance: serial mutation during slicing changes neither config nor history;
     threaded mutation invalidates/cancels only affected work; unchanged plate work
     continues; no renderer-side old-to-new config mapping exists.

7. **3MF interoperability and compatibility acceptance**
   - Add the complete scoped-configuration golden and normal Neo → Orca → Neo test;
     compare normalized native key maps. Add separate unknown-key compatibility-fallback
     and legacy-sidecar-negative coverage.
   - Acceptance: golden covers every approved scope and preserved inaccessible data;
     no sidecar is produced or replayed; recognized native values round trip; unknown
     input follows the established fallback rather than claiming a native round trip.

8. **End-to-end performance gate and release regression**
   - Repeat the fixture benchmark on real release/non-mock serial and threaded artifacts
     using the full scenario/process/sample matrix. Add the required focused package,
     bridge, host, persistence, and real-project checks for the delivered change.
   - Acceptance: every eligible measured Undo/Redo event-to-next-editable-frame sample
     is at most 200 ms, warm median target is 100 ms, source fixture remains unchanged,
     and all required regressions pass or are reported with evidence.

## Accepted implementation evidence

### Step 8 — Release performance and local verification (accepted pending external qualification)

The release history runner is `pnpm verify:scoped-configuration`.
It rebuilds both release WASM variants, verifies staged artifact hashes and the
active runtime, and runs three fresh Electron processes per variant. Each idle
scenario records first Undo separately, five warm-up pairs, and twenty measured
pairs. Threaded active-slice samples are a separate named population, admitted by
the native bridge rather than merely requested at the renderer proxy. Diagnostics
read the existing Worker pending-task count without adding storage. The runner
waits for a positive count before dispatch and rechecks it inside the timed event;
that diagnostic roundtrip is included in latency. Earlier request-pending runs
remain separate non-acceptance scheduling evidence, not native-active proof. Raw JSON
and command logs remain in the printed temporary report directory even on failure;
the source fixture is verified before and after, and each process gets a fresh
copy through the existing fixture-copy helper.

The ordinary timing boundary is a renderer DOM event invoking the production
history coordinator through canonical publication, idle readiness, and two
animation frames. Configured-entity deletion additionally retains that full
duration but gates the explicitly separate interval after coordinator completion
and an explicit GL-volume revision readiness wait through the next editable frame. Thus its reported
post-readiness statistic excludes React's complex-model loading duration;
configuration maps, stable entity identities, and transforms are still checked
against the predecessor and successor after every restore. Neither interval is
substituted silently for the other.

The candidate optimization adds no React or C++ cache. A native restore compares
its transient before/after graphs and marks touched objects whose displayed mesh,
and structure are unchanged. The existing SceneDelta patch retains only those
already displayed GLVolumes; restored volume transforms arrive in that patch and
instance transforms in the same authoritative plate receipt. Native filament
roots, project colour/mapping/flushing/routing inputs, local material/routing
keys and changed entity presentation still trigger the full filament projection
read. Colour and project/object support-routing Undo/Redo have native regression
coverage; unrelated configuration keys alone do not force that projection.
Latency acceptance remains 200 ms per eligible sample; the 100 ms warm median is
reported independently and does not waive failures.

Native staging uses an owned transient copy of each already decoded volume to
repair its parent link, preserving the separately retained stable IDs and painting
without another cereal encode/decode cycle. Retiring decoded children does not call
the user-edit `delete_volume` operation, which can bake transforms and reassign the
last volume's identity. No extra model survives the restore operation.

Restore also avoids clearing the pre-existing pointer-free used-slot summary
when object/volume identity, mesh, painting content/timestamp, material-usage
options and layer ranges are unchanged. The existing reader still validates
membership and effective global configuration. This changes only invalidation
for semantically irrelevant config/transform edits: no new cache, retained data,
cache key, or lifetime policy is introduced. Native history smoke contrasts
layer-height Undo/Redo (no full usage scan) with support-enable Undo/Redo (full
invalidation); painted-model restoration remains covered by the same smoke.

The synchronous decode may also borrow an already-live immutable convex hull
only after exact stable-volume and immutable-mesh identity checks. Borrowed
archive cursors die with that decode; no map, cache, key, retained owner or
lifetime is added. A mismatch uses the original native hull rebuild. Native
codec tests assert pointer reuse for the exact match and a freshly rebuilt hull
for both volume-identity and mesh-identity mismatches.

The full 2026-09-21 run is preserved at
`C:\Users\noisyfox\AppData\Local\Temp\orca-scoped-gate-1789971131996`.
All six release performance cells passed: three serial processes recorded 624
samples each and three threaded processes recorded 676 each. All 3,150 eligible
first/measured samples were at most 176.80 ms; all 156 threaded active-slice
samples proved a positive admitted-task count inside the event. Most warm medians
remain above the 100 ms target (maximum scenario median 158.94 ms). The configured
delete post-readiness maxima were 6.38–7.67 ms; separately retained full event
maxima were 672.69–719.70 ms and are not presented as sub-200 ms full restores.

The later host-contract repair supplied metadata scopes to mocks, preserved the
Scene revision/element guard, updated the scoped catalogue selectors, and proved
that the native 11-plate project yields nine distinct eligible tower plates. The
threaded object-move profile now checks the authoritative full-staging stage
contract and passed with click-to-restored-projection at 193.58 ms. The real
threaded prime project also passed. For serial, both actual first and second plate
slices completed from fixture copies when the explicit slice-completion boundary
was raised from 300 to 600 seconds (the first produced 108,064,445 bytes of G-code
after about five and a half minutes); the enclosing Playwright timeout is 900
seconds. This does not weaken the actual `Sliced` assertion.

The strict external-Orca check remains unavailable because no fixed Orca-saved
archive or Orca executable is provisioned. It is not fabricated or waived: local
Step 8 acceptance is complete, while release qualification remains pending that
external input. The production renderer was restored and the immutable source
length/SHA-256 matched again after all runs.

The runner subsequently supplies a fresh verified fixture copy to each Web
variant as well. Supplemental logs in the same report directory verify all
8 tests passed in threaded and serial, including real project-load progress.
The first serial supplemental attempt failed before tests started with Node's
Windows `UV_HANDLE_CLOSING` assertion; that log remains, and a separately logged
serial retry passed. These supplements do not erase the original full-run skips
or the unresolved desktop/external-Orca failures.

#### Serial real-project slice boundary follow-up (2026-09-21)

The focused `prime-tower-project.e2e.ts` real serial path was also run with a
fresh copy of the pinned Odyssey project. Its two actual Print operations each
cover the imported 743-layer first plate and complete in roughly five and a
half minutes; the run passed in 10.5 minutes and emitted a 108,064,445-byte
G-code file. The original 300-second assertion and the Playwright real-WASM
file budget of 480 seconds were therefore below the measured serial workload:
the first attempt reached the latter budget while the renderer remained
responsive and consumed CPU. The two actual `Sliced` waits now use a 600-second
boundary, and this test sets a 900-second file budget so the test runner cannot
terminate before that boundary. The completed-slice assertion remains required;
no slice is skipped and no timeout is treated as success.

The candidate-to-`d5309f4` diff contains no native slicing implementation
change; the native bridge delta is confined to history restore, and the
runtime delta only selects the already-built serial artifact for this gate.
This identifies the old timeout as an invalid test boundary rather than a
candidate slicing regression. Evidence is retained at
`C:\Users\noisyfox\AppData\Local\Temp\orca-prime-tower-e2e-6Uf8zp`; both the
source fixture and its temporary copy remained 45,586,816 bytes with SHA-256
`6DB07E50B4692F95BFEF65595E9FCD0BF902C9660B7B1D7BC1A4F98B4D7D2425`.

### Step 1 — Fixture-safe baseline and history measurement harness

Accepted on 2026-09-20. The profile now pins the licensed source project by its
same-basename path, 45,586,816-byte length, and SHA-256
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425` before
creating a fresh same-basename copy below the system temporary directory. Only that
copy is supplied to the real Electron/WASM profile; the runner verifies the source
again before cleanup. The profile rejects an identity mismatch and records the
source/copy identities plus raw mutation, undo, and redo samples in its temporary
baseline report. This is measurement infrastructure only, not a performance-gate
claim.

Parent acceptance checks passed:

- `node --test scripts/real-project-fixture.test.mjs` — 3/3 passed.
- `node --check scripts/real-project-fixture.mjs` and
  `node --check scripts/run-real-project-profile.mjs` — passed.
- `pnpm --filter @orca/desktop test:e2e:real-project-profile` — passed (the real
  visible Electron/WASM profile; Playwright `.last-run.json` reports `passed`).
- Final source identity check — unchanged at the length and SHA-256 above.

### Step 2 — Native persistence authority and sidecar removal

Accepted on 2026-09-20. `project_config_overlay`, its C ABI, typed client and
runtime transport, Worker/mock state, React-store authority, and the
`Metadata/orca_neo_config_overlay_v1.json` production read/write/replay path have
been removed without an internal compatibility alias. Native Project, Plate,
`ModelObject`, and `ModelVolume` configuration is the sole persisted authority;
the Worker-to-React map is explicitly a disposable native snapshot. Plate
selection, virtual layout, and live filament/device state are runtime session
data and are not part of the archive.

Normal export omits the removed sidecar. A focused negative test injects it into an
otherwise valid archive and proves that opening the archive preserves the native
values and slice result without parsing or replaying any injected Neo-private
metadata. The native BBS writer now omits all `Metadata/orca_neo_*` members.
Geometry-only import clears imported object and volume values while preserving only
the valid native object `extruder` assignment. This step deliberately leaves
versioned receipts, revision-gap recovery, and exact key-erasing history roots to
later approved steps.

Parent acceptance checks passed:

- `pnpm typecheck` and `pnpm --filter @orca/slicer-wasm test` — passed; the latter
  reports 159/159 tests.
- Native scoped-configuration persistence and native interoperability harnesses —
  passed independently on both serial and threaded WASM artifacts.
- `git diff --check` — passed (only line-ending warnings); the immutable Odyssey
  source remains 45,586,816 bytes with SHA-256
  `6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`.

### Step 3 — Native mutation, exact history roots, and invalidation

Accepted on 2026-09-20. The former single-key native mutation ABI is replaced by
one canonical JSON request for atomic multi-target `set`, `reset`,
`reset-category`, and `reset-all` operations. It stages every target before
publication, parses through native PrintConfig, clamps direct numeric limits, and
leaves native state, plate revisions, and history unchanged on parse or target
failure. Individual reset erases the local key. Category and all resets preserve
the approved excluded domains: extruder, filament/rack/material fields, Layer
Range, Custom G-code, and scene-only coordinates.

The Project history root is now a complete native map replacement: restoration
removes keys absent from the historical root instead of merging them. Project
configuration is absent from the filament/rack history root; ordinary native
project settings retain valid local Project values. Invalidation is the target union: Project affects all plates; Plate only
itself; Object and Part every plate containing one of the target object's
instances. History restore applies the same minimal-set rule.

Parent acceptance checks passed against freshly staged `out/serial` and
`out/threaded` artifacts:

- Native mutation smoke on serial and threaded WASM — passed (atomic rollback,
  clamp, bad parse no-op, erase reset Undo/Redo, and reset exclusions).
- Native persistence precedence smoke on serial and threaded WASM — passed
  (no Neo-private metadata, injected legacy metadata ignored, native round trip, and
  geometry-only extruder-only import).
- Threaded history smoke, serial configuration-scope invalidation smoke, and
  threaded multi-filament command smoke — passed; the latter reports all measured
  undo/redo operations within its existing 100 ms budget.
- `pnpm --filter @orca/slicer-wasm test` — 159/159 passed;
  `pnpm --filter @orca/slicer-wasm typecheck` and `git diff --check` — passed.

### Step 4 — Versioned bridge/client/runtime transport

Accepted on 2026-09-20. Native scoped configuration now crosses the bridge as a
version-1 transport with a monotonic committed revision. Open, history restore,
and explicit refresh publish a complete snapshot; ordinary edits publish complete
per-target replacements. Deleted object, part, and plate targets are expressed as
stable `removed_targets` tombstones. The client/store replaces complete maps,
never shallow-merges them, and marks stale, gapped, or unknown-target receipts
refresh-required until it accepts a full snapshot. History commit publishes its
scene, plate, history status, and native scoped-config receipt at the same
revision.

Parent acceptance checks passed: WASM client tests 160/160, application tests
580/580, both package typechecks, and staged history/precedence harness coverage
including explicit part and deleted-object tombstones. The immutable Odyssey source
fixture remained unchanged.

### Step 5 — Shared Project / Scoped React surface

Accepted on 2026-09-20. The Settings surface now has a transient `Project | Scoped`
toggle. Both modes use the same metadata-derived native catalogue: Project mode reads
and writes only the Project map, while Scoped mode resolves the active Plate, Object,
or ModelVolume from Neo's existing selection contract. A mixed non-empty selection is
explicitly non-writable and never falls back to a Plate. The projection hides Plate
provenance for Object and Volume selections, shows selection-local provenance and
mixed values, and supports categories, search, typed and serialized draft fields,
individual/category/all-local reset, and non-interactive local-override markers in
the existing Object List. Generic material, Custom G-code, Layer Range, unknown, and
scene-owned coordinate keys remain excluded.

The mode resets to Project when a project session is initialized or reset and is not
persisted. Every configuration command captures its native targets and enters one
project-history transaction. Scoped commands now share the existing pending-field
queue, so a Slice command waits for an immediately preceding blur commit before it
reads the effective configuration.

Parent acceptance checks passed:

- `pnpm --filter @orca/slicer-app test -- --run` — 77 files, 588 tests passed.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `pnpm --filter @orca/slicer-wasm test -- --run` — 5 files, 161 tests passed.
- `git diff --check` — passed (only Windows line-ending warnings).

### Step 6 — Slice-time and structural-operation integration

Accepted on 2026-09-20. The serial Worker admission gate now explicitly rejects the
multi-target scoped command with `slice_busy` before it posts a native mutation or
history transaction. For threaded execution, an accepted configuration or structural
receipt invalidates exactly its native affected-Plate set and begins cancellation
asynchronously only when that set contains the active slice target. Unaffected plate
results remain available. The existing input-revision receipt checks continue to
reject stale Slice results.

Structural bridge operations now return authoritative native plate/session receipts
with complete native scoped-config transport and exact before/after affected Plate
sets. This covers the actual current structural API: deletion, cloning, object/volume
reorder, split-to-parts, split-to-objects, merge-to-multipart, separate instances,
instance add/remove, volume type changes, printable changes, and Plate reordering or
deletion. React consumes those receipts directly; it maintains no old-to-new scoped
configuration mapping. Test mocks mirror the observed native clone, split, and
separate-instance map ownership rules. The repository has no cut or generic
replacement bridge API, so this step does not invent one; any future endpoint must
return the same native receipt contract.

Parent acceptance checks passed:

- `cmd /c scripts\\build-windows.bat quick` — serial and threaded staged WASM builds
  validated successfully.
- `pnpm --filter @orca/slicer-wasm test -- --run` — 5 files, 165 tests passed.
- `pnpm --filter @orca/slicer-app test -- --run` — 77 files, 592 tests passed.
- `pnpm typecheck` and `git diff --check` — passed (only Windows line-ending warnings).

### Step 7 — 3MF interoperability and compatibility acceptance

Accepted on 2026-09-20 for the self-contained native and compatibility coverage. The
named serial and threaded scoped-configuration interoperability harnesses generate a
temporary native BBS 3MF golden and verify normalized Project, two Plate, Object,
normal Part, parameter-modifier, negative-volume, and support-blocker maps. They
also verify preservation of Layer Range data, normal Neo save/open round trip, no
Neo-private metadata on save or replay on open, and the established unknown-key
fallback (`compatibility: bambu`, project settings remain available, unknown key is
not re-emitted). No source user project is written.

The same harness implements the normal Neo -> Orca -> Neo stage as a strict optional
input: it copies a fixed Orca-saved archive to a temporary directory, then compares
the recognized normalized maps, Layer Range data, and absence of Neo-private metadata.
`--require-orca` fails if that external input is absent; no archive is fabricated.
This workstation has neither a provisioned fixed Orca-saved archive nor an Orca
executable, so the external invocation itself remains an explicitly recorded release
qualification input rather than a claimed pass. The fixture README records the pinned
upstream core revision and exact provisioning command.

Parent acceptance checks passed:

- `pnpm --filter @orca/slicer-wasm scoped-config-interoperability` — serial native
  golden, own round trip, private-metadata-negative, and unknown-fallback checks passed.
- `pnpm --filter @orca/slicer-wasm scoped-config-interoperability:threaded` — the
  same threaded checks passed.
- `node --check packages/slicer-wasm/harness/scoped-config-interoperability.mjs` and
  `git diff --check` — passed. The strict missing-external-input path was verified to
  fail rather than report a false Orca round trip.
