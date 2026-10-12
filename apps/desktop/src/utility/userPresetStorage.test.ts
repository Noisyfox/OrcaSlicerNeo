import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopUserPresetStorage } from './userPresetStorage';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-user-presets-'));
  directories.push(directory);
  return { directory, storage: createDesktopUserPresetStorage(directory) };
}
describe('local user preset files', () => {
  it('survives restart and overwrites external edits only on explicit save', async () => {
    const { directory, storage } = await fixture();
    await storage.write({ path: 'filament/My PLA.json', content: '{"temperature":200}' });
    const loaded = await storage.load();
    await writeFile(join(directory, 'filament/My PLA.json'), '{"temperature":215}');
    expect(loaded[0]!.content).toContain('200');
    await storage.write({ path: 'filament/My PLA.json', content: '{"temperature":210}' });
    expect(await createDesktopUserPresetStorage(directory).load()).toEqual([
      { path: 'filament/My PLA.json', content: '{"temperature":210}' },
    ]);
    await storage.write({ path: 'filament/My PLA.json', content: null });
    expect(await storage.load()).toEqual([]);
  });
  it.each(['../escape.json', 'filament/../../escape.json', 'machine/CON.json', 'process/x:.json'])('rejects unsafe path %s', async path => {
    const { storage } = await fixture();
    await expect(storage.write({ path, content: '{}' })).rejects.toThrow();
  });
  it('does not touch unrelated files', async () => {
    const { directory, storage } = await fixture();
    await storage.load();
    await writeFile(join(directory, 'notes.txt'), 'keep');
    await storage.write({ path: 'process/Fine.json', content: '{}' });
    expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('keep');
  });
});
