# Documentation Index

**Updated:** 2026-10-11

Specifications own accepted behavior, required constraints, exclusions and open
decisions; engineering references own build/debug/verification procedures.
[Grand Plan](../spec/Grand%20Plan.md) is the single delivery roadmap.

## Reading and maintenance rules

1. Start with [AGENTS](../AGENTS.md), the [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md)
   and [repository guidelines](../project_structure_and_guidelines.md).
2. Preserve every accepted decision not explicitly superseded, including
   positive and negative constraints, ownership, failure behavior, scope,
   rationale and verification requirements. Silence in a later document or an
   implementation gap does not revoke a decision.
3. Merge revisions into the owning topic in place. Replace only the changed
   portion; retain unaffected conditions. Distinguish proposals, accepted
   requirements, delivered behavior and unverified claims. Preserve unresolved
   failures and qualification boundaries.
4. Update the existing topic owner directly. Add a document only for a distinct,
   lasting topic without a suitable owner, then add it to this index. Tasks,
   fixes, reviews, and phases do not each need a document. The
   [documentation policy](../project_structure_and_guidelines.md#3-document-conventions)
   defines what belongs in maintained docs; working plans and execution logs
   belong in issues, PRs, or test artifacts. Git retains earlier revisions.
5. Keep docs in English. Use [README](../README.md) and build-driver help for
   commands, and [testing guidelines](testing_guidelines.md) for verification
   scope. Validate changed local links and commands plus `git diff --check`.

## Product and architecture

| Topic | Maintained authority |
| --- | --- |
| Shared hosts, runtime and preferences | [Web–Electron architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md) |
| Chrome, controls, layout and diagnostics | [Application Shell](../spec/Application%20Shell.md) |
| Prepare/Preview navigation and lifetime | [Workspace modes](../spec/Workspace%20Prepare%20and%20Preview%20Modes.md) |
| Picking, transforms, camera and rendering | [Viewport Interaction](../spec/Viewport%20Interaction.md) |
| Objects, parts, instances and menus | [Object List and Parts](../spec/ObjectList-and-Parts.md) |
| Model loading | [Model Import](../spec/Model%20Import.md), [DRC](../spec/2026-09-01-drc-import-support.md) |
| Bed geometry and artwork | [Printer Bed Display](../spec/Printer%20Bed%20Display.md) |
| Native arrangement | [Model Arrangement](../spec/Model%20Arrangement.md) |
| Project files and dirty protection | [3MF Project Persistence](../spec/3MF%20Project%20Persistence.md) |
| History and atomic restore | [Undo and Redo](../spec/Undo%20and%20Redo.md) |
| Plates and native slicing/results | [Multi-Plate](../spec/Multi-Plate%20Support.md), [Per-Plate Print](../spec/Per-Plate%20Print%20Architecture.md) |
| Rack, assignments and Prime Towers | [Multi-Filament](../spec/Multi-Filament%20Support.md) |
| Profiles and activation | [Setup Wizard](../spec/Setup%20Wizard%20and%20Profile%20Activation.md), [Profile Compatibility](../spec/Profile%20Compatibility%20and%20Preset%20Selection.md) |
| Configuration ownership and editors | [Scoped Configuration](../spec/Project%20and%20Scoped%20Configuration.md), [Preset Editor](../spec/Preset%20Editor%20Dialog.md) |
| Painting and painted rendering | [Surface Painting](../spec/Surface%20Painting%20Architecture.md), [Painted Facets](../spec/Painted%20Facet%20Model%20Rendering.md) |
| Colour editing | [Reusable Color Picker](../spec/Reusable%20Color%20Picker.md) |
| Toolpath inspection and rendering | [G-code Preview](../spec/G-code%20Preview%20v2.md), [GPU Streaming Renderer](../spec/G-code%20Preview%20GPU%20Streaming%20Renderer.md) |
| Device console and upload/print | [Printer Console](../spec/Printer%20Console%20and%20Control%20Integration.md) |
| Electron utility, temporary files and proposed Python | [Native Python Plugin Architecture](../spec/Native%20Python%20Plugin%20Architecture.md) (host work delivered; Python remains design work) |

## Engineering references

| Topic | Reference |
| --- | --- |
| Setup, build and development | [README](../README.md) |
| Native ownership and runtime build rules | [WASM Build and Runtime Reference](2026-08-12-wasm-build-notes.md) |
| Windows cmd drivers | [Windows build pipeline](2026-08-15-cmd-build-pipeline.md) |
| Native debug artifacts | [WASM DWARF builds](2026-08-20-wasm-dwarf-debug-build.md) |
| CI assets, packaging and Pages | [Deployment](2026-09-25-github-pages-deployment.md) |
| Incremental publication and performance | [Object interaction](2026-09-23-object-interaction-performance.md) |
| Painting benchmarks and acceptance limits | [Painting verification](2026-09-29-surface-painting-implementation.md) |
| Verification selection and E2E rules | [Testing guidelines](testing_guidelines.md) |
