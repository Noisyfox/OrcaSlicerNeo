# Workspace Prepare and Preview Modes

**Date:** 2026-08-31

**Status:** Approved product behaviour; implementation design in progress.

**Scope:** Split the shared application workspace into distinct Prepare and
Preview presentations while retaining one shared sidebar and the existing
shared Electron/Web application architecture.

## 1. Navigation

The application has one `AppTab` union containing `home`, `prepare`, `preview`,
and `device`. There is no separate `activeWorkspaceTab` and no global
`workspaceMode` state.

- **Home** is an independent, currently blank page.
- **Prepare** and **Preview** are the two workspace presentations. Workspace
  receives the current `AppTab` and owns their presentation boundary.
- **Device** remains independent of the workspace.

Every top-level page remains mounted for the ready application's lifetime.
Inactive pages are hidden and inert, never unmounted, to preserve state and make
switching immediate. Thus Home being active never destroys the Workspace; it
only hides its sidebar and viewport.

App owns only `activeTab: AppTab` as page-routing state. Workspace derives its
Prepare/Preview presentation directly from that input and requests a tab change
through a callback when an action must open Preview.

After runtime startup, the application opens Home by default.

## 2. Shared Sidebar and Viewport Lifetime

Prepare and Preview reuse the same mounted sidebar DOM. Switching modes must
not remount it or discard its UI state (scroll position, expanded rows, open
editor state, and other component-local state). The viewport's WebGL Canvas,
camera, and OrbitControls also stay mounted across the switch: changing tabs
must not change the camera position, direction, projection, or zoom.

The sidebar remains fully functional in Preview:

- Object List selection and all Object List commands remain available.
- Slice/profile settings remain editable.
- Transform panels remain part of the same sidebar. Entering Preview closes the
  active gizmo, so the existing gizmo-gated transform inputs naturally hide.

Any sidebar change that invalidates the slice result immediately clears the
visible G-code preview but does not navigate away from Preview.

## 3. Prepare

Prepare is the model-editing presentation. It renders model geometry with its
ordinary selection visuals and allows all existing viewport model interactions,
including picking, selection, box selection, body dragging, gizmos, viewport
context menus, and viewport keyboard editing shortcuts.

Prepare never displays G-code preview UI: no toolpath, layer scrubber, or other
G-code-preview controls.

## 4. Preview

Preview is a G-code-inspection presentation. It still renders the loaded model,
but in an unselected semi-transparent appearance corresponding to OrcaSlicer.
It preserves Prepare's ordinary unselected material and per-part colours; only
the shell opacity changes to `0.15`, matching upstream `GCodeViewer`'s default.
When available, the G-code toolpath renders after the shell, above the model,
and is never occluded by it.

The viewport stays navigable in Preview:

- orbit, pan, zoom, and the orientation/view gizmo remain available;
- model picking, selection, box selection, body dragging, gizmo interaction,
  viewport right-click menus, and viewport editing keyboard shortcuts are all
  disabled;
- Web's browser-native context menu remains suppressed over the canvas, so a
  Preview right-click only serves the allowed camera-pan gesture and never
  exposes a replacement host menu;
- the gizmo toolbar is hidden and any active gizmo closes when Preview opens;
- selection bounds and selection highlighting never render, even if sidebar
  actions change the underlying shared selection.

The sidebar selection remains intact while Preview suppresses its viewport
representation. Returning to Prepare restores the normal viewport selection
presentation. If the user changes the selection in Object List while Preview is
active, Prepare shows that newest selection when it is next opened.

## 5. Preview Entry and Slice Lifecycle

Preview follows OrcaSlicer's entry semantics adapted to the existing explicit
slice workflow:

- Preview is accessible with no loaded model and shows an empty, read-only
  preview surface.
- Entering Preview with a model whose result is absent or invalid automatically
  starts slicing and immediately changes to Preview.
- Entering Preview during an existing slice changes to Preview and observes the
  same in-flight job; it never starts a second slice.
- A slice failure leaves the application in Preview and presents the error
  through the existing status bar.
- If a sidebar edit invalidates a result while Preview is active, old toolpath
  data is cleared immediately. A user may reslice through the Slice command.
  Re-selecting an already active Preview tab does not create a reslice request.
- Invoking the existing top-toolbar Slice command from Prepare also immediately
  changes to Preview; it uses the same single slice task and result lifecycle.

There is no new viewport progress, empty-state, or error overlay. While Preview
has no valid result (no model, slicing, invalidated result, or failure), it
shows only the semi-transparent model; progress and errors remain exclusively
in the existing status bar.

## 6. Global Action Visibility

Home and Device render no Slice, Export, Send, or Send & Print action area in
the top toolbar. The action area remains part of the Prepare/Preview experience.
Changing to Home or Device never cancels an in-flight slice: the shared runtime
task continues and its status remains available when the user returns.

File-menu Add Model and Clear Scene are enabled only in Prepare and disabled in
Home, Preview, and Device. Slice is enabled only in Prepare or Preview when no
valid slice result exists. Export G-code, Send, and Send & Print are available
in either Prepare or Preview whenever a valid result exists; they do not require
the Preview tab. A File-menu Slice command in Prepare follows the same flow as
the top-toolbar Slice command: it immediately enters Preview and starts the
single shared slice task.

The shared `MenuStateSnapshot` carries the current `activeTab`, so the native
Electron menu and the HTML titlebar derive identical command enablement. The
command dispatcher re-reads that snapshot at invocation time and rejects stale
or disabled Add Model, Clear Scene, and Slice requests; UI disabled state alone
is not a security or correctness boundary.

## 7. Preview Feature Scope

This milestone exposes the existing coloured toolpath and Layer Scrubber only.
The richer OrcaSlicer Preview capability — legends, feature filters, move-range
sliders, statistics, and related controls — is explicitly deferred.

## 8. Implementation Architecture

The selected implementation direction is explicit Prepare and Preview content
trees within a shared Workspace shell, rather than a single scene with only
visual CSS toggles. The shell preserves the sidebar DOM and shared camera/state;
the mode-specific viewport content prevents Preview from mounting model-editing
surfaces in the first place. A small local policy at the Workspace/Viewport
boundary guards every viewport-only interaction path. No global mode store is
introduced.

Workspace owns the lifetime of `SceneInteractionController`, `useModelLoader`,
and `useSliceResult`. Prepare and Preview consume these same long-lived scene
and result resources, so tab switching cannot reload the model, reset the shared
selection, or fetch the same slice result again.

Workspace also owns a local, non-reactive slice coordinator. The top-toolbar
Slice action, File-menu Slice action, and an actual transition into Preview all
use this one coordinator. It records a request before the existing slice helper
awaits model-transform synchronization, so concurrent entry points cannot start
duplicate worker tasks. It is not a second tab/mode state and it does not move
`useSliceResult` to App.

The coordinator is reached from App through a ref-backed callback only; App
continues to own `activeTab` as the sole routing state. Menu state is derived
from that tab and the current slicer/result stores, while the long-lived
Workspace resources remain outside the menu policy.

## 9. Verification Requirements

Shared unit/integration coverage must verify:

- `AppTab` has exactly `home | prepare | preview | device`; startup selects
  Home; all top-level page roots stay mounted while inactive roots are hidden
  and inert.
- Home is blank and Home/Device hide the top action area. File-menu command
  enablement follows §6, including Preview-only disabling of Add Model and
  Clear Scene.
- Prepare renders no toolpath/layer controls and retains all existing viewport
  selection, drag, gizmo, context-menu, and keyboard behaviour.
- Preview hides the gizmo toolbar, closes an armed gizmo, suppresses model
  selection visuals, disables every viewport model-edit interaction and native
  browser context menu, while retaining camera navigation and Object List-driven
  selection persistence.
- Preview shells preserve unselected colours at alpha `0.15`; a toolpath is
  rendered in front of and without depth occlusion by those shells.
- Switching Prepare and Preview preserves the Canvas, camera, OrbitControls,
  model resource collection, slice-result resource, sidebar DOM state, and
  selection; switching to Home/Device likewise does not unmount top-level
  pages.
- Entering Preview with no result starts exactly one slice and changes tab
  immediately; the top-toolbar and File-menu Slice actions do the same.
  Entering during a running slice joins it, failures remain on Preview, and an
  edit-induced invalidation clears the toolpath without navigation.
- A slice continues while Home or Device is active and becomes available on a
  later return to Preview.

Desktop and Web Playwright coverage must exercise the same flow in their
respective mock/real-artifact suites. The existing full flow should be updated
from “slice → preview” as an incidental render condition to explicit tab and
interaction assertions; Web coverage runs in both threaded and serial modes.
