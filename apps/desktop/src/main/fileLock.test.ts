import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withFileLock } from './fileLock';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('serializes actual independent processes without losing increments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-lock-')); directories.push(directory);
  const path = join(directory, 'counter'); await writeFile(path, '0');
  const moduleUrl = pathToFileURL(join(__dirname, 'fileLock.ts')).href;
  const source = `import { withFileLock } from ${JSON.stringify(moduleUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    const path = ${JSON.stringify(path)};
    for(let i=0;i<10;i++) await withFileLock(path, async () => {
      const current = Number(await readFile(path,'utf8'));
      await new Promise(resolve => setTimeout(resolve,2)); await writeFile(path,String(current+1));
    });`;
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', source])));
  expect(await readFile(path, 'utf8')).toBe('30');
});
it('releases a failed transaction so a subsequent write can proceed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-lock-')); directories.push(directory);
  const path = join(directory, 'state');
  await expect(withFileLock(path, async () => { throw Error('disk full'); })).rejects.toThrow('disk full');
  await expect(withFileLock(path, async () => 42)).resolves.toBe(42);
});
