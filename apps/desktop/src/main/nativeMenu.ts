import {
  APP_TABS,
  type MenuCommandId,
  type MenuItem,
  type MenuModel,
  type MenuStateSnapshot,
  type TitlebarMenuMode,
} from '../../../../packages/platform-contract/src/menu';
import { isMenuCommandId, SOURCE_URL } from '../shared/ipc';

const MENU_MODES = ['custom', 'native', 'browser'] as const satisfies readonly TitlebarMenuMode[];
const BOOT_PHASES = ['starting', 'ready', 'failed'] as const;
const SLICER_STATUSES = ['idle', 'slicing', 'done', 'error'] as const;
const MAX_MENU_DEPTH = 8;
const MAX_MENU_ITEMS = 128;
const MENU_STATE_COMMANDS = [
  'new-project', 'open-project', 'save-project', 'save-project-as', 'preferences',
  'add-model', 'clear-scene', 'slice', 'export-gcode', 'quit', 'open-source',
] as const;

export interface NativeMenuTemplateItem {
  id?: string;
  label?: string;
  type?: 'separator';
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: NativeMenuTemplateItem[];
}

export interface NativeMenuItemInstance {
  enabled: boolean;
  checked: boolean;
}

export interface NativeMenuInstance {
  getMenuItemById(id: string): NativeMenuItemInstance | null;
}

export interface NativeMenuApi {
  buildFromTemplate(template: NativeMenuTemplateItem[]): NativeMenuInstance;
  setApplicationMenu(menu: NativeMenuInstance | null): void;
}

export interface NativeMenuController {
  install(): boolean;
  syncModel(value: unknown): boolean;
  syncState(value: unknown): boolean;
}

export const STARTUP_DISABLED_MENU_MODEL: MenuModel = {
  version: 1,
  menuMode: 'native',
  menus: [
    {
      testId: 'menu-file',
      label: 'File',
      items: [
        { testId: 'file-add-model', label: 'Add Model', command: 'add-model' },
        { testId: 'file-clear-scene', label: 'Clear Scene', command: 'clear-scene' },
        { testId: 'file-slice', label: 'Slice', command: 'slice' },
        { testId: 'file-export-gcode', label: 'Export G-code', command: 'export-gcode' },
        { testId: 'file-separator-before-quit', label: '', separator: true },
        { testId: 'file-quit', label: 'Quit', command: 'quit' },
      ],
    },
    {
      testId: 'menu-help',
      label: 'Help',
      items: [{ testId: 'help-source', label: 'AGPL-3.0 source', command: 'open-source' }],
    },
  ],
};

export const STARTUP_DISABLED_MENU_STATE: MenuStateSnapshot = {
  version: 1,
  activeTab: 'home',
  boot: { phase: 'starting', error: null },
  slicer: { status: 'idle', progress: 0, error: null },
  scene: { hasModel: false },
  result: { hasResult: false, exported: false },
  project: {
    hasContent: false,
    dirty: false,
    operation: { phase: 'idle', progress: 0, cancellable: false },
  },
  host: { isElectron: true, menuMode: 'native' },
  items: {
    'new-project': { enabled: false, checked: false },
    'open-project': { enabled: false, checked: false },
    'save-project': { enabled: false, checked: false },
    'save-project-as': { enabled: false, checked: false },
    preferences: { enabled: false, checked: false },
    'add-model': { enabled: false, checked: false },
    'clear-scene': { enabled: false, checked: false },
    slice: { enabled: false, checked: false },
    'export-gcode': { enabled: false, checked: false },
    quit: { enabled: true, checked: false },
    'open-source': { enabled: true, checked: false },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256;
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function cloneMenuItem(value: unknown, depth: number, seen: Set<MenuCommandId>): MenuItem | null {
  if (depth > MAX_MENU_DEPTH || !isRecord(value) || !isString(value.testId) || !isString(value.label)) return null;

  const separator = value.separator;
  const command = value.command;
  const submenu = value.submenu;
  if (separator !== undefined && separator !== true) return null;
  if (separator === true) {
    return value.label === '' && command === undefined && submenu === undefined
      ? { testId: value.testId, label: '', separator: true }
      : null;
  }
  if (command !== undefined && (!isMenuCommandId(command) || seen.has(command))) return null;
  if (submenu !== undefined && (!Array.isArray(submenu) || submenu.length > MAX_MENU_ITEMS || command !== undefined)) return null;
  if (command === undefined && submenu === undefined) return null;

  if (submenu !== undefined) {
    const children: MenuItem[] = [];
    for (const child of submenu) {
      const normalized = cloneMenuItem(child, depth + 1, seen);
      if (!normalized) return null;
      children.push(normalized);
    }
    return { testId: value.testId, label: value.label, submenu: children };
  }

  seen.add(command as MenuCommandId);
  return { testId: value.testId, label: value.label, command: command as MenuCommandId };
}

/** Validate and clone the only top-level menu shape supported by this host. */
export function validateMenuModel(value: unknown, expectedMode?: TitlebarMenuMode): MenuModel | null {
  if (!isRecord(value) || value.version !== 1 || !isOneOf(MENU_MODES, value.menuMode)) return null;
  if (expectedMode !== undefined && value.menuMode !== expectedMode) return null;
  if (!Array.isArray(value.menus) || value.menus.length !== 2) return null;

  const seen = new Set<MenuCommandId>();
  const menus: MenuModel['menus'][number][] = [];
  for (const [index, rawMenu] of value.menus.entries()) {
    if (!isRecord(rawMenu) || !isString(rawMenu.testId) || !isString(rawMenu.label) || !Array.isArray(rawMenu.items)) return null;
    const expected = index === 0
      ? { testId: 'menu-file', label: 'File' }
      : { testId: 'menu-help', label: 'Help' };
    if (rawMenu.testId !== expected.testId || rawMenu.label !== expected.label || rawMenu.items.length > MAX_MENU_ITEMS) return null;
    const items: MenuItem[] = [];
    for (const rawItem of rawMenu.items) {
      const normalized = cloneMenuItem(rawItem, 0, seen);
      if (!normalized) return null;
      items.push(normalized);
    }
    menus.push({ testId: rawMenu.testId, label: rawMenu.label, items });
  }
  return { version: 1, menuMode: value.menuMode, menus };
}

function cloneState(value: unknown): MenuStateSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isOneOf(APP_TABS, value.activeTab)) return null;
  if (!isRecord(value.boot) || !isOneOf(BOOT_PHASES, value.boot.phase) || (value.boot.error !== null && !isString(value.boot.error))) return null;
  if (!isRecord(value.slicer) || !isOneOf(SLICER_STATUSES, value.slicer.status) || typeof value.slicer.progress !== 'number' || !Number.isFinite(value.slicer.progress) || value.slicer.progress < 0 || value.slicer.progress > 1 || (value.slicer.error !== null && !isString(value.slicer.error))) return null;
  if (!isRecord(value.scene) || typeof value.scene.hasModel !== 'boolean') return null;
  if (!isRecord(value.result) || typeof value.result.hasResult !== 'boolean' || typeof value.result.exported !== 'boolean') return null;
  if (!isRecord(value.host) || typeof value.host.isElectron !== 'boolean' || !isOneOf(MENU_MODES, value.host.menuMode)) return null;
  if (!isRecord(value.items)) return null;
  const rawItems = value.items;

  const items = {} as Record<MenuCommandId, { enabled: boolean; checked?: boolean }>;
  if (Object.keys(rawItems).length !== MENU_STATE_COMMANDS.length) return null;
  for (const command of MENU_STATE_COMMANDS) {
    const item = rawItems[command];
    if (!isRecord(item) || typeof item.enabled !== 'boolean' || (item.checked !== undefined && typeof item.checked !== 'boolean')) return null;
    items[command] = item.checked === undefined
      ? { enabled: item.enabled }
      : { enabled: item.enabled, checked: item.checked };
  }

  const rawProject = value.project;
  const project = isRecord(rawProject)
    && typeof rawProject.hasContent === 'boolean'
    && typeof rawProject.dirty === 'boolean'
    && isRecord(rawProject.operation)
    && isOneOf(['idle', 'waiting-for-load-choice', 'waiting-for-project-confirmation', 'waiting-for-dirty-decision', 'loading', 'saving', 'model-import', 'completed', 'cancelled', 'failed'] as const, rawProject.operation.phase)
    && typeof rawProject.operation.progress === 'number'
    && Number.isFinite(rawProject.operation.progress)
    && rawProject.operation.progress >= 0 && rawProject.operation.progress <= 1
    && typeof rawProject.operation.cancellable === 'boolean'
    ? {
      hasContent: rawProject.hasContent,
      dirty: rawProject.dirty,
      operation: {
        phase: rawProject.operation.phase,
        progress: rawProject.operation.progress,
        ...(typeof rawProject.operation.message === 'string' ? { message: rawProject.operation.message } : {}),
        cancellable: rawProject.operation.cancellable,
      },
    }
    : null;
  if (!project) return null;

  return {
    version: 1,
    activeTab: value.activeTab,
    boot: { phase: value.boot.phase, error: value.boot.error },
    slicer: { status: value.slicer.status, progress: value.slicer.progress, error: value.slicer.error },
    scene: { hasModel: value.scene.hasModel },
    result: { hasResult: value.result.hasResult, exported: value.result.exported },
    project,
    host: { isElectron: value.host.isElectron, menuMode: value.host.menuMode },
    items,
  };
}

export function validateMenuStateSnapshot(value: unknown): MenuStateSnapshot | null {
  return cloneState(value);
}

function templateForItem(
  item: MenuItem,
  state: MenuStateSnapshot,
  onCommand: (command: MenuCommandId) => void,
  getCurrentState: () => MenuStateSnapshot = () => state,
): NativeMenuTemplateItem {
  if (item.separator) return { type: 'separator' };
  if (item.submenu) {
    return {
      label: item.label,
      submenu: item.submenu.map((child) => templateForItem(child, state, onCommand, getCurrentState)),
    };
  }
  const command = item.command!;
  const itemState = getCurrentState().items[command];
  return {
    id: item.testId,
    label: item.label,
    enabled: command === 'quit' || (itemState?.enabled ?? false),
    checked: itemState?.checked ?? false,
    click: () => {
      const currentState = getCurrentState();
      if (isMenuCommandId(command) && (command === 'quit' || currentState.items[command]?.enabled)) onCommand(command);
    },
  };
}

/** Pure translation of the renderer-owned model/state into Electron template data. */
export function buildNativeMenuTemplate(
  model: MenuModel,
  state: MenuStateSnapshot,
  onCommand: (command: MenuCommandId) => void,
  getCurrentState?: () => MenuStateSnapshot,
): NativeMenuTemplateItem[] {
  return model.menus.map((menu) => ({
    label: menu.label,
    submenu: menu.items.map((item) => templateForItem(item, state, onCommand, getCurrentState)),
  }));
}

export function isHostCommandId(value: unknown): value is 'quit' {
  return value === 'quit';
}

/** Main is intentionally limited to this one host-side command. */
export function handleHostCommand(value: unknown, onQuit: () => void): boolean {
  if (!isHostCommandId(value)) return false;
  onQuit();
  return true;
}

/** The renderer can request only this fixed source operation; it cannot pass a URL. */
export function openFixedSource(openExternal: (url: string) => Promise<void> | void): Promise<void> | void {
  return openExternal(SOURCE_URL);
}

export function createNativeMenuController(options: {
  platform: NodeJS.Platform;
  menu: NativeMenuApi;
  onCommand: (command: MenuCommandId) => void;
}): NativeMenuController {
  const mac = options.platform === 'darwin';
  let installed = false;
  let model = STARTUP_DISABLED_MENU_MODEL;
  let state = STARTUP_DISABLED_MENU_STATE;
  let nativeMenu: NativeMenuInstance | null = null;
  let itemsByCommand = new Map<MenuCommandId, NativeMenuItemInstance>();

  const updateNativeItems = () => {
    for (const [command, item] of itemsByCommand) {
      const stateItem = state.items[command];
      item.enabled = command === 'quit' || (stateItem?.enabled ?? false);
      item.checked = stateItem?.checked ?? false;
    }
  };

  const collectCommandIds = (items: readonly MenuItem[], result: Map<MenuCommandId, string>) => {
    for (const item of items) {
      if (item.command) result.set(item.command, item.testId);
      if (item.submenu) collectCommandIds(item.submenu, result);
    }
  };

  const rebuild = () => {
    if (!installed) return;
    const template = buildNativeMenuTemplate(model, state, options.onCommand, () => state);
    nativeMenu = options.menu.buildFromTemplate(template);
    options.menu.setApplicationMenu(nativeMenu);
    const ids = new Map<MenuCommandId, string>();
    for (const menu of model.menus) collectCommandIds(menu.items, ids);
    itemsByCommand = new Map<MenuCommandId, NativeMenuItemInstance>();
    for (const [command, id] of ids) {
      const nativeItem = nativeMenu.getMenuItemById(id);
      if (nativeItem) itemsByCommand.set(command, nativeItem);
    }
    updateNativeItems();
  };

  return {
    install() {
      if (!mac) {
        installed = false;
        nativeMenu = null;
        itemsByCommand.clear();
        options.menu.setApplicationMenu(null);
        return false;
      }
      model = STARTUP_DISABLED_MENU_MODEL;
      state = STARTUP_DISABLED_MENU_STATE;
      installed = true;
      rebuild();
      return true;
    },
    syncModel(value) {
      const normalized = validateMenuModel(value, mac ? 'native' : undefined);
      model = normalized ?? STARTUP_DISABLED_MENU_MODEL;
      if (mac) rebuild();
      return normalized !== null;
    },
    syncState(value) {
      const normalized = validateMenuStateSnapshot(value);
      state = normalized ?? STARTUP_DISABLED_MENU_STATE;
      if (mac) updateNativeItems();
      return normalized !== null;
    },
  };
}
