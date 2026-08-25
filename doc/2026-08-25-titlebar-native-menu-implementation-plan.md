# Native Titlebar Menu Implementation Plan

**Date:** 2026-08-25  
**Status:** Implemented; see `doc/2026-08-25-titlebar-native-menu-implementation.md` for the implementation record and verification status.
**Scope:** Shared React titlebar/menu behavior for Electron, Web, Windows, Linux, and macOS

## 1. Goal and boundaries

Add a single, testable menu model to the shared application. Windows and Linux
Electron render it entirely in the shared custom titlebar, Web renders it as
browser UI without Quit/Exit, and macOS Electron uses
`Menu.setApplicationMenu` as the only File/Help menu surface.
Menu actions must dispatch the same shared commands regardless of which surface
invoked them.

This is a renderer/host integration change only. Do not edit
`packages/slicer-wasm/cpp`, generated WASM artifacts, or the slicing core. Do
not add a second menu definition in Electron main and do not let shared code
import Electron, Node, or `window.orca`.

Before implementation, update the relevant dated engineering note and, once
approved, reflect the normative behavior in the applicable `spec/` document.
This plan itself is the only file to be changed for the planning task.

## 2. Platform contract extension

Extend `packages/platform-contract/src/contracts.ts` with three explicit
capabilities. Keep the existing models, exports, preferences, runtime, and
profiles contracts intact.

### 2.1 `menu`

`menu` is the host-facing execution boundary, not a menu-definition store:

```ts
// packages/platform-contract/src/menu.ts
interface PlatformMenu {
  syncModel(model: MenuModel): Promise<void> | void;
  syncState(fullSnapshot: MenuStateSnapshot): Promise<void> | void;
  onCommand(listener: (command: MenuCommandId) => void): () => void;
  execute(command: MenuCommandId): Promise<void> | void;
}
```

The shared app owns the command IDs, pure model, and complete state projection.
`syncModel` and `syncState` are explicit shared-app-to-host replacement APIs;
they keep native enabled/checked state synchronized and are idempotent.
`onCommand` is the host-to-shared-app callback for native menu selections. The
host adapter only executes host-specific effects: model picking, external
navigation, and quit.
The contract must be safe to call repeatedly and must not accept arbitrary
URLs, IPC channel names, or filesystem paths.

### 2.2 `externalLinks`

Provide an allowlisted external-link operation, for example:

```ts
interface ExternalLinks {
  openSource(): Promise<void> | void;
}
```

The source link is the fixed project URL already used by the brand bar and Web
startup screen. Electron implements it through a main-process IPC handler using
`shell.openExternal`; Web uses `window.open`/anchor semantics with a safe,
fixed URL. No user-provided URL crosses the boundary.

### 2.3 `chrome`

Extend `PlatformChrome` with a surface mode, keeping the existing drag-region
and macOS inset flags:

```ts
type TitlebarMenuMode = 'custom' | 'native' | 'browser';
interface PlatformChrome {
  kind: 'desktop' | 'web';
  platform?: string;
  menuMode: TitlebarMenuMode;
  dragRegion?: boolean;
  macSafeInset?: boolean;
}
```

Use `custom` for Windows/Linux Electron custom titlebar rendering, `native` for
macOS Electron native application menu (the titlebar shows no branding, app
name, source link, or File/Help; it retains only the traffic-light safe inset
and blank draggable area), and `browser` for Web. Electron does not imply
native menu; only macOS uses it.
The adapter must provide deterministic values in tests.

## 3. Host-neutral menu types and dependency direction

Create `packages/platform-contract/src/menu.ts`. This file owns every
host-neutral menu type: `MenuCommandId`, `MenuItem`, `MenuModel`,
`MenuStateSnapshot`, and `PlatformMenu`. It must contain no React, Electron,
DOM, or slicer-app imports. Export these types through
`packages/platform-contract/src/index.ts`.

`packages/slicer-app` imports these types from `@orca/platform-contract`; it
must not define a parallel `MenuModel`, and `platform-contract` must never
import `slicer-app`. Host adapters implement `PlatformMenu` and are injected
through `PlatformCapabilities`; Electron IPC types remain in
`apps/desktop/src/shared/ipc` and translate at the host boundary.

Define:

- `MenuCommandId`: `add-model`, `clear-scene`, `slice`, `export-gcode`,
  `quit`, and `open-source`.
- `MenuItem`: label, command ID, enabled state, optional separator/submenu
  structure, and stable test ID.
- `MenuModel`: ordered top-level menus and items.

The only top-level menus in this scope are:

`File`: Add Model, Clear Scene, Slice, Export G-code, and Quit/Exit for
Electron on every OS. macOS uses native Quit; Windows/Linux render Quit/Exit
in the shared titlebar. Web never exposes Quit/Exit.

`Help`: Source, which invokes `open-source` and is always enabled after the
menu surface exists.

The model builder lives in `packages/slicer-app/src/menu/` and receives the
contract's complete immutable state snapshot and platform chrome information.
It returns the contract's `MenuModel` and remains a pure function, so all
surfaces can be tested against identical output.

## 4. Shared command and state design

Add a shared command layer (for example `menu/commands.ts`) and a selector
that consumes state from `useSlicerStore`, settings/model state, boot state,
and platform capabilities. Do not make the titlebar infer state from DOM
labels.

The complete snapshot must include at least:

- boot phase: `starting`, `ready`, or `failed`;
- slicer status: `idle`, `slicing`, `done`, or `error`;
- whether a model/scene exists;
- whether a slice result exists;
- whether the result has been exported;
- current progress and error, for diagnostics and deterministic tests;
- whether the host is Electron and the chrome menu mode;
- command execution/transition guard, so a stale click cannot run an action
  after state changes.

The command executor must re-check enabled state immediately before executing.
It must route existing application behavior rather than duplicate it:

- `add-model` calls the injected model picker and existing import flow;
- `clear-scene` calls the existing clear-scene action;
- `slice` calls the existing slice action;
- `export-gcode` calls the existing export action;
- `quit` calls the Electron platform menu command only;
- `open-source` calls `externalLinks.openSource()`.

During startup, the menu surface remains visible where appropriate, but every
File command is disabled until boot is `ready`; Help/Source remains available
unless the host surface itself is unavailable. A failed startup must never
permit a slicing or file action.

Once `status === 'slicing'`, disable Add Model, Clear Scene, Slice, and Export
G-code. Re-enable each command from the same derived selector after slicing
ends, subject to its normal prerequisites (for example, no export without a
completed result). The UI disabled state and executor guard must agree.

## 5. Shared titlebar renderer

Refactor `packages/slicer-app/src/components/layout/TitleBar.tsx` into a
shared titlebar plus a menu renderer. Keep drag-region behavior and macOS safe
inset behavior, but do not retain branding text, app name, or source link on
the macOS titlebar. Render the menu from `MenuModel`; do not create
separate business rules for buttons, dropdowns, and native menu templates.

For Windows/Linux Electron, render File and Help using the existing shadcn menu
primitives (or the established menubar primitive), with disabled styling,
separators, and accessible names. Ensure the draggable region does not swallow
menu pointer events: menu controls must explicitly be `no-drag`.

For Web, render the same menu model as ordinary browser UI in the titlebar.
There is no Quit command. Source must use the external-links contract and must
not navigate the app origin accidentally.

For macOS, render no branding, app name, source link, or File/Help controls in
the shared titlebar. Keep only the traffic-light safe inset and an empty
draggable region. Select native menu mode so File/Help exist only in the
system-top application menu; its enabled/checked state is updated from the
same complete state snapshot.

The startup screen must use the same titlebar component and disabled-state
projection, so there is no unguarded gap while the runtime/profile bootstrap is
in progress.

## 6. Electron preload and main-process IPC

Extend `apps/desktop/src/shared/ipc` with typed channels for:

- complete menu-model and full-state synchronization from renderer to main;
- native menu command events from main to renderer; and
- opening the fixed source link.

Keep channel names centralized in the existing `Ipc` definition. In
`apps/desktop/src/preload/index.ts`, expose narrow methods through
`contextBridge`; do not expose `ipcRenderer`, `shell`, `Menu`, or arbitrary
channel invocation. Update the renderer-side Electron adapter only place that
knows the preload shape.

In `apps/desktop/src/main/index.ts`:

1. Register typed synchronization handlers after app readiness and validate
   model, snapshot version, fields, and command IDs against closed allowlists.
2. On macOS, build/update the native menu from the synced model and state; when
   selected, send the command through the typed main-to-renderer event so the
   shared app remains the command authority.
3. Implement `quit` with `app.quit()` only after the shared command guard has
   accepted it.
4. Implement source opening with the fixed repository URL and
   `shell.openExternal`.
5. Build the macOS application menu with `Menu.buildFromTemplate` and install
   it using `Menu.setApplicationMenu` after `app.whenReady()`.
6. Keep the menu template free of renderer state assumptions; update its item
   enabled flags whenever the renderer publishes a complete menu/state
   snapshot.
7. Associate the menu with the active window where needed and avoid stale
   updates after window destruction.

The renderer must publish a serializable, versioned complete model and full
snapshot—not individual booleans—to main. Main validates both and falls back to
startup-disabled state on malformed input. On Windows/Linux, sync calls may be
host acknowledgments because the shared renderer owns the visible menu, but
the same lifecycle and contract still apply.

## 7. macOS native menu behavior

On macOS, install one application menu containing the File and Help groups. The
File group contains Add Model, Clear Scene, Slice, Export G-code, and Quit;
Help contains Source. The native menu must be the only interactive File/Help
menu surface on macOS. The shared macOS titlebar contains only safe-inset and
draggable blank space.

On Windows/Linux Electron, keep the custom titlebar menu as the only visible
File/Help surface and do not install a competing native application menu.
Because the host is Electron, that custom menu includes Quit/Exit. Web has no
Quit/Exit. Preserve Windows/Linux window-controls-overlay behavior.

## 8. State publication and lifecycle

Introduce one subscription/effect at the shared app boundary that derives and
publishes the complete model via `syncModel` and full snapshot via `syncState`
whenever boot, scene, result, slicing status, or chrome mode changes. Register
`onCommand` once and route native selections into the same guarded command
executor. Avoid publishing from individual menu buttons.

The initial publication must be startup-disabled and happen before the first
user-visible native menu interaction. On boot failure, publish the failed
snapshot. During a slice, publish disabled File actions immediately, and after
completion publish the new result/export eligibility. On unmount/window close,
stop publication and ignore late async command completions.

## 9. Tests and acceptance

Add focused Vitest coverage in the owning packages:

- pure model snapshots for startup, ready-empty, ready-with-model,
  ready-with-result, slicing, failed, Web, Windows/Linux custom, and macOS
  native modes;
- exact File/Help ordering, labels, separators, and Electron-only Quit with
  native-vs-custom placement by OS;
- `syncModel`/`syncState` receive complete replacements and `onCommand` routes
  native selections back to the shared executor;
- macOS native versus Windows/Linux custom versus Web browser mode, including
  the required Quit/Exit visibility rules;
- all four slicing-period commands disabled;
- executor re-checks state and rejects stale/disabled commands;
- complete snapshot serialization/version validation and malformed fallback;
- platform-contract compile/guard tests for the new interfaces;
- Electron adapter tests for quit/source IPC and Web adapter tests for the
  fixed external link;
- titlebar accessibility and no-drag interaction tests.

Extend Playwright Electron coverage to verify startup-disabled state, native
macOS menu handling where the environment supports it, custom Windows/Linux
menu activation, disabled commands during a real slice, and Source opening
through the host boundary. Extend Web E2E to verify no Quit item, menu
commands, and Source behavior without leaving the app unexpectedly.

Acceptance requires:

1. The same pure model produces the same command ordering and eligibility for
   every host mode.
2. No File action can run before boot is ready or while slicing.
3. Windows/Linux titlebar menus are pointer accessible and do not break
   dragging/window controls.
4. macOS has exactly one native File/Help menu, with live enabled state.
5. macOS Electron uses only the native menu; Windows/Linux Electron uses only
   the shared titlebar menu and includes Quit/Exit; Web has no Quit/Exit and
   uses the fixed external-link behavior.
6. Shared packages remain host-free; no `window.orca` or Electron import is
   introduced into `packages/slicer-app` or `packages/platform-contract`.
7. Existing import, slice, clear, export, startup, and beforeunload behavior
   remains intact.

Use `pnpm` for unit tests, typecheck, and Electron/Web E2E. Because this
feature does not touch the bridge, build scaffold, or generated WASM, no WASM
quick build is required for the implementation; do not modify
`packages/slicer-wasm/cpp`.

## 10. Implementation sequence and commit boundary

Implement and verify as independently testable units:

1. Contract types, pure menu model, snapshot type, and unit tests.
2. Shared command executor and state selectors, with store/app tests.
3. Windows/Linux/Web titlebar renderer and startup integration.
4. Electron preload/main IPC and renderer adapter tests.
5. macOS native menu installation and snapshot-driven enablement.
6. Cross-host E2E, documentation/spec synchronization, and final regression.

Each unit should be committed separately only after its checks pass. The
implementation branch must be dedicated, and unrelated dirty work must not be
included. For this planning task, do not create commits, branches, source
changes, submodule changes, or generated artifacts. The final implementation
handoff must report the exact test commands and results.

## 11. Risks and mitigations

- **Two menus drift:** one pure model plus explicit `syncModel`/`syncState` and
  `onCommand`; the native template consumes serialized model/state rather than
  reimplementing rules.
- **Stale IPC state:** version complete snapshots, validate in main, default to
  disabled, and publish on every relevant transition.
- **Frameless drag intercepts clicks:** explicit no-drag menu zones plus pointer
  tests.
- **macOS duplication:** `menuMode: 'native'` suppresses the shared dropdown;
  manually verify the application menu in a real macOS build.
- **Async slice race:** command guard and state re-check immediately before
  execution; ignore late promises after teardown.
- **Unsafe external navigation:** fixed allowlisted source operation only.
- **Platform-contract leakage:** retain import-direction and compile-only guard
  tests; no host details in shared packages.

## 12. Manual macOS verification

On a real macOS machine, run the packaged Electron app (not only a mocked
browser window) and verify:

- traffic lights remain correctly inset and the custom brand bar does not show
  a duplicate File/Help dropdown;
- the application menu contains exactly File and Help entries specified above;
- startup disables all File actions, then ready state enables only actions with
  valid prerequisites;
- Add Model, Clear Scene, Slice, and Export G-code are all disabled during a
  real slice and return to the correct state afterward;
- Quit exits the application and Source opens the fixed repository page in the
  default browser;
- menu pointer behavior and window dragging remain usable;
- closing/reopening the window does not retain stale enabled state.

Record OS version, Electron version, build mode, and pass/fail observations in
the implementation follow-up document. This manual check is required before
the macOS portion is accepted.
