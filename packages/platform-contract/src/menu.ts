/** The menu surface supplied by a host. */
export type TitlebarMenuMode = 'custom' | 'native' | 'browser';

/** Top-level application pages, shared by UI navigation and host validation. */
export const APP_TABS = ['home', 'prepare', 'preview', 'device'] as const;

/** Top-level application page used by the shared menu policy. */
export type AppTab = (typeof APP_TABS)[number];

export type StaticMenuCommandId =
  | 'new-project'
  | 'open-project'
  | 'save-project'
  | 'save-project-as'
  | 'preferences'
  | 'setup-wizard'
  | 'add-model'
  | 'clear-scene'
  | 'slice'
  | 'export-gcode'
  | 'quit'
  | 'open-source'
  | 'open-configuration-folder'
  | 'open-file-manager';

export type RecentProjectMenuCommandId = `open-recent:${string}`;
export type MenuCommandId = StaticMenuCommandId | RecentProjectMenuCommandId;

export function recentProjectMenuCommand(id: string): RecentProjectMenuCommandId {
  return `open-recent:${encodeURIComponent(id)}`;
}

export function isRecentProjectMenuCommand(value: unknown): value is RecentProjectMenuCommandId {
  if (typeof value !== 'string' || !value.startsWith('open-recent:') || value.length > 256) return false;
  const encoded = value.slice('open-recent:'.length);
  try { return encoded.length > 0 && encodeURIComponent(decodeURIComponent(encoded)) === encoded; }
  catch { return false; }
}

export function recentProjectIdFromMenuCommand(command: RecentProjectMenuCommandId): string {
  return decodeURIComponent(command.slice('open-recent:'.length));
}

export interface MenuItem {
  /** Stable identifier for rendering and automated tests. */
  testId: string;
  label: string;
  /** A leaf without a command is a disabled informational item. */
  command?: MenuCommandId;
  separator?: boolean;
  submenu?: readonly MenuItem[];
}

export interface MenuGroup {
  testId: string;
  label: string;
  items: readonly MenuItem[];
}

/** The complete menu replacement sent to a host, including recent entries. */
export interface MenuModel {
  version: 1;
  menuMode: TitlebarMenuMode;
  menus: readonly MenuGroup[];
}

export type MenuBootPhase = 'starting' | 'ready' | 'failed' | 'setup';
export type MenuSlicerStatus = 'idle' | 'slicing' | 'done' | 'error';

export interface MenuItemState {
  enabled: boolean;
  checked?: boolean;
}

/** Complete fixed-command state table plus the current recent-entry states. */
export type MenuItemStates = Readonly<Record<StaticMenuCommandId, MenuItemState>
  & Partial<Record<RecentProjectMenuCommandId, MenuItemState>>>;

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
    /** Missing/unknown is treated conservatively as serial while slicing. */
    threaded?: boolean | null;
  };
  scene: {
    hasModel: boolean;
    arranging: boolean;
    editing: boolean;
  };
  result: {
    hasResult: boolean;
    exported: boolean;
  };
  /** Authoritative project state supplied by the shared application. */
  project: MenuProjectState;
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
    phase: 'idle' | 'waiting-for-load-choice' | 'waiting-for-project-confirmation' | 'waiting-for-dirty-decision' | 'loading' | 'saving' | 'model-import' | 'completed' | 'cancelled' | 'failed';
    progress: number;
    message?: string;
    cancellable: boolean;
  };
}

/** Shared-app-to-host menu synchronization and host command boundary. */
export interface PlatformMenu {
  syncModel(model: MenuModel): Promise<void> | void;
  syncState(fullSnapshot: MenuStateSnapshot): Promise<void> | void;
  onCommand(listener: (command: MenuCommandId) => void): () => void;
  execute(command: MenuCommandId): Promise<void> | void;
}
