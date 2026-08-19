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
export interface UserPreferencesRepository {
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
}

export interface ProfileSource {
  resolve(relativePath: string): string;
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
