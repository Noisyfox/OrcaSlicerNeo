import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopUserPresetStorage } from './userPresetStorage';
import * as atomicFile from '../main/atomicFile';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-user-presets-'));
  directories.push(directory);
  return { directory, storage: createDesktopUserPresetStorage(directory) };
}
describe('local user preset files', () => {
  it('survives restart and overwrites external edits only on explicit save', async () => {
    const { directory, storage } = await fixture();
    await storage.write([{ path: 'filament/My PLA.json', content: '{"temperature":200}' }]);
    const loaded = await storage.load();
    await writeFile(join(directory, 'filament/My PLA.json'), '{"temperature":215}');
    expect(loaded[0]!.content).toContain('200');
    await storage.write([{ path: 'filament/My PLA.json', content: '{"temperature":210}' }]);
    expect(await createDesktopUserPresetStorage(directory).load()).toEqual([
      { path: 'filament/My PLA.json', content: '{"temperature":210}' },
    ]);
    await storage.write([{ path: 'filament/My PLA.json', content: null }]);
    expect(await storage.load()).toEqual([]);
  });
  it.each(['../escape.json', 'filament/../../escape.json', 'machine/CON.json', 'process/x:.json'])('rejects unsafe path %s', async path => {
    const { storage } = await fixture();
    await expect(storage.write([{ path, content: '{}' }])).rejects.toThrow();
  });
  it('does not touch unrelated files', async () => {
    const { directory, storage } = await fixture();
    await storage.load();
    await writeFile(join(directory, 'notes.txt'), 'keep');
    await storage.write([{ path: 'process/Fine.json', content: '{}' }]);
    expect(await readFile(join(directory, 'notes.txt'), 'utf8')).toBe('keep');
  });

  it('moves a detached base preset to its flat path in one save and survives restart', async () => {
    const { directory, storage } = await fixture();
    await storage.write([{ path: 'filament/base/My PLA.json', content: '{"temperature":200}' }]);
    const write = atomicFile.writeFileAtomically;
    vi.spyOn(atomicFile, 'writeFileAtomically').mockImplementationOnce(async (...args) => {
      const oldFile = join(directory, 'filament/base/My PLA.json');
      expect(await readFile(oldFile, 'utf8')).toBe('{"temperature":200}');
      await write(...args);
      expect(await readFile(args[0], 'utf8')).toBe('{"temperature":210}');
      expect(await readFile(oldFile, 'utf8')).toBe('{"temperature":200}');
    });
    // Native replacement receipts list deletion first; the host must write the
    // new file completely before it removes the only existing source file.
    await storage.write([
      { path: 'filament/base/My PLA.json', content: null },
      { path: 'filament/My PLA.json', content: '{"temperature":210}' },
    ]);
    expect(await createDesktopUserPresetStorage(directory).load()).toEqual([
      { path: 'filament/My PLA.json', content: '{"temperature":210}' },
    ]);
  });

  it('validates the entire batch before changing a file', async () => {
    const { storage } = await fixture();
    const original = [{ path: 'process/Fine.json', content: '{"layer_height":0.12}' }];
    await storage.write(original);
    await expect(storage.write([
      { path: 'process/Fine.json', content: null },
      { path: '../escape.json', content: '{}' },
    ])).rejects.toThrow('Invalid user preset path');
    expect(await storage.load()).toEqual(original);
  });

  it('rejects duplicate paths before writing any item', async () => {
    const { storage } = await fixture();
    const original = [{ path: 'process/Fine.json', content: '{"layer_height":0.12}' }];
    await storage.write(original);
    const write = vi.spyOn(atomicFile, 'writeFileAtomically');
    await expect(storage.write([
      { path: 'process/Fine.json', content: '{"layer_height":0.2}' },
      { path: 'process/Fine.json', content: null },
    ])).rejects.toThrow('Duplicate user preset path');
    expect(write).not.toHaveBeenCalled();
    expect(await storage.load()).toEqual(original);
  });

  it('keeps the source when the replacement in the second batch item fails', async () => {
    const { directory, storage } = await fixture();
    const original = [{ path: 'machine/base/Printer.json', content: '{"nozzle_diameter":[0.4]}' }];
    await storage.write(original);
    vi.spyOn(atomicFile, 'writeFileAtomically').mockRejectedValueOnce(new Error('second item failed'));
    await expect(storage.write([
      { path: 'machine/base/Printer.json', content: null },
      { path: 'machine/Printer.json', content: '{"nozzle_diameter":[0.6]}' },
    ])).rejects.toThrow('second item failed');
    expect(await createDesktopUserPresetStorage(directory).load()).toEqual(original);
  });

  it.each([false, true])('restores the prior set after a later write failure (existing destination: %s)', async exists => {
    const { directory, storage } = await fixture();
    const target = 'process/Fine.json';
    const original = [
      { path: 'process/base/Fine.json', content: '{"layer_height":0.12}' },
      ...(exists ? [{ path: target, content: '{"layer_height":0.16}' }] : []),
    ];
    await storage.write(original);
    const write = atomicFile.writeFileAtomically;
    vi.spyOn(atomicFile, 'writeFileAtomically').mockImplementationOnce(write).mockRejectedValueOnce(new Error('second write failed'));
    await expect(storage.write([
      { path: target, content: '{"layer_height":0.2}' },
      { path: 'process/base/Fine.json', content: null },
      { path: 'filament/PLA.json', content: '{}' },
    ])).rejects.toThrow('second write failed');
    expect((await createDesktopUserPresetStorage(directory).load()).sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual(original.sort((a, b) => a.path.localeCompare(b.path)));
  });
});
