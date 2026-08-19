import type { SlicerClient } from '@slicer/client';

/** A model selected by a host. sourcePath is host-private and optional. */
export interface ModelFile {
  name: string;
  bytes: Uint8Array;
  sourcePath?: string;
}

export interface ModelPicker {
  pick(): Promise<ModelFile | null>;
}

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

export interface ProfileSource {
  resolve(relativePath: string): string;
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

export type SlicerRuntime = SlicerClient;

export interface PlatformCapabilities {
  models: ModelPicker;
  exports: GcodeExporter;
  preferences: UserPreferencesRepository;
  runtime: SlicerRuntime;
  profiles: ProfileSource;
  chrome: { kind: 'desktop' | 'web'; platform?: string };
}
