import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createBrowserUserPresetStorage } from './userPresetStorage';

afterEach(() => vi.restoreAllMocks());

describe('browser user preset repository', () => {
  it('persists independent preset types across repository instances and deletes atomically', async () => {
    const factory = new IDBFactory();
    const first = createBrowserUserPresetStorage(factory);
    await first.write([{ path: 'filament/PLA.json', content: '{"version":1}' }]);
    await first.write([{ path: 'process/PLA.json', content: '{"version":2}' }]);
    const second = createBrowserUserPresetStorage(factory);
    expect(await second.load()).toHaveLength(2);
    await second.write([{ path: 'filament/PLA.json', content: '{"version":3}' }, { path: 'process/PLA.json', content: null }]);
    expect(await first.load()).toEqual([{ path: 'filament/PLA.json', content: '{"version":3}' }]);
  });
  it('rejects invalid writes without changing stored files', async () => {
    const storage = createBrowserUserPresetStorage(new IDBFactory());
    await storage.write([{ path: 'machine/My Printer.json', content: '{}' }]);
    await expect(storage.write([{ path: 'machine/My Printer.json', content: null }, { path: '../escape.json', content: '{}' }])).rejects.toThrow();
    expect(await storage.load()).toEqual([{ path: 'machine/My Printer.json', content: '{}' }]);
  });

  it('moves a detached base preset to the flat path without leaving a stale copy', async () => {
    const factory = new IDBFactory();
    const storage = createBrowserUserPresetStorage(factory);
    await storage.write([{ path: 'filament/base/PLA.json', content: '{"temperature":200}' }]);
    await storage.write([
      { path: 'filament/PLA.json', content: '{"temperature":210}' },
      { path: 'filament/base/PLA.json', content: null },
    ]);
    expect(await createBrowserUserPresetStorage(factory).load()).toEqual([
      { path: 'filament/PLA.json', content: '{"temperature":210}' },
    ]);
  });

  it('aborts earlier deletes when the second item cannot be enqueued', async () => {
    const factory = new IDBFactory();
    const storage = createBrowserUserPresetStorage(factory);
    const original = [{ path: 'machine/base/Printer.json', content: '{"nozzle_diameter":[0.4]}' }];
    await storage.write(original);
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new Error('second item failed'); });
    await expect(storage.write([
      { path: 'machine/base/Printer.json', content: null },
      { path: 'machine/Printer.json', content: '{"nozzle_diameter":[0.6]}' },
    ])).rejects.toThrow('second item failed');
    expect(await createBrowserUserPresetStorage(factory).load()).toEqual(original);
  });

  it('rolls back all requests when a later IndexedDB request aborts the transaction', async () => {
    const storage = createBrowserUserPresetStorage(new IDBFactory());
    const original = [{ path: 'process/base/Fine.json', content: '{"layer_height":0.12}' }];
    await storage.write(original);
    // Force the second put to collide with an existing key. IndexedDB reports
    // this asynchronously, after the earlier write/delete requests were queued.
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(put).mockImplementationOnce(function (this: IDBObjectStore) {
      return this.add(original[0]);
    });
    await expect(storage.write([
      { path: 'process/Fine.json', content: '{"layer_height":0.2}' },
      { path: 'filament/PLA.json', content: '{}' },
      { path: 'process/base/Fine.json', content: null },
    ])).rejects.toMatchObject({ name: 'ConstraintError' });
    expect(await storage.load()).toEqual(original);
  });
});
