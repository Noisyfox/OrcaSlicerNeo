# Grand Plan

**Updated:** 2026-10-11
**Scope:** Current delivery status and remaining product work.

This is the single roadmap. Topic specifications own behavior; engineering
runbooks own build and verification procedures. See the
[documentation index](../doc/README.md) and
[shared architecture](Web-Electron%20Shared%20Application%20Architecture.md).
Consolidation does not constitute a new release qualification.

## Delivered capabilities

| Area | Current scope and authority |
| --- | --- |
| Foundation and hosts (M0–M4, M9) | Shared React application, thin Electron/static-Web hosts, dual wasm64 runtime and packaging. [Shared architecture](Web-Electron%20Shared%20Application%20Architecture.md) replaces desktop-only and AppConfig-era designs. |
| Scene and transforms (M5–M8, M10–M13) | Multi-volume/instance selection, Move/Rotate/Scale, affine transforms, primitives, model additions and object/part operations. [Viewport](Viewport%20Interaction.md), [Object List](ObjectList-and-Parts.md), [Model Import](Model%20Import.md). |
| Application chrome | Persistent pages, shared/native menus, split slice/output action, diagnostics and sidebar. [Application Shell](Application%20Shell.md). Real macOS packaged-window/menu manual qualification remains separate. |
| Printer integration (M14) | Device consoles and Moonraker upload/print, with host-specific constraints. [Printer Console](Printer%20Console%20and%20Control%20Integration.md). Additional drivers remain future work. |
| Project persistence (M15) | Explicit compatible 3MF open/save, dirty protection and geometry fallback; delivered and release-verified in its original milestone. [3MF](3MF%20Project%20Persistence.md). No autosave or saved slicing outputs. |
| History (M16) | Timestamped stable-object history, atomic restoration, input-only snapshots and painting-session integration. [Undo/Redo](Undo%20and%20Redo.md). |
| Plates and materials (M17–M18) | Multi-plate editing, per-plate Print/results, native rack/mapping/colour semantics and Prime Towers. [Multi-Plate](Multi-Plate%20Support.md), [Multi-Filament](Multi-Filament%20Support.md), [Per-Plate Print](Per-Plate%20Print%20Architecture.md). |
| Configuration (M19) | Native Project/Plate/Object/Part configuration and generic search/editing. [Scoped Configuration](Project%20and%20Scoped%20Configuration.md). Runtime Printer/Filament drafts and indexed vectors are in [Preset Editor](Preset%20Editor%20Dialog.md); specialized editors/user repositories are not implied. |
| Painting (M20) | Six MMU tools plus Support, Seam and Fuzzy adapters, native persistence, history and downstream slicing. [Surface Painting](Surface%20Painting%20Architecture.md). Functional delivery is complete; numerical performance thresholds remain unapproved. |
| Preview | Sole native libvgcode SegmentTemplate GPU backend, layer/move controls, read-only schemes, analysis and source-text navigation. [Preview v2](G-code%20Preview%20v2.md), [GPU renderer](G-code%20Preview%20GPU%20Streaming%20Renderer.md). |
| Arrangement | Native Arrange all/current plate, constraints, atomic history, progress and cancellation. [Model Arrangement](Model%20Arrangement.md). |
| Profiles | Setup Wizard, activation, JSON-only vendor loading, selective startup delivery and full catalogue on open. [Setup Wizard](Setup%20Wizard%20and%20Profile%20Activation.md). |
| Rendering and colours | Printer bed geometry/artwork, painted facets and shared colour editor. [Bed Display](Printer%20Bed%20Display.md), [Painted Facets](Painted%20Facet%20Model%20Rendering.md), [Color Picker](Reusable%20Color%20Picker.md). |
| Electron runtime | Utility-process Node Worker and runtime lifecycle; [Native Python Plugin Architecture](Native%20Python%20Plugin%20Architecture.md) records the validated host work. Python/plugin execution remains unimplemented. |

## Remaining work and qualification boundaries

- Native Python bridge, memory views, plugin delivery and unresolved deployment
  choices remain design work; the utility host does not imply Python support.
- Painting requires reviewed numeric performance thresholds and a comparable
  pinned-native/GPU timing baseline. The separately recorded invalid-layer-height
  abort remains unresolved; see the [benchmark runbook](../doc/2026-09-29-surface-painting-implementation.md).
- Preset Save As/rename/delete/repository persistence and dedicated specialized
  field editors remain deferred. Ordinary runtime editing is delivered.
- External G-code import, result-mutating preview actions, additional metric
  schemes and richer analysis remain beyond delivered read-only preview.
- Cut/measure/orient tools, mesh booleans/hollowing/advanced cut, calibration
  wizards and additional printer drivers remain queued.
- Large-project performance work continues; bounded fixture results do not
  establish a universal latency or memory guarantee.
- Online profile updates, validation/signatures/hashes/rollback, cloud accounts
  and profile synchronization remain deferred. Selective bundled-vendor loading
  is already delivered.
- Mobile, PWA/offline guarantees, richer startup recovery, autosave/crash
  recovery, a complete About page, i18n, application auto-update, signing and
  notarization remain follow-ups. The Home page remains a placeholder.

Routine verification and full release qualification are distinct. Follow
[testing guidelines](../doc/testing_guidelines.md), with host/variant and
fixture-specific limits recorded by the owning specification.
