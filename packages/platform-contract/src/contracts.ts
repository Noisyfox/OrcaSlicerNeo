import type { SlicerClient } from '@slicer/client';
import type { HistoryRuntimeMethods } from '@slicer/client';
import type { PrinterConfigurationDocument, PrinterTransport } from '@orca/printer-control';
import type { MenuCommandId, MenuModel, MenuStateSnapshot, PlatformMenu, TitlebarMenuMode } from './menu';

export type { MenuCommandId, MenuModel, MenuStateSnapshot, PlatformMenu, TitlebarMenuMode } from './menu';

export interface ExternalLinks {
  /** Opens the fixed AGPL-3.0 source page; arbitrary URLs are not accepted. */
  openSource(): Promise<void> | void;
}

/** A model selected by a host. Host paths must never cross this boundary. */
export interface ModelFile {
  displayName: string;
  bytes: Uint8Array;
}

export interface ModelImporter {
  pick(): Promise<ModelFile | null>;
}
/** @deprecated Use ModelImporter; retained as a naming bridge for host adapters. */
export type ModelPicker = ModelImporter;

/** Values persisted for the Orca/Bambu 3MF project-load policy. */
export const PROJECT_LOAD_BEHAVIOURS = [
  'load_all',
  'ask_when_relevant',
  'always_ask',
  'load_geometry_only',
] as const;
export type ProjectLoadBehaviour = typeof PROJECT_LOAD_BEHAVIOURS[number];
export const DEFAULT_PROJECT_LOAD_BEHAVIOUR: ProjectLoadBehaviour = 'ask_when_relevant';

/**
 * A host-owned project location. The object deliberately has no path or
 * serializable identifier; only the host adapter that created it can use it.
 */
export interface OpaqueProjectLocation {
  readonly __opaqueProjectLocation: unique symbol;
}

/** Bytes and display metadata for a project, with an optional host location. */
export interface ProjectInput {
  displayName: string;
  bytes: Uint8Array;
  location?: OpaqueProjectLocation;
}
export type ProjectFileInput = ProjectInput;
export type ProjectLocation = OpaqueProjectLocation;

export type ProjectOpenResult =
  | { status: 'ok'; input: ProjectInput }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };
export type ProjectSaveResult =
  | { status: 'ok'; location?: OpaqueProjectLocation }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };
export type ProjectSaveAsResult = ProjectSaveResult;

/** A host-neutral batch returned by a multi-selection picker or drag/drop. */
export type ProjectOpenBatchResult =
  | { status: 'ok'; inputs: ProjectInput[] }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

export interface ProjectFileCapability {
  open(): Promise<ProjectOpenResult>;
  /** Optional multi-file picker. Older hosts may implement only open(). */
  openMany?(): Promise<ProjectOpenBatchResult>;
  /** Optional drag/drop bridge; host may attach a private source location. */
  openDropped?(files: readonly ProjectDropFile[]): Promise<ProjectOpenBatchResult>;
  save(input: ProjectInput): Promise<ProjectSaveResult>;
  saveAs(input: ProjectInput): Promise<ProjectSaveAsResult>;
}

export interface ProjectDropFile {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Native window lifecycle events are host-owned; no filesystem data crosses here. */
export interface PlatformLifecycle {
  onCloseRequest(listener: () => void | Promise<void>): () => void;
  respondClose(allow: boolean): Promise<void> | void;
}

export interface GcodeExporter {
  save(defaultName: string, bytes: Uint8Array): Promise<void>;
}

export interface GcodeTextWindowGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UserPreferences {
  version: 1;
  /** Global project-open policy; project bytes and locations never belong here. */
  projectLoadBehaviour?: ProjectLoadBehaviour;
  selectedProfiles: {
    printer?: string;
    print?: string;
    filament?: string;
  };
  ui: {
    sidebarWidth?: number;
    deviceSidebarWidth?: number;
    /** Whether successful G-code sends should navigate to Device by default. */
    switchToDeviceAfterSend?: boolean;
    /** Last usable G-code text overlay geometry. */
    gcodeTextWindow?: GcodeTextWindowGeometry;
  };
}

export interface UserPreferencesRepository {
  load(): Promise<UserPreferences>;
  save(value: UserPreferences): Promise<void>;
}

/** Persistent printer records. Transport and network concerns stay separate. */
export interface PrinterConfigurationRepository {
  load(): Promise<PrinterConfigurationDocument>;
  save(document: PrinterConfigurationDocument): Promise<void>;
}

/** The intentionally small state surface shared by embedded printer consoles. */
export type WebViewPanelStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface WebViewPanelState {
  status: WebViewPanelStatus;
  /** The URL selected by the host. A cross-origin page is never inspected. */
  url: string | null;
  error: string | null;
}

export interface WebViewPanelCapabilities {
  canInjectBuiltInScripts: boolean;
  canExposeHostApi: boolean;
  canExecuteJavaScript: boolean;
}

export interface WebViewPanelEvents {
  onStateChange?(state: WebViewPanelState): void;
  onNavigation?(url: string): void;
}

export interface WebViewPanelOptions {
  url?: string;
  title?: string;
}

/** Script source and secrets stay host-owned; shared callers pass an ID only. */
export interface BuiltInScriptRequest {
  scriptId: string;
  context?: unknown;
}

export type WebViewOperationResult<T = never> =
  | { status: 'ok'; value?: T }
  | { status: 'unsupported'; reason: 'capability-unavailable' };

/** A mounted, host-backed embedded page. */
export interface WebViewPanel {
  readonly capabilities: WebViewPanelCapabilities;
  readonly state: WebViewPanelState;
  load(url: string): void;
  /** Host-owned, reviewed script ID plus its validated context; never source. */
  registerBuiltInScript(request: BuiltInScriptRequest): WebViewOperationResult;
  /** A host-owned, serializable capability object; implementations may reject it. */
  exposeHostApi(name: string, api: unknown): WebViewOperationResult;
  /** Available only to reviewed host code; shared UI has no user-script entry point. */
  executeJavaScript<T = unknown>(script: string): Promise<WebViewOperationResult<T>>;
  dispose(): void;
}

/** Host factory used by shared UI; implementations own their embedded element. */
export interface WebViewHost {
  readonly capabilities: WebViewPanelCapabilities;
  mount(container: HTMLElement, options?: WebViewPanelOptions, events?: WebViewPanelEvents): WebViewPanel;
}

export interface PlatformChrome {
  kind: 'desktop' | 'web';
  platform?: string;
  menuMode: TitlebarMenuMode;
  /** Whether the host supplies a draggable frameless-window region. */
  dragRegion?: boolean;
  /** Whether the host needs clearance for macOS traffic-light buttons. */
  macSafeInset?: boolean;
}

export interface ProfilePackage { id: string; kind: 'core' | 'vendor'; path: string; }
export interface ProfileManifest { version: 1; packages: ProfilePackage[]; }

/** Supplies profile assets using deployment-relative URLs, never host paths. */
export interface ProfileSource {
  fetch(relativePath: string): Promise<Uint8Array | ReadableStream<Uint8Array>>;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  version: 1,
  projectLoadBehaviour: DEFAULT_PROJECT_LOAD_BEHAVIOUR,
  selectedProfiles: {},
  ui: { switchToDeviceAfterSend: true },
};

export function normalizeGcodeTextWindowGeometry(value: unknown): GcodeTextWindowGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const geometry = value as Record<string, unknown>;
  const keys = ['left', 'top', 'width', 'height'] as const;
  if (!keys.every((key) => typeof geometry[key] === 'number' && Number.isFinite(geometry[key]))) {
    return undefined;
  }
  return {
    left: geometry.left as number,
    top: geometry.top as number,
    width: geometry.width as number,
    height: geometry.height as number,
  };
}

export function normalizeUserPreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return { ...DEFAULT_USER_PREFERENCES, selectedProfiles: {}, ui: { switchToDeviceAfterSend: true } };
  }
  const v = value as { projectLoadBehaviour?: unknown; selectedProfiles?: Record<string, unknown>; ui?: Record<string, unknown> };
  const selectedProfiles = v.selectedProfiles ?? {};
  const ui = v.ui ?? {};
  const gcodeTextWindow = normalizeGcodeTextWindowGeometry(ui.gcodeTextWindow);
  return {
    version: 1,
    projectLoadBehaviour: PROJECT_LOAD_BEHAVIOURS.includes(v.projectLoadBehaviour as ProjectLoadBehaviour)
      ? v.projectLoadBehaviour as ProjectLoadBehaviour
      : DEFAULT_PROJECT_LOAD_BEHAVIOUR,
    selectedProfiles: {
      ...(typeof selectedProfiles.printer === 'string' ? { printer: selectedProfiles.printer } : {}),
      ...(typeof selectedProfiles.print === 'string' ? { print: selectedProfiles.print } : {}),
      ...(typeof selectedProfiles.filament === 'string' ? { filament: selectedProfiles.filament } : {}),
    },
    ui: {
      ...(typeof ui.sidebarWidth === 'number' && Number.isFinite(ui.sidebarWidth)
        ? { sidebarWidth: ui.sidebarWidth } : {}),
      ...(typeof ui.deviceSidebarWidth === 'number' && Number.isFinite(ui.deviceSidebarWidth)
        ? { deviceSidebarWidth: ui.deviceSidebarWidth } : {}),
      switchToDeviceAfterSend: typeof ui.switchToDeviceAfterSend === 'boolean'
        ? ui.switchToDeviceAfterSend : true,
      ...(gcodeTextWindow ? { gcodeTextWindow } : {}),
    },
  };
}

export type RuntimePhase = 'checking-capabilities' | 'loading-runtime' | 'installing-profiles' | 'ready' | 'unsupported' | 'failed';
export interface RuntimeStatus { phase: RuntimePhase; message?: string; }

/** The existing typed client, with lifecycle status added at the host boundary. */
export interface SlicerRuntime extends SlicerClient, HistoryRuntimeMethods {
  readonly status?: RuntimeStatus;
}

export interface PlatformCapabilities {
  models: ModelPicker;
  exports: GcodeExporter;
  projects: ProjectFileCapability;
  preferences: UserPreferencesRepository;
  printers: { configuration: PrinterConfigurationRepository; transport: PrinterTransport };
  webview: WebViewHost;
  runtime: SlicerRuntime;
  lifecycle?: PlatformLifecycle;
  profiles: ProfileSource;
  chrome: PlatformChrome;
  menu: PlatformMenu;
  externalLinks: ExternalLinks;
}
