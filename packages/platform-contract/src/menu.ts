/** The menu surface supplied by a host. */
export type TitlebarMenuMode = 'custom' | 'native' | 'browser';

export type MenuCommandId =
  | 'add-model'
  | 'clear-scene'
  | 'slice'
  | 'export-gcode'
  | 'quit'
  | 'open-source';

export interface MenuItem {
  /** Stable identifier for rendering and automated tests. */
  testId: string;
  label: string;
  command?: MenuCommandId;
  separator?: boolean;
  submenu?: readonly MenuItem[];
}

export interface MenuGroup {
  testId: string;
  label: string;
  items: readonly MenuItem[];
}

/** The complete static menu replacement sent to a host. */
export interface MenuModel {
  version: 1;
  menuMode: TitlebarMenuMode;
  menus: readonly MenuGroup[];
}

export type MenuBootPhase = 'starting' | 'ready' | 'failed';
export type MenuSlicerStatus = 'idle' | 'slicing' | 'done' | 'error';

export interface MenuItemState {
  enabled: boolean;
  checked?: boolean;
}

export type MenuItemStates = Readonly<Record<MenuCommandId, MenuItemState>>;

/** Snapshot fields owned by the shared selector before item states are derived. */
export type MenuStateSnapshotInput = Omit<MenuStateSnapshot, 'items'>;

/** The complete dynamic state replacement sent to a host. */
export interface MenuStateSnapshot {
  version: 1;
  boot: {
    phase: MenuBootPhase;
    error: string | null;
  };
  slicer: {
    status: MenuSlicerStatus;
    progress: number;
    error: string | null;
  };
  scene: {
    hasModel: boolean;
  };
  result: {
    hasResult: boolean;
    exported: boolean;
  };
  host: {
    isElectron: boolean;
    menuMode: TitlebarMenuMode;
  };
  items: MenuItemStates;
}

/** Shared-app-to-host menu synchronization and host command boundary. */
export interface PlatformMenu {
  syncModel(model: MenuModel): Promise<void> | void;
  syncState(fullSnapshot: MenuStateSnapshot): Promise<void> | void;
  onCommand(listener: (command: MenuCommandId) => void): () => void;
  execute(command: MenuCommandId): Promise<void> | void;
}
