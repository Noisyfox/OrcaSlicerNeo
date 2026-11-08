import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { UserPresetStorage } from '../../../../packages/slicer-wasm/src/client/userPresets';
import { validateUserPresetPath } from '../../../../packages/slicer-wasm/src/client/userPresets';
import { writeFileAtomically } from '../main/atomicFile';

const kinds = ['machine', 'filament', 'process'] as const;
const folders = kinds.flatMap(kind => [kind, `${kind}/base`]);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Trusted main-process path. Never accept a renderer-supplied directory. */
export function createDesktopUserPresetStorage(directory: string): UserPresetStorage {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new Error('User preset directory must be absolute');
  const ensureDirectories = async () => {
    await mkdir(directory, { recursive: true });
    for (const path of [directory, ...folders.map(kind => join(directory, kind))]) {
      await mkdir(path, { recursive: true });
      if ((await lstat(path)).isSymbolicLink()) throw new Error('User preset directories cannot be symbolic links');
    }
  };
  return {
    async load() {
      await ensureDirectories();
      const files = [];
      for (const kind of folders) {
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
    async write(changes) {
      const writes = changes.map(change => ({ ...change }));
      const paths = new Set<string>();
      for (const change of writes) {
        validateUserPresetPath(change.path);
        if (paths.has(change.path)) throw new Error('Duplicate user preset path');
        paths.add(change.path);
      }
      if (writes.length === 0) return;
      await ensureDirectories();
      const previous = new Map<string, Uint8Array | null>();
      for (const { path } of writes) {
        const target = join(directory, path);
        try {
          if (!(await lstat(target)).isFile()) throw new Error(`User preset is not a regular file: ${path}`);
          previous.set(path, await readFile(target));
        } catch (error) {
          if (!missing(error)) throw error;
          previous.set(path, null);
        }
      }
      const remove = async (target: string) => {
        try { await unlink(target); } catch (error) { if (!missing(error)) throw error; }
      };
      // One native action may move a preset out of base/. Capture every old file
      // before writing so a later failure restores the complete previous set.
      // Write every replacement before deleting old paths: an interruption can
      // leave both copies, but cannot delete the only copy before its replacement.
      // Per-file replacement is atomic; this adds in-process failure rollback,
      // not a cross-process transaction or a durable recovery journal.
      const applied = new Set<string>();
      const replacements = writes.filter(change => change.content !== null);
      const deletions = writes.filter(change => change.content === null);
      try {
        for (const change of [...replacements, ...deletions]) {
          const target = join(directory, change.path);
          // Explicit saves still overwrite external edits since the last load.
          if (change.content === null) await remove(target);
          else await writeFileAtomically(target, new TextEncoder().encode(change.content));
          applied.add(change.path);
        }
      } catch (error) {
        const failures: unknown[] = [];
        for (const path of [...applied].reverse()) {
          try {
            const target = join(directory, path), bytes = previous.get(path)!;
            if (bytes === null) await remove(target);
            else await writeFileAtomically(target, bytes);
          } catch (failure) { failures.push(failure); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'User preset write failed and rollback was incomplete');
        throw error;
      }
    },
  };
}
