/// <reference types="vite/client" />

// An import makes this file a module — the global augmentation needs
// `declare global` to reach the real Window (classic env.d.ts gotcha).
import type { ElectronBridge } from '../../shared/ipc';

declare global {
  interface Window {
    orca: ElectronBridge;
  }
}

export {};
