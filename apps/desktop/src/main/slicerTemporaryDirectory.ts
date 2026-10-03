import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** Main owns the exact directory until its utility process has exited. */
export function createSlicerTemporaryDirectory(): { path: string; remove(): Promise<void> } {
  const parent = realpathSync(tmpdir());
  const path = mkdtempSync(join(parent, 'orca-slicer-'));
  return {
    path,
    async remove() {
      // Never remove a caller-provided directory or broaden this to the temp
      // root. Keep cleanup confined to the child created for this session.
      if (!isAbsolute(path) || dirname(path) !== parent || !/^orca-slicer-[A-Za-z0-9]{6}$/.test(basename(path))) {
        throw new Error('Invalid slicer session temporary directory');
      }
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
