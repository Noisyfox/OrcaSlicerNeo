import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicFileDependencies {
  writeFile(path: string, bytes: Uint8Array, options: { flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultDependencies: AtomicFileDependencies = { writeFile, rename, unlink };

/**
 * Write a replacement beside the destination, then atomically rename it into
 * place. Any failure cleans up the temporary file and leaves the old target
 * untouched.
 */
export async function writeFileAtomically(
  target: string,
  bytes: Uint8Array,
  dependencies: AtomicFileDependencies = defaultDependencies,
): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await dependencies.writeFile(temporary, bytes, { flag: 'wx' });
    await dependencies.rename(temporary, target);
  } catch (error) {
    await dependencies.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
