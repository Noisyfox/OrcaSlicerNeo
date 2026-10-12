import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserUserPresetStorage } from './userPresetStorage';

describe('browser user preset repository', () => {
  it('persists independent preset types across repository instances and deletes atomically', async () => {
    const factory = new IDBFactory();
    const first = createBrowserUserPresetStorage(factory);
    await first.write({ path: 'filament/PLA.json', content: '{"version":1}' });
    await first.write({ path: 'process/PLA.json', content: '{"version":2}' });
    const second = createBrowserUserPresetStorage(factory);
    expect(await second.load()).toHaveLength(2);
    await second.write({ path: 'filament/PLA.json', content: '{"version":3}' });
    await second.write({ path: 'process/PLA.json', content: null });
    expect(await first.load()).toEqual([{ path: 'filament/PLA.json', content: '{"version":3}' }]);
  });
  it('rejects invalid writes without changing stored files', async () => {
    const storage = createBrowserUserPresetStorage(new IDBFactory());
    await storage.write({ path: 'machine/My Printer.json', content: '{}' });
    await expect(storage.write({ path: '../escape.json', content: '{}' })).rejects.toThrow();
    expect(await storage.load()).toEqual([{ path: 'machine/My Printer.json', content: '{}' }]);
  });
});
