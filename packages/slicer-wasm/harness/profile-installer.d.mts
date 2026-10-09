import type { ProfileActivation } from '../src/client/setupWizard';
/** Test-only JSON fixture activation generator shared with native harnesses. */
export function fixtureProfileActivation(module: { FS: {
  readdir(path: string): string[];
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
  symlink(target: string, path: string): void;
} }): ProfileActivation;
