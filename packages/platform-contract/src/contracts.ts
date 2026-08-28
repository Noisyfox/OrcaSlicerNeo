import type { SlicerClient } from '@slicer/client';
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

export interface GcodeExporter {
  save(defaultName: string, bytes: Uint8Array): Promise<void>;
}

/** Persistence is deliberately opaque until the shared preference migration. */
export interface UserPreferences {
  version: 1;
  selectedProfiles: {
    printer?: string;
    print?: string;
    filament?: string;
  };
  ui: { sidebarWidth?: number };
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
  selectedProfiles: {},
  ui: {},
};

export function normalizeUserPreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return { ...DEFAULT_USER_PREFERENCES, selectedProfiles: {}, ui: {} };
  }
  const v = value as { selectedProfiles?: Record<string, unknown>; ui?: Record<string, unknown> };
  const selectedProfiles = v.selectedProfiles ?? {};
  const ui = v.ui ?? {};
  return {
    version: 1,
    selectedProfiles: {
      ...(typeof selectedProfiles.printer === 'string' ? { printer: selectedProfiles.printer } : {}),
      ...(typeof selectedProfiles.print === 'string' ? { print: selectedProfiles.print } : {}),
      ...(typeof selectedProfiles.filament === 'string' ? { filament: selectedProfiles.filament } : {}),
    },
    ui: typeof ui.sidebarWidth === 'number' && Number.isFinite(ui.sidebarWidth)
      ? { sidebarWidth: ui.sidebarWidth } : {},
  };
}

export type RuntimePhase = 'checking-capabilities' | 'loading-runtime' | 'installing-profiles' | 'ready' | 'unsupported' | 'failed';
export interface RuntimeStatus { phase: RuntimePhase; message?: string; }

/** The existing typed client, with lifecycle status added at the host boundary. */
export interface SlicerRuntime extends SlicerClient {
  readonly status?: RuntimeStatus;
}

export interface PlatformCapabilities {
  models: ModelPicker;
  exports: GcodeExporter;
  preferences: UserPreferencesRepository;
  printers: { configuration: PrinterConfigurationRepository; transport: PrinterTransport };
  webview: WebViewHost;
  runtime: SlicerRuntime;
  profiles: ProfileSource;
  chrome: PlatformChrome;
  menu: PlatformMenu;
  externalLinks: ExternalLinks;
}
