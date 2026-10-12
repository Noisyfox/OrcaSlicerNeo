import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { UserPresetStorage } from '../../../../packages/slicer-wasm/src/client/userPresets';
import { validateUserPresetPath } from '../../../../packages/slicer-wasm/src/client/userPresets';
import { writeFileAtomically } from '../main/atomicFile';

const kinds = ['machine', 'filament', 'process'] as const;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Trusted main-process path. Never accept a renderer-supplied directory. */
export function createDesktopUserPresetStorage(directory: string): UserPresetStorage {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('User preset directory must be absolute');
  const ensureDirectories = async () => {
    await mkdir(directory, { recursive: true });
    for (const path of [directory, ...kinds.map(kind => join(directory, kind))]) {
      await mkdir(path, { recursive: true });
      if ((await lstat(path)).isSymbolicLink()) throw new Error('User preset directories cannot be symbolic links');
    }
  };
  return {
    async load() {
      await ensureDirectories();
      const files = [];
      for (const kind of kinds) {
        for (const entry of await readdir(join(directory, kind), { withFileTypes: true })) {
          if (!entry.name.endsWith('.json')) continue;
          if (!entry.isFile()) throw new Error(`User preset is not a regular file: ${entry.name}`);
          const path = `${kind}/${entry.name}`;
          validateUserPresetPath(path);
          files.push({ path, content: await readFile(join(directory, path), 'utf8') });
        }
      }
      return files;
    },
    async write(change) {
      validateUserPresetPath(change.path);
      await ensureDirectories();
      const target = join(directory, change.path);
      // Atomic replacement deliberately ignores external edits since the last load.
      if (change.content === null) {
        try { await unlink(target); } catch (error) { if (!missing(error)) throw error; }
      } else await writeFileAtomically(target, new TextEncoder().encode(change.content));
    },
  };
}
