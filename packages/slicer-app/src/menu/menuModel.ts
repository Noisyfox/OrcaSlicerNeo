import type {
  MenuCommandId,
  MenuItem,
  MenuItemStates,
  MenuModel,
  MenuStateSnapshot,
  MenuStateSnapshotInput,
  PlatformChrome,
  TitlebarMenuMode,
} from '@orca/platform-contract';

function item(testId: string, label: string, command: MenuCommandId): MenuItem {
  return { testId, label, command };
}

function separator(testId: string): MenuItem {
  return { testId, label: '', separator: true };
}

/**
 * Resolve the approved surface rule from the host identity. The explicit
 * chrome.menuMode is retained in the contract for host adapters and snapshots;
 * the platform identity keeps this projection deterministic if a stale mode is
 * supplied during a host transition.
 */
export function resolveMenuMode(chrome: PlatformChrome): TitlebarMenuMode {
  if (chrome.kind === 'web') return 'browser';
  return chrome.platform?.toLowerCase() === 'darwin' ? 'native' : 'custom';
}

export function buildMenuModel(
  snapshot: MenuStateSnapshot,
  chrome: PlatformChrome,
): MenuModel {
  const menuMode = resolveMenuMode(chrome);
  const isElectron = snapshot.host.isElectron && chrome.kind === 'desktop';

  const fileItems: MenuItem[] = [
    item('file-add-model', 'Add Model', 'add-model'),
    item('file-clear-scene', 'Clear Scene', 'clear-scene'),
    item('file-slice', 'Slice', 'slice'),
    item('file-export-gcode', 'Export G-code', 'export-gcode'),
  ];

  if (isElectron) {
    fileItems.push(separator('file-separator-before-quit'));
    fileItems.push(item('file-quit', menuMode === 'native' ? 'Quit' : 'Exit', 'quit'));
  }

  return {
    version: 1,
    menuMode,
    menus: [
      { testId: 'menu-file', label: 'File', items: fileItems },
      { testId: 'menu-help', label: 'Help', items: [item('help-source', 'AGPL-3.0 source', 'open-source')] },
    ],
  };
}

function isElectronHost(snapshot: MenuStateSnapshotInput, chrome: PlatformChrome): boolean {
  return snapshot.host.isElectron && chrome.kind === 'desktop';
}

/**
 * Derive every command's dynamic state from the same raw shared-app snapshot
 * used to build the static model. `checked` is false for the non-checkable
 * commands in this menu, while remaining part of the host-facing state shape.
 */
export function deriveMenuItemStates(
  snapshot: MenuStateSnapshotInput,
  chrome: PlatformChrome,
): MenuItemStates {
  const ready = snapshot.boot.phase === 'ready';
  const slicing = snapshot.slicer.status === 'slicing';
  const fileActionsEnabled = ready && !slicing;
  const hasCompletedResult = snapshot.result.hasResult && snapshot.slicer.status === 'done';
  const electron = isElectronHost(snapshot, chrome);
  const state = (enabled: boolean): { enabled: boolean; checked: false } => ({ enabled, checked: false });

  return {
    'add-model': state(fileActionsEnabled),
    'clear-scene': state(fileActionsEnabled && snapshot.scene.hasModel),
    'slice': state(fileActionsEnabled && snapshot.scene.hasModel),
    'export-gcode': state(fileActionsEnabled && hasCompletedResult),
    'quit': state(electron),
    'open-source': state(true),
  };
}

/**
 * Add the complete per-command state table to a raw shared-app snapshot.
 *
 * The raw input's `slicer.progress` is the slicer store's 0–100 percent
 * (StatusBar renders it directly); the host-facing snapshot carries a 0–1
 * fraction, which the Electron native-menu boundary validates and rejects
 * otherwise (see cloneState in apps/desktop/src/main/nativeMenu.ts). Normalize
 * here so every host-bound snapshot is contract-valid even while slicing.
 */
export function buildMenuStateSnapshot(
  snapshot: MenuStateSnapshotInput,
  chrome: PlatformChrome,
): MenuStateSnapshot {
  return {
    ...snapshot,
    slicer: { ...snapshot.slicer, progress: snapshot.slicer.progress / 100 },
    items: deriveMenuItemStates(snapshot, chrome),
  };
}
