/// <reference types="vite/client" />

// An import makes this file a module — the global augmentation needs
// `declare global` to reach the real Window (classic env.d.ts gotcha).
import type { FileDialogFilter, AppConfigLoadResult } from '../../shared/ipc';

declare global {
  interface Window {
    orca: {
      version: string;
      openFileDialog(filters: FileDialogFilter[]): Promise<{ canceled: boolean; path: string | null }>;
      saveFileDialog(defaultName: string, filters: FileDialogFilter[]): Promise<{ canceled: boolean; path: string | null }>;
      readFile(path: string): Promise<ArrayBuffer>;
      writeFile(path: string, bytes: ArrayBuffer): Promise<void>;
      appConfig: {
        load(): Promise<AppConfigLoadResult>;
        save(json: unknown): Promise<void>;
      };
      platform: string;
    };
  }
}

export {};
