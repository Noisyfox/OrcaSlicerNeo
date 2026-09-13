/** The menu surface supplied by a host. */
export type TitlebarMenuMode = 'custom' | 'native' | 'browser';

/** Top-level application pages, shared by UI navigation and host validation. */
export const APP_TABS = ['home', 'prepare', 'preview', 'device'] as const;

/** Top-level application page used by the shared menu policy. */
export type AppTab = (typeof APP_TABS)[number];

export type MenuCommandId =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'save-project-as'
  | 'preferences'
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

/** Complete per-command state table synchronized to every host surface. */
export type MenuItemStates = Readonly<Record<MenuCommandId, MenuItemState>>;

/** Snapshot fields owned by the shared selector before item states are derived. */
export type MenuStateSnapshotInput = Omit<MenuStateSnapshot, 'items'>;

/** The complete dynamic state replacement sent to a host. */
export interface MenuStateSnapshot {
  version: 1;
  activeTab: AppTab;
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
  /** Optional for snapshots produced by hosts before project persistence. */
  project?: MenuProjectState;
  host: {
    isElectron: boolean;
    menuMode: TitlebarMenuMode;
  };
  items: MenuItemStates;
}

export interface MenuProjectState {
  hasContent: boolean;
  dirty: boolean;
  operation: {
    phase: 'idle' | 'waiting-for-load-choice' | 'waiting-for-project-confirmation' | 'waiting-for-dirty-decision' | 'loading' | 'saving' | 'completed' | 'cancelled' | 'failed';
    progress: number;
    message?: string;
    cancellable: boolean;
  };
  flattenedMultiPlate: boolean;
}

/** Shared-app-to-host menu synchronization and host command boundary. */
export interface PlatformMenu {
  syncModel(model: MenuModel): Promise<void> | void;
  syncState(fullSnapshot: MenuStateSnapshot): Promise<void> | void;
  onCommand(listener: (command: MenuCommandId) => void): () => void;
  execute(command: MenuCommandId): Promise<void> | void;
}
