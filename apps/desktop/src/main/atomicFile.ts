import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface AtomicFileDependencies {
  writeFile(path: string, bytes: Uint8Array, options: { flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  platform: NodeJS.Platform;
  delay(milliseconds: number): Promise<void>;
}

const defaultDependencies: AtomicFileDependencies = { writeFile, rename, unlink, platform: process.platform, delay };
const renameRetryDelays = [10, 20, 40, 80, 160, 320];

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
    for (let attempt = 0; ; attempt++) {
      try {
        await dependencies.rename(temporary, target);
        break;
      } catch (error) {
        // Windows scanners/readers can briefly prevent replacing an existing
        // file. Retry only the rename, keeping the complete temporary file and
        // the old destination intact. Permanent failures still reject below.
        const code = (error as NodeJS.ErrnoException).code;
        if (dependencies.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
          || attempt >= renameRetryDelays.length) throw error;
        await dependencies.delay(renameRetryDelays[attempt]);
      }
    }
  } catch (error) {
    await dependencies.unlink(temporary).catch(() => undefined);
    throw error;
  }
}
