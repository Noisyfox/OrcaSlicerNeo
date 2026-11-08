# Orca Core Upgrade

**Status:** Implemented and locally qualified, with platform limits recorded below.
**Target:** OrcaSlicer 2.5.0 official release.
**Updated:** 2026-11-08

Upgrade the pinned Orca core while preserving Neo's delivered application,
project, preset and host contracts. The integration includes the native merge,
Neo's independently implemented adapters and interfaces, external dependencies,
bundled profiles and verification. Updating the submodule alone does not update
the React application or the independently built Bambu plugin interface.

Implementation is authorized in independently validated commits. The integration
branch was rebased onto `origin/main` at `abc00595` before implementation; the
original analysis baseline below remains the comparison reference. Preserve the
new main-branch Snapmaker and thumbnail integrations. The evidence section
records completed local checks and distinguishes unavailable platform coverage.

## Accepted decisions

| Group | Decision | State |
| --- | --- | --- |
| D1 Scope and compatibility | Existing-feature alignment and settings included; complete new workflows excluded; Belt/non-Primary parallel projects assumed absent | Accepted |
| D2 Native integration and dependencies | Upgrade older dependencies, retain equal/newer versions and existing libnoise implementation; preserve native/WASM integration contracts | Accepted; implementation requirements below |
| D3 Project and preset state | Preserve ordinary project/preset/history contracts; omit legacy user-filament migration and dedicated Texture Displacement project compatibility | Accepted; implementation requirements below |
| D4 Existing Prepare and slicing features | Follow upstream settings and material rules; adapt painting, exclusion geometry, tower estimates and device-material projection; inherit generated-tower checks directly | Accepted; implementation requirements below |
| D5 Printer integration | Keep OBN v2.2.0 and select ABI 02.08.04; leave Moonraker submission unchanged | Accepted; implementation requirements below |
| D6 Preview | Preserve opaque toolpaths; defer transparency and retain necessary core/renderer compatibility checks | Accepted; implementation requirements below |
| D7 Verification and delivery | Software-only acceptance across affected features, hosts and WASM variants; staged integration and deliberate native/pin publication | Accepted; implementation requirements below |

All seven groups are accepted. Implementation follows the independently testable
commit policy in D7.

## Owning specifications

This record owns the cross-component upgrade scope and integration decisions.
It does not replace the accepted contracts in the
[shared architecture](Web-Electron%20Shared%20Application%20Architecture.md),
[WASM reference](../doc/2026-08-12-wasm-build-notes.md),
[testing guidelines](../doc/testing_guidelines.md) or
[delivery roadmap](Grand%20Plan.md).

As integration is implemented, reconcile lasting feature behavior and verified
delivery status with the existing topic owner: [history](Undo%20and%20Redo.md),
[3MF persistence](3MF%20Project%20Persistence.md),
[user presets](User%20Preset%20Repository%20and%20Versioning.md),
[configuration](Project%20and%20Scoped%20Configuration.md),
[preset editing](Preset%20Editor%20Dialog.md),
[profiles](Profile%20Compatibility%20and%20Preset%20Selection.md),
[painting](Surface%20Painting%20Architecture.md),
[arrangement](Model%20Arrangement.md),
[multi-filament](Multi-Filament%20Support.md),
[objects and Boolean](ObjectList-and-Parts.md),
[preview](G-code%20Preview%20v2.md),
[GPU renderer](G-code%20Preview%20GPU%20Streaming%20Renderer.md),
[printer interaction](Printer%20Console%20and%20Control%20Integration.md) and
[printer execution](Printer%20Domain%20and%20Control%20Architecture.md).

## Comparison baseline

| Role | Immutable revision |
| --- | --- |
| Neo superproject at analysis | `87c2faffaeff42d3cc03863ea2485376fe36985e` |
| Orca gitlink at analysis | `e2cd10ba84a6f96e23827d2f851d0c4064a9eea3` |
| Common ancestor with the target | `a6dbf2502d0e0d6d6fcd7aa7b9089c397f3493a0` |
| Orca 2.5.0 target | `40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19` |

At analysis, upstream `release/v2.5.0` and `v2.5.0` both identified the target
above. Use the immutable commit for integration rather than following a moving
release branch. The source delta is common ancestor to target, not the entire
2.4-to-2.5 release announcement. The
[official release](https://github.com/OrcaSlicer/OrcaSlicer/releases/tag/v2.5.0)
provides context; source-level compatibility is determined by this delta and
Neo's current adapters.

Two useful exclusions from the announcement are already established:

- BBL's common process preset uses Grid infill at both ends of this comparison;
  that default is not a new change for this upgrade.
- Neo already carries the H2D Filament Track Switch production fix. Its native
  code changes match the upstream fix; the different patch identity comes from
  extra test support. Do not apply the production fix twice.

## D1 Scope and compatibility

### Accepted scope

Bring the current Neo feature set onto the official core, including upstream
behavior fixes and the adapter work needed to preserve that feature set. Include
new settings and exclusion-volume compatibility that affect existing slicing,
painting, arrangement, project persistence or printer submission. Detailed
editor coverage and collision diagnostic behavior are specified in D4.

Keep complete Python/plugin execution, CAD/Design, Belt workflows, IDEX/IQEX
parallel-print workflows, Texture Displacement editing, the full Publish editor
and H2C hotend-rack submission outside this upgrade.
Compiling their core data types or loading profiles does not establish support
for their complete application flow. Preserve ordinary Cartesian and supported
primary-tool behavior; do not reject an entire printer family solely because
some of its modes are unsupported.

### Accepted project assumption

Assume projects using Belt or non-Primary IDEX/IQEX parallel modes will not be
opened during this upgrade's supported use and acceptance. Do not add dedicated
mode detection, open/slice restrictions, conversion flows or qualification work
for those projects as part of this upgrade. This assumption does not establish
support for those modes or require removal of existing checks.

Transparent preview is excluded from this upgrade as accepted in D6. Existing
color metadata support does not imply transparent toolpath rendering.

## D2 Native integration and dependencies

### Merge invariants and conflicts

Native changes continue on `dev/orcaslicerneo-wasm`, following the source
ownership rules in the WASM reference. Preserve Neo's identity macros,
Worker execution, synchronous STEP path, JSON-only profile loading, native
history adaptations, preset edit ownership and MCUT threading adaptations.
Do not replace them with the desktop GUI or AppConfig lifecycle.

The three-way merge analysis identifies these textual conflict sites:

| File in the Orca submodule | Required reconciliation |
| --- | --- |
| `src/libslic3r/Format/STEP.cpp` | Retain Neo's synchronous branch and its preprocessor boundary; use the new `NCollection_Sequence<TDF_Label>` container. |
| `src/libslic3r/Preset.cpp` | Retain upstream replacement-file cleanup and Neo's independent selection/edited-preset behavior when saving library presets. |
| `src/libslic3r/PresetBundle.cpp` | Reconcile the `allow_cache` to `write_caches` change while retaining Neo's prohibition of both cache reads and writes. Upstream separately enables cache reads in vendor loading. |
| `tests/fff_print/test_multifilament.cpp` | Preserve both sides' useful cases and deduplicate common helpers. |
| `tests/libslic3r/test_config.cpp` | Retain upstream configuration semantics and Neo-specific coverage. |

Automatic textual merging is insufficient for the 3MF auxiliary/cover changes,
native preset ownership or MCUT notification behavior. Review the merged result
against those contracts as well.

### Accepted dependency policy

Neo's fetch/build/stage recipes are independent of upstream `deps/*.cmake`.
Updating upstream recipes alone does not rebuild the libraries Neo links.

For dependencies actually used by Neo, upgrade versions older than the Orca
2.5.0 standard recipes, including differences that predate this upstream delta.
Retain equal versions and Neo versions that are already newer. Do not downgrade
to obtain exact equality or automatically advance to an unrelated latest release.
Version alignment does not require replacing every platform adaptation or
introducing desktop libraries for excluded features.

| Dependency | Neo at analysis | Orca 2.5.0 recipe | Accepted treatment |
| --- | --- | --- | --- |
| CGAL | 5.6.3 | 6.2.1 | Upgrade; this upstream delta changes libigl AABB APIs, MeshBoolean includes/namespaces and adds MeshRepair code. |
| OCCT | 7.6.0 | 8.0.1 | Upgrade for existing STEP/XCAF import; include the target's seam-pcurve patch. |
| GMP | 6.2.1 | 6.3.0 | Upgrade with CGAL; this is an upstream recipe change. Neo uses generic C arithmetic, so the ARM assembly fix is not an established WASM failure. |
| Qhull | In-tree fallback 7.2.0 | External 8.0.2 | Upgrade the actual compiled library. This corrects an existing version difference; upstream did not change versions in this delta. |
| Expat | In-tree fallback 2.2.0 | Bundled dependency 2.5.0 | Upgrade the actual compiled library. This also predates the delta; upstream's recipe edit only removes a comment. |
| MPFR | 4.2.2 | 4.2.2 | Retain; revalidate the numerical combination. |
| Boost, including Nowide | 1.84.0 | 1.84.0 | Retain. |
| Eigen | 5.0.1 | 5.0.1 | Retain. |
| Draco | 1.5.7 | 1.5.7 | Retain. |
| NLopt | 2.5.0 | 2.5.0 | Retain. |
| cereal | 1.3.0 | 1.3.0 | Retain; archive format differences do not imply a version difference. |
| oneTBB | Commit `3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3`, version header 2023.1.0 | 2021.5.0 | Retain Neo's newer pin and WASM build; no downgrade or backport to 2021.5.0. |

Neo's oneTBB pin comes directly from the upstream oneTBB repository, not a Neo
fork. Preserve the separate serial TBB and Boost.Thread adaptations required
by the current execution model.

**libnoise remains unchanged by explicit decision.** Upstream still pins tag
1.0, with no recipe change in this comparison. Neo's
[libnoise shim](../packages/slicer-wasm/shim/libnoise/noise.h) is an existing
approximation used by Fuzzy Skin. Replacing it with the original implementation
would be a separate algorithm-alignment change, not this release's dependency
version upgrade. Record that difference without claiming identical Fuzzy Skin
output to desktop Orca.

The existing MD5 implementation is likewise a functional substitution, not an
older OpenSSL package. Preserve it under the existing feature scope. Neo's
WASM ZIP path uses in-tree miniz; it does not currently select an external zlib
library to align with the desktop recipe. Toolchain ports and host Node/Electron
libraries must not be mistaken for libraries linked into this WASM artifact.

| Desktop dependency change | Neo treatment under the accepted feature scope |
| --- | --- |
| libjpeg-turbo 3.0.1 to 3.2.0 | No original library is linked to upgrade; the corresponding interface is stubbed. |
| libpng 1.6.35 to 1.6.59 | Native path is excluded/replaced; introducing the library is outside this version upgrade. |
| OpenCV 4.6.0 to 4.14.0 | Relevant texture paths remain excluded from the current build. |
| FreeType removed upstream | Retain Neo's FreeType-off OCCT policy and reassess obsolete external patches. |
| wxWidgets, Python, OpenSSL, GLEW/OpenCSG build changes or removal | Do not add these desktop libraries solely to match a dependency list. |

### Dependency integration requirements

CGAL migration spans the [numerical recipe](../packages/slicer-wasm/dependencies/cgal/build.mjs),
[shared interface](../packages/slicer-wasm/dependencies/cgal.cmake),
[main CMake scaffold](../packages/slicer-wasm/CMakeLists.txt),
WASM32 generation, stage verification and CI cache identity. Preserve
`CGAL_ALWAYS_ROUND_TO_NEAREST=1`, `CGAL_USE_GMPXX=1`, and serial's no-thread/no-TLS
configuration. The implementation default follows upstream by enabling
`CGAL_LINKED_WITH_TBB` in threaded builds, while leaving it undefined in serial
builds with `CGAL_HAS_NO_THREADS=1`. Defining it as zero is not equivalent to
leaving it undefined. The macro affects type layout: all CGAL consumers within
one artifact, including bridge code, must receive consistent definitions.
Audit interface propagation instead of defining it only on the core target.

New `MeshRepair.cpp` enters Neo's recursive source collection even without a
Fix Model interface. Validate an actual `Parallel_if_available_tag` path as
well as existing numerical/Boolean behavior. Existing Boolean operations use
MCUT; this configuration does not promise a Boolean or slicing speedup and
does not add a repair interface or CGAL precheck.

For the GMP upgrade, reassess Neo's source lists, configuration template, native
table generators, limb-width handling and configure compatibility adjustment.
Archive replacement alone is not a sufficient recipe migration.

OCCT migration covers shell and cmd fetch/build helpers, include/stage layout,
toolkit link lists and WASM32 dependency probes. Recompute the STEP closure for
`TKDESTEP`/`TKDE` instead of retaining the old `TKXDESTEP`/`TKSTEP*` list.
Reassess the existing wasm64-bitness and FreeType patches against 8.0.1; do not
blindly reapply or remove them. Explicitly apply upstream's new seam-pcurve
external dependency patch, which fixes missing conical chamfers in 8.0.1.
Preserve Neo's synchronous reader and controlled meshing, while accepting
upstream shell/loose-face import support.

Neo currently compiles Qhull and Expat directly from older `deps_src` fallbacks;
the standard desktop dependency build selects the newer packages instead.
For Qhull, add the pinned 8.0.2 WASM dependency stage, use matching headers and
`qhullcpp`/`qhullstatic_r` libraries, and remove duplicate old-source compilation.
For Expat, switch source, headers and configuration together to the bundled
2.5.0 dependency. A merge or version-label edit alone changes neither selection.
Cover existing convex-hull/arrangement and 3MF/AMF XML parsing behavior.

In-tree dependency changes arrive with the merge: admesh's binary-STL detection,
libnest2d's conditional collision metadata, libigl's CGAL migration and semver's
prerelease ordering. For MCUT, retain Neo's queue lock and serial scheduling
alongside upstream notification changes. Continuous subtraction now re-splits
disconnected components after each cut. Isolated-vertex cleanup protects CGAL
conversion; it does not establish that every MCUT failure is resolved.

The actual miniz, Clipper2, glu-libtess, qoi, fast_float, nlohmann, earcut and
ankerl subtrees are unchanged between the current pin and target. Keep them
under submodule source ownership; no independent version bump is required.

Use fresh, versioned dependency stages for the changed libraries. Update shell
and Windows cmd recipes, WASM32 generation, stage checks and CI cache identity
together. Verify the four address-width/threading combinations with consistent
headers, libraries and definitions; an incremental build against old stages is
not acceptance evidence. D7 defines the broader fixture and host gates.
If implementation exposes a compatibility failure that requires departing from
these defaults, bring back the concrete failure and alternatives for discussion.

## D3 Project and preset state

### Accepted assumptions and exclusions

Neo has not been formally released and there are no existing custom filament
presets requiring legacy compatibility migration. Do not add automatic
detection, reminders, migration actions or migration-specific acceptance work.
The upstream legacy-compatibility resource may continue to follow the existing
`resources/info` preload; its presence does not require a Neo migration workflow.
This decision does not remove current user-preset creation, editing or saving,
or the need to preserve their existing transaction contracts during the merge.

Assume 3MF projects carrying Texture Displacement-specific data will not be
opened during this upgrade's supported use and acceptance. Do not add dedicated
project detection, restrictions, conversion, payload-preservation interactions
or qualification for those projects. This assumption does not exclude ordinary
3MF, STL or OBJ inputs, require removal of existing checks, or establish support
for Texture Displacement. Necessary compilation, linking and native-state
adaptation remain part of the upgrade.

### Existing-state integration requirements

| Source change | Required adaptation within the accepted scope |
| --- | --- |
| `auto_drop` moves from ModelInstance to ModelObject | Move the history fingerprint and restoration handling to the object. Cover multiple instances, copying, ordinary old/new 3MF and Undo/Redo; preserve the existing manual Drop to Bed interaction. |
| ModelVolume cereal state gains UV and texture payloads | Conservatively disable cached capture reuse for volumes carrying UV or the new texture payloads. Let native cereal capture the actual state instead of assuming the existing handwritten fingerprint is complete. |
| Preset replacement and variant fixes | Preserve Neo's immutable versions, draft ownership, host persistence and atomic failure recovery. Cover current/non-current Save, Save As/overwrite, inherited variants, nullable overrides and restore. |

The concrete adaptation owners include
[history](../packages/slicer-wasm/src/bridge_history.cpp),
[capture fingerprints](../packages/slicer-wasm/src/history/MutableObjectCaptureCache.hpp),
[user presets](../packages/slicer-wasm/src/bridge_user_presets.cpp) and
[project persistence](../packages/slicer-wasm/src/bridge_project_persistence.cpp).

Retain native `auto_drop` compatibility: new object metadata takes precedence;
for legacy build-item metadata, any instance set to off makes the object off;
the default is on. Neo has no automatic-drop toggle to introduce in this upgrade.
Its manual Drop to Bed command remains an independent transform operation.

Upstream preset replacement can remove an old file and select a different path
based on the new parent. Audit Neo's transaction watch set, persisted changes
and failure recovery across both old and new paths. Its current preparation
explicitly watches the original destination and returns one new-file change;
resolving the textual conflict alone is not proof that the merged operation
preserves atomicity. This is an integration check, not a confirmed existing bug.

The native 3MF reader/writer brings fixes for projects with fewer filaments than
tools, missing filament indices, Full Publish variant columns, parentless
materials, old custom materials, mirrored transforms, cyclic component
references and thumbnail relationships. Neo's post-load draft reconstruction,
rack resizing and material mapping must preserve those results. Retain the
existing native auxiliary/cover behavior; do not add a separate ZIP preservation
mechanism or Publish authoring interface.

### UV and texture integration boundary

The target OBJ loader can populate `texture_uv`, but only when per-face
materials resolve through MTL and produce matching UV data. Neo currently stages
a single uploaded model file; an end-to-end companion-MTL path has not been
established. Do not claim every OBJ with `vt` entries produces live UV state.
The history adaptation above is a native-state correctness requirement, not a
new multi-file importer or UV editor.

Native cereal includes UV, texture masks, layers and options, including layer
image bytes. Upstream deliberately excludes uncommitted GUI preview adjustments.
Preserving this session state does not promise a complete OBJ-UV-to-3MF round
trip: the target 3MF format does not save or restore `texture_uv`. Do not add
that new format capability as part of the upgrade.

The new 3MF reader/writer calls texture-layer JSON helpers defined in
`TextureDisplacement.cpp`, which Neo's CMake currently excludes. Resolve this
source/link boundary during integration, retaining the necessary lightweight
serialization or applying appropriate build guards without pulling in the full
excluded displacement implementation. Assuming such projects are absent does
not by itself resolve linker references. This remains a source-audit finding;
the upgraded combination has not been built yet.

For existing topology-changing operations, verify the target's native reset
behavior for per-face state: `reset_extra_facets()` clears masks and UV, but not
all layers/options. Do not add special preservation/discard interactions for
the excluded Texture Displacement projects or infer that every current project
has a history defect from the missing cache proof.

## D4 Existing Prepare and slicing features

### Painting

`TriangleSelector` inserts `up_direction` before the existing boolean argument.
Neo's [painting session](../packages/slicer-wasm/src/painting/PaintingSession.cpp)
and tests need the new signature. Ordinary Cartesian painting uses `UnitZ`;
this adaptation does not itself implement Belt painting.

Upstream's support-painting threshold fix uses zero to disable the filter and
otherwise `min(angle + 1 degree, 90 degrees)`. Align brush/Smart Fill restrictions
and [highlight candidates](../packages/slicer-wasm/src/painting/NativeSelector.hpp)
together so the visible region agrees with the paintable region. Cover boundary
angles, transformed and mirrored volumes, preview/commit and history.

### Arrangement and Prime Tower geometry

[Headless arrangement](../packages/slicer-wasm/src/arrangement/HeadlessArrangement.cpp)
currently constructs rectangles from the legacy excluded-bed points. Upstream
supports exclusion volumes with Z ranges and physical-nozzle ownership in
shared, toolhead-offset and per-extruder modes. Consume the
native region parsing and populate both obstacle and object metadata rather
than creating a second geometry interpretation.

[Prime Tower checks](../packages/slicer-wasm/src/bridge_prime_tower.cpp) and
[slice diagnostics](../packages/slicer-wasm/src/bridge_slicing_pipeline.cpp)
use independently maintained geometry and diagnostic projections. Review their
compatibility with the target data and normal error/warning propagation without
duplicating checks already performed by the native slicing pipeline.

**Accepted generated-tower check policy:** directly inherit the upstream checks
through the native merge, with no additional adjustment, downgrade or bypass
for them. The target checks the generated tower's actual footprint, including
brim and ribs, inside `print.process()` and throws `SlicingError` for an
out-of-bounds footprint or intersection with the excluded bed area. Neo's
existing processing-exception path already reports this as slicing failure.
Verify that result through the existing pipeline; do not implement a second
check or change the native execution path to continue after this failure.
The previous Neo pin already contains these generated-footprint processing
checks. Preserve them during the merge; do not describe them as a newly added
Neo policy. The target changes the wording of the two existing pre-slice
exclusion/clumping diagnostics, so their exact matches must follow the target
while retaining the same advisory boundary.

Pre-slice `print.validate()` and `print.process()` are separate failure points.
An existing Neo validation advisory permits processing to start; it does not
guarantee that processing will succeed. Do not extend the validation downgrade
logic to suppress native processing errors, or report an interrupted
process as successful. Geometry adapter work remains necessary where Neo itself
consumes exclusion regions, independently of this directly inherited check.

Native fixes for short objects in sequential printing, fixed objects at the
bed edge and rotated occupancy arrive with the merge. Test current/all-plate
arrangement, locks, painting-aware nozzle mappings and tower footprints.

### Accepted settings synchronization

Neo's [settings layout](../packages/slicer-app/src/components/workspace/settings/printSettingsLayout.ts)
uses an explicit allow-list, and its
[availability conditions](../packages/slicer-app/src/components/workspace/settings/settingConditions.ts)
are independently implemented. New native schema entries do not automatically
produce a complete interface.

Synchronize the following existing-feature settings using the target's groups,
defaults, experimental markers and visibility/enabled conditions. Preserve
existing preset values; do not proactively enable the new options. The current
generic editors already support these scalar types, so this requires layout,
condition and contract adaptation rather than a new control framework.

| Settings | Target behavior and editor requirements |
| --- | --- |
| `adaptive_infill_mode`, `adaptive_infill_interior_density`, `adaptive_infill_gradient` | Experimental density variation for Gyroid, TPMS-D and TPMS-FK. Mode defaults off; interior density defaults to 5% with a 1–100% range; gradient defaults to linear, with quadratic/exponential alternatives. Show the mode only for eligible patterns with sparse density above 0 and below 100%; show the other fields when enabled. |
| `infill_complete_top` | Complete the top of the 3D Honeycomb infill pattern, not the model's top shell. Default off; show for 3D Honeycomb with sparse density above 0. |
| `top_color_penetration_layers`, `bottom_color_penetration_layers` | Control painted surface color penetration into the interior, including sparse infill beyond the shell thickness. Default 0 follows the corresponding shell-layer count; place beside top/bottom shell settings. |
| `high_precision_gcode` | Experimental Expert setting, default off. Increase coordinate/extrusion precision; do not describe it as applying uniformly to support output. |
| `exclude_object_tolerance` | Simplify the object contour in Klipper `EXCLUDE_OBJECT_DEFINE`, not printed geometry. Default 0.1 mm, range 0–5 mm; 0 retains every point. Show only for Klipper with object exclusion enabled. |
| `enable_arc_fitting` | Replace the boolean presentation with disabled/enabled/sparse-infill enum modes. Definition default is disabled; retain the target's extrusion-rate-smoothing availability rule. |

Update separable/smoothable infill predicates and applicable firmware conditions
together with the fields. The fixed target shows Wipe inward distance solely
when `wipe_inward` is enabled; it has no wall-order visibility gate. In particular,
the existing `gyroid_optimized` option is hidden when adaptive density is enabled;
it is not itself a newly added setting.

Use the existing generic enum editor for arc fitting and upstream legacy-value
normalization when reading older files. Keep one current enum contract internally.
Preserve old bool-value fixtures as compatibility inputs, and cover field editing,
Undo/Redo, preset saving and 3MF reopening with the new schema.

### Accepted material selection and tower estimation

Inherit upstream's feature-filament Default semantics and grouping algorithms.
Default follows the object's/part's filament rather than another feature's
explicit override. For example, at process scope with object filament 1 and
internal solid infill explicitly set to 2, top surface Default resolves to 1.
The target removes the old normalization cascade between sparse infill,
internal solid infill and top/bottom surfaces. Do not generalize the historical
difference to every scope: an already-explicit object extruder could resolve
Default before that old cascade ran.

Actual slicing inherits the native normalization fix. Neo's existing feature
editor already describes Default as object/part inheritance, so retain that
meaning. Explicitly saved filament choices remain explicit; do not guess that
a saved 2 used to mean Default. Support Default is a separate rule and is not
changed by this correction; bridges continue to follow internal solid infill.

Neo's independent used-slot calculations in
[Prime Tower estimation](../packages/slicer-wasm/src/bridge_prime_tower.cpp)
still make top/bottom Default follow internal solid infill. Synchronize those
calculations with the target and verify tower visibility, usage summaries and
estimates against actual slicing. The old rule needs adaptation; the audit does
not establish that every two-filament example produces a different used-slot set.

Convenience/Match mode adds filament identity as a tie-breaker after color:
among same-color candidates, prefer the same material subtype. Neo's
[device-material projection](../packages/slicer-wasm/src/bridge_nozzle_mapping.cpp)
already receives `orca-filament` catalog references but currently uses them only
to identify support material. Pass that existing identity into native
`filament_id` as well. Filament-saving/Flush mode's preference for loaded
materials is a separate upstream algorithm change and arrives through the
merge; do not describe both modes as using the new identity tie-breaker.

The model side also needs the selected presets' identities. Neo's static
`PresetBundle::construct_full_config()` previously omitted `filament_ids` in
its multi-slot branch. Collect each preset's metadata ID there, matching the
ordinary native GUI assembler. Verify the actual model IDs before checking a
same-color mapping, so an accidental color tie is not mistaken for ID matching.

Keep these algorithms in the core. Verify same-color materials of different
subtypes, mixed nozzle diameters, loaded-slot preference, external holders and
missing device/material identities through the existing Neo interfaces.

### Core behavior and profile changes

| Native change | Required comparison |
| --- | --- |
| Feature filament Default uses the object's/part's filament | Cover individually overridden sparse/solid/top/bottom settings, global/scoped inheritance and Neo tower-used-slot agreement. Preserve explicit saved choices. |
| H2D/X2D mixed nozzle diameter handling | Line widths, layer limits and towers use the actual mapped nozzle; cover left/right swaps, support materials and first layer. |
| Per-filament Z-hop | Cover a single-nozzle multi-material print with different filament limits. |
| Bridge speed, Arachne scarf/arc fitting, Wipe inward and Klipper tower fixes | Use focused output assertions for the corrected behavior. |
| Lightning, tree supports, TPMS/Gyroid and Spiral Inset fixes | Exercise termination, XY clearance, path ordering and solid-fill coverage. |
| Travel optimization and slice/reset memory fixes | Check repeated slicing, multiple retained plates and clearing a long-lived Worker; do not adopt upstream percentages as Neo performance results. |
| 64-bit post-slice extruder masks | Preserve native result-to-3MF handling and test high bits. Neo currently has no JS numeric/bitwise mask consumer requiring a BigInt protocol migration. |

Rebuild all [profile packages](../packages/profile-resources/scripts/build.mjs),
not only BBL. The delta includes new vendors and changes to compatibility lists,
inheritance, aliases, filament IDs, nozzle variants and painting penetration.
Exercise Wizard activation, restored selections, saved user presets and imported
projects against the new catalogue.

BBL's actual changes include infill-retraction configuration, explicit P2S arc
settings, filtration capability/settings, some `use_3mf` values and start G-code.
Its Grid default predates this comparison. Preserve upstream compatibility
normalization rather than implementing local conversions for each profile.

## D5 Printer integration

### Accepted Bambu ABI upgrade

Upstream selects ABI series `02.08.04` and adds `queue_plate_id` to PrintParams.
Neo selected `02.08.01` at analysis; its declaration guard detects the drift.
The current OBN v2.2.0 archives for all six desktop targets already contain
`v02.08.04`. Keep the OBN release at v2.2.0 and retain the archive URLs/checksums;
change the selected ABI series, source identity and exact runtime-version
expectations. OBN's release number and the plugin ABI series are separate
identities; this upgrade does not require a newer OBN release.

Update the [artifact manifest](../packages/bambu-native/artifacts.json),
[PrintParams declaration](../packages/bambu-native/native/print_params.hpp),
[ABI guard](../packages/bambu-native/scripts/verify-declarations.mjs), native
printing gate, [runtime](../apps/desktop/src/utility/bambu/runtime.ts),
[camera version parameter](../apps/desktop/src/utility/bambu/media.ts) and
fixtures as one coherent ABI migration. The struct is passed by value, so
changing only the declaration or removing the guard is not an alternative.
Keep `queue_plate_id` empty for the existing ordinary print workflow. Do not add
a queue-printing interface or parallel old/new ABI support.

Re-stage the complete `lib/v02.08.04` directory, including the networking,
BambuSource and companion libraries, rather than replacing only the networking
library. Match the runtime's exact version expectation to `02.08.04.99` and the
native print gate to the selected `02.08.04` ABI. Camera's `net_ver` should come
from the loaded plugin version. Preserve the HTTP client identity
`02.08.01.55`: the target upstream still uses that value, independently of the
plugin version. Do not mechanically replace it in login headers or User-Agent.

Validate declaration agreement, addon rebuild, native print/camera fixtures,
desktop startup and six-platform packaging/startup. Archive contents alone do
not establish runtime or physical-printer qualification; D7 retains that
distinction.

### Accepted Moonraker deferral

Leave Neo's Moonraker behavior unchanged in this upgrade. Its
[HTTP transport](../packages/printer-control/src/moonraker-http.ts) uploads the
file, and the existing [Send UI](../packages/slicer-app/src/components/send/SendGcodeDialog.tsx)
starts printing through a separate request for Send & Print. Plain upload and
existing uncertain-outcome handling also remain unchanged.

Upstream's upload-and-print change was identified: it sends `print=true` with
the upload, consumes `print_started`/`print_queued` and conditionally performs a
separate start. Porting that behavior to Neo is explicitly deferred. Do not add
the new upload flags, queued-result handling, fallback changes, submission
capability expansion or dedicated qualification for that change in this upgrade.

### Existing equivalents and exclusions

Neo already retains compatible user presets during AMS sync, stops discovery
before destroying the Bambu agent, remembers device selection, and implements
the supported AMS alpha/gradient firmware gates. Preserve those behaviors rather
than adding parallel desktop mechanisms. The H2C rack/dynamic-nozzle path, AMS
firmware switching and wx camera WebView changes do not expand current Neo scope.

Printer definitions do not change in this comparison. HMS JSON changes are
format-only and the changed images are compressed; normal repackaging is
sufficient, with no identified new action schema to translate.

## D6 Preview

### Accepted display boundary

Keep Neo's current opaque toolpath display. Transparent preview is explicitly
deferred: do not add a translucent-filament switch, RGBA preview transport,
transparency blending/order passes, alpha-aware legends or related qualification
as part of this upgrade. Existing rack alpha/gradient metadata remains under
its current contract and does not expand the preview scope.

Neo's [WebGL renderer](../packages/slicer-app/src/components/workspace/viewport/gpuStreamingRenderer.ts)
adapts SegmentTemplate independently of libvgcode::Viewer. Upstream viewer fixes
do not automatically change its shaders, buffers or lifecycle. Native type or
API changes still require compilation compatibility while preserving the current
preview interface and display behavior.

### Template compatibility checks

The upstream fixes concern two different GPU inputs:

- `1a9201690d` changes the template element-index buffer from uint8 to uint16
  for a driver compatibility issue. Neo uses an expanded non-indexed draw with
  24 invocations; do not introduce indexed rendering to copy this fix.
- `812ce9f055` changes the template `vertex_id` attribute from uint8 to uint32,
  giving it a four-byte stride for a Parallels/Metal-backed OpenGL issue. This
  is a vertex-fetch compatibility fix, not an increase in path identifier
  capacity. At analysis, Neo used a packed one-byte `Uint8BufferAttribute` for
  that input, so assess the corresponding WebGL/Electron/browser behavior.

The native driver result does not establish that Neo has the same failure.
If needed, use a four-byte representation compatible with Neo's existing float
shader input and verify visible toolpaths, preserving the 24-invocation template.
These compatibility checks are independent of transparent rendering. Preserve
layer/move controls, source-line mapping, analysis, earlier-layer dimming,
resource release and both host boundaries.

## D7 Integration sequence and acceptance

### Accepted implementation sequence

| Step | Integration unit | Exit condition |
| --- | --- | --- |
| I1 Baseline | Fix the source/artifact identity and representative input corpus | Compare old Neo and target Orca with known resolved settings; preserve repeatable inputs. |
| I2 Native and dependency integration | Merge the target, reconcile native invariants and build new dependency stages | New libraries and source closure compile together; no reliance on stale stages. |
| I3 Contract adaptation | History, presets, painting signatures, config types and Bambu ABI | Focused correctness and boundary guards pass with real artifacts. |
| I4 Existing feature alignment | Exclusion geometry, fields/conditions, grouping and profiles | Supported projects can import, edit, undo, slice, save and reopen correctly. |
| I5 Host and preview compatibility | Bambu runtime/camera/packaging and native-interface/template-input compatibility while retaining opaque preview | Existing printer software and preview contracts pass their affected checks. |
| I6 Qualification and pin delivery | Cross-host/variant checks and publication of validated native code | The superproject gitlink references an available, reproducible validated commit. |

These stages describe integration order, not a mandatory one-commit-per-row
split. I2 and I3, including the required Bambu ABI changes, may need one
coordinated integration workspace: the new core needs new dependencies, and
the old bridge or addon can fail against its new interfaces. Split commits into
complete, independently testable units after that combination is valid; do not
present an intermediate incompatible combination as an accepted build.

Commit native source on `dev/orcaslicerneo-wasm` and deliberately update the
superproject pin. Before publishing a superproject revision, make its referenced
submodule commit available from the configured remote. Dependency and bridge
work belongs to the superproject. Do not introduce Orca-source patch files.

### Accepted software acceptance scope

The [testing guidelines](../doc/testing_guidelines.md) own execution frequency;
the [build reference](../doc/2026-08-12-wasm-build-notes.md) and driver help own
commands. Final software handoff includes `pnpm test`, `pnpm typecheck` and
affected boundary checks, in addition to the focused evidence below.

This upgrade changes the shared core and dependencies with address-width and
threading assumptions, so its final gate includes all four WASM artifacts:
wasm64 and wasm32, each threaded and serial. Build current-source artifacts and
verify numerical, import, slicing and width/thread boundaries on those variants.
Changed dependencies use fresh versioned stages; unchanged dependencies may be
reused when their version, recipe, compiler and artifact identity checks pass.
During iteration, use the smallest relevant variant and regression fixture.

| Boundary | Acceptance focus |
| --- | --- |
| Dependency stages | Version/recipe/compiler identity, address width, threading mode, hashes and fresh numerical/OCCT/Qhull/Expat builds |
| Numerical and Boolean backend | CORE arithmetic, MPFR rounding, libigl/CGAL/MCUT, repeated contexts, serial no-worker behavior and continuous difference |
| Import | Binary STL, Expat-backed 3MF/AMF XML, multi-solid/shell/loose-face STEP, curved/chamfered surfaces, progress/cancellation and repeated import |
| History and persistence | Multi-instance transforms, painting, geometry replacement, user-preset versions, nullable overrides, auxiliary ZIP relationships and old/new 3MF |
| Slicing | Explicit feature filament assignment, mixed nozzles, towers, exclusions, supports, infill, arcs and repeated multi-plate processing |
| Profiles | Full vendor catalogue, activation, aliases, inheritance, variants and restored selections |
| Preview and hosts | Real import/edit/slice/preview/save flow, source mapping, memory cleanup, Electron packaging and Web loading/fallback seams |
| Printer software | Six-platform Bambu plugin/ABI startup and relevant print/camera/storage fixtures; no new Moonraker submission behavior |
| Platform builds | Shell and Windows cmd recipes, CRLF batch files, toolkit discovery and link closure |

Use target-version native Orca with identical resolved profiles/settings for
output comparison. Old Neo output identifies intended upgrade deltas; byte-for-
byte equality to the old output is not a general acceptance rule. New algorithm
behavior and performance must be demonstrated on Neo's actual artifacts.

Reuse existing fixtures where they cover the accepted changes. The representative
corpus includes numerical/Boolean operations; binary STL and curved/multi-shell
STEP; convex hulls; ordinary 3MF with multi-instance transforms, painting,
Undo/Redo and attachments; preset replacement/failure recovery; single and mixed
materials/nozzles; Default and explicit feature assignment; tower/exclusion
cases; representative support, infill and arc paths; new settings and the full
profile package. Follow the explicit exclusions in D1, D3, D5 and D6 rather than
adding legacy-filament migration, unsupported-project or deferred-feature suites.

Run one complete real-WASM import/edit/undo/slice/preview/save journey in the
primary host. Use the other host to cover actual file and runtime boundaries,
not to repeat every shared UI scenario. wasm32 is Web-only; cover a browser
without Memory64 and isolated/non-isolated selection of threaded/serial assets.
Electron qualification must rebuild/stage the current WASM into the renderer
and verify artifact identity; setting a runtime flag alone is insufficient.

For each of the six Bambu desktop targets, distinguish archive/staging checks,
addon build/package checks and actual startup evidence. Use software fixtures
for print parameters, Camera and storage boundaries. Report unavailable runners
or artifacts as unverified qualification gaps; packaging or archive presence
must not be counted as a startup pass. Record the commands actually run, results
and any skipped checks in the implementation handoff.

This upgrade uses software-only acceptance. Physical printing and other real
device operations are outside the accepted work. Keep existing hardware
qualification limits in the owning printer specifications; software checks do
not replace that evidence.

### Implementation evidence

The implementation preserves the accepted exclusions. Moonraker, transparent
preview, libnoise and the newer oneTBB pin remain unchanged. Native code is
committed on `dev/orcaslicerneo-wasm` at
`8f2cfb8c79ab5374fd1ead4f1f3ac2f3e42934f4`, merging the immutable target above.
The superproject deliberately pins that commit. Commits are local; neither
repository has been pushed as part of this work.

| Area | Verified local evidence | Remaining qualification |
| --- | --- | --- |
| Settings and preview inputs | 117 focused settings/editor tests; 13 renderer tests; complete workspace typecheck and tests | Default-concurrency test limitation below |
| Dependencies and builds | SDK 6.0.13; all four production artifacts build and validate; all 16 numerical/OCCT/Qhull/Expat stage verifiers and four-mode arithmetic/hull/XML probes pass; 12 recipe/scaffold tests pass | Windows execution |
| Native state adapters | Eight standalone C++ suites pass: timestamped history, instance identity, mesh capture, painting, preset erase, plate registry and both arrangement suites | Native GUI build is not covered |
| Real bridge contracts | Nine final threaded harnesses pass: Project preset/history, user presets, user-preset 3MF, scene geometry, Convenience, native tower inputs, slice notifications, tower settings and multi-filament step 13 | Physical devices are excluded |
| Numerical and Boolean | All four backend variants pass in Node and Chrome; serial creates no internal Workers and uses no shared memory. Typed operation suites pass 25 tests per variant, with two fault-build-only cases skipped. Real Chrome slice followed by a single-context union passes | Dedicated fault-injection build not rerun |
| Import and arcs | All four variants pass STEP and AMF/arc harnesses; 26 STEP assertions per variant include seam closure, loose faces, named solids/shells, slicing and malformed-input atomicity | Broader algorithm equivalence is not claimed |
| Profiles | Rebuilt all 73 packages from the committed native tree; all 15,777 archive members match source bytes; complete packages match the already-tested distribution byte for byte | None for this catalogue rebuild |
| Hosts and preview | Final Electron import/edit/Undo/Redo/slice/Preview/export/save/Clear/reopen passes with matching source/public/renderer assets. Real Web serial download and WebKit wasm32 threaded/serial selection and download pass; hashes and Worker states match each selected variant | Other OS host startup |
| Bambu | Declaration guard, addon build, print/camera fixtures and all six archive/stage identities pass; actual macOS ARM64 plugin version and no-credentials print ABI are exercised in Node and Electron | Other five target startups; authenticated discovery/device operations |

The final host journeys retain trace and screenshot evidence. The Electron
journey deliberately makes Bambu unavailable before native loading and uses an
empty printer configuration; it does not qualify authenticated printer startup.

Repository checks were `pnpm typecheck` and `VITEST_MAX_WORKERS=2 pnpm test`, both
exit 0. The initial default-concurrency `pnpm test` run failed three 5-second UI
timeouts in `projectThumbnails.test.ts` and `PresetEditorDialog.test.tsx`; the
complete bounded-concurrency rerun passed without changing tests or timeout
values. This establishes that run's result, not a root-cause fix for those
timeouts. Recipe checks used `pnpm exec node --test` with
`dependencies/cgal/build.test.mjs`, `dependencies/external/build.test.mjs`
(under `packages/slicer-wasm`) and `scripts/build-wasm32.test.mjs`.

Each variant's backend was run with `run-mesh-boolean-backend.mjs <module> --browser`;
typed operation checks used `ORCA_MESH_BOOLEAN_MODULE=<production module>` with
`pnpm --filter @orca/slicer-wasm exec vitest run harness/mesh-boolean.native.test.mjs`.
The primary host ran the real `full v1 flow:` case in `apps/desktop/e2e/app.e2e.ts`.
The secondary host ran `real Web G-code export downloads` in the Web config,
then the wasm32 Playwright config with isolation enabled and disabled. No
test timeout was increased.

Local production WASM SHA-256 identities after the final native adaptation:

| Variant | SHA-256 |
| --- | --- |
| wasm64 threaded | `32a5cc89f8eec2dd7d9951df62c8c2f14bb48151d23dd5c46ca51a31345efc1a` |
| wasm64 serial | `cd179de3de404fec5a775db16df28253d79c2b16f790599d4c3fb0ce0ca25cc8` |
| wasm32 threaded | `db4db438013e898442100a0545b426c4b32f8d4dad04ccbfe79282f6d336b5ae` |
| wasm32 serial | `415f0cbd05250a9c8e395c033b2728918b4305cac69de0c418da5d4ab81e8597` |

The official macOS 2.5.0 CLI sliced the same three pre-slice 3MF inputs used by
the arc fixture. Both engines produced 50 layers and identical feature-level
arc counts: enabled has 185 G2 and 1,037 G3 moves, sparse-infill-only has 504 G3
moves exclusively in Sparse infill, and disabled has none. All four Neo variants
agree. Final input ZIP members and resolved snapshots are byte-identical to
those used for the official comparison. Neo's existing layer-before `G92 E0`
injection, synthetic AMS capacities and inheritance/compatibility metadata still
differ from the CLI's effective output. This validates the fixture's arc-mode
semantics, not complete G-code/config equality, a performance comparison with
old Neo, or equivalence of every upstream algorithm.

The preset regression exposed an integration detail that textual merging did
not catch. Orca now removes and recreates an overwritten library preset. When
Neo saves a child over a root ancestor, native Save As would otherwise replace
the intended empty parent with the source child, forming a cycle. The bridge
preserves the empty parent through native detachment; the existing overwrite
test now asserts the exact parent and passes Undo/Redo and durable reload.

The combined backend test also needs more precreated browser pthreads than the
product's single-context Boolean operation: it retains TBB workers and exercises
additional libigl threads and two MCUT contexts. Its dedicated pool is bounded
by `max(8, 2 * hardwareConcurrency)`. This is a test-only resource requirement;
the product pool and execution contract remain unchanged. The runner now retains
ordinary stderr so thread-pool exhaustion is visible on failure.

Focused native clang-tidy checks cover 18 adapted files using the WASM compile
database: 17 pass, while STEP retains one known include-cleaner mapping warning
for the Boost.Thread shim. STEP directly includes the correct public Boost
header; the shim's private forwarding layout is not understood by this check.
The local tool is 22.1.4 rather than CI's 22.1.8, and unsupported Emscripten
backend flags were removed from the analysis-only compile database. This is not
a claim of a clean native GUI or cross-platform clang-tidy run.

Windows cmd recipes receive syntax/CRLF and source checks locally; Windows
execution and the unavailable Bambu startup platforms remain unverified.
Physical-device operations remain outside the accepted scope. Remote CI and
publication were not requested and have not been performed.
