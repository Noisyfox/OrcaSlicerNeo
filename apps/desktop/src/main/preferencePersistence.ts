import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { normalizeUserPreferences, type UserPreferences } from '../../../../packages/platform-contract/src/contracts';
import { writeFileAtomically } from './atomicFile';
import { withFileLock } from './fileLock';
export async function readPreferences(path: string): Promise<UserPreferences> {
  try { return normalizeUserPreferences(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return normalizeUserPreferences(null);
    throw error;
  }
}
export function savePreferences(path: string, value: unknown): Promise<void> {
  return withFileLock(path, () => writeFileAtomically(path, Buffer.from(JSON.stringify(normalizeUserPreferences(value)), 'utf8')));
}
/** Conflicts return the latest document so the renderer can reapply its field-specific update. */
export function compareAndSwapPreferences(path: string, base: unknown, next: unknown) {
  return withFileLock(path, async () => {
    const current = await readPreferences(path);
    if (!isDeepStrictEqual(current, normalizeUserPreferences(base))) return { updated: false, current };
    const normalized = normalizeUserPreferences(next);
    await writeFileAtomically(path, Buffer.from(JSON.stringify(normalized), 'utf8'));
    return { updated: true, current: normalized };
  });
}
