import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

class InProcessChannel implements WorkerTransport {
  private listeners: ((message: WorkerMessage) => void)[] = [];
  readonly transfers: Transferable[][] = [];

  onMessage(listener: (message: WorkerMessage) => void): void {
    this.listeners.push(listener);
  }

  post(message: WorkerMessage, transfer?: Transferable[]): void {
    if (transfer) this.transfers.push(transfer);
    for (const listener of this.listeners) listener(message);
  }
}

function addFilesystemFixture() {
  const module = createMockModule();
  module.FS.mkdir('/files');
  module.FS.mkdir('/files/nested');
  module.FS.writeFile('/files/zeta.bin', Uint8Array.from([9, 8, 7]));
  module.FS.writeFile('/files/Alpha.txt', new TextEncoder().encode('alpha'));
  module.FS.writeFile('/files/nested/child.dat', Uint8Array.from([1, 2]));
  return module;
}

describe('SlicerClient filesystem boundary', () => {
  it('lists only immediate entries with stable names, directory flags, and byte sizes', async () => {
    const module = addFilesystemFixture();
    const client = createClient(async () => module);

    await expect(client.listFilesystemDirectory('/files')).resolves.toEqual([
      { name: 'Alpha.txt', isDirectory: false, sizeBytes: 5 },
      { name: 'nested', isDirectory: true, sizeBytes: null },
      { name: 'zeta.bin', isDirectory: false, sizeBytes: 3 },
    ]);
    await expect(client.listFilesystemDirectory('/files/nested')).resolves.toEqual([
      { name: 'child.dat', isDirectory: false, sizeBytes: 2 },
    ]);
    await expect(client.listFilesystemDirectory('/')).resolves.toEqual([
      { name: 'files', isDirectory: true, sizeBytes: null },
      { name: 'profiles', isDirectory: true, sizeBytes: null },
      { name: 'tmp', isDirectory: true, sizeBytes: null },
    ]);
  });

  it('preserves filesystem errors and rejects non-absolute, non-directory, and non-file paths', async () => {
    const module = addFilesystemFixture();
    const client = createClient(async () => module);

    await expect(client.listFilesystemDirectory('files')).rejects.toThrow(/absolute/);
    await expect(client.listFilesystemDirectory('/missing')).rejects.toThrow(/ENOENT/);
    await expect(client.listFilesystemDirectory('/files/Alpha.txt')).rejects.toThrow(/ENOTDIR/);
    await expect(client.readFilesystemFile('files/zeta.bin')).rejects.toThrow(/absolute/);
    await expect(client.readFilesystemFile('/files')).rejects.toThrow(/EISDIR/);
    await expect(client.readFilesystemFile('/missing.bin')).rejects.toThrow(/ENOENT/);

    const stat = module.FS.stat;
    module.FS.stat = (path) => path === '/device'
      ? { mode: 0x2000, size: 0 }
      : stat(path);
    await expect(client.readFilesystemFile('/device')).rejects.toThrow(/regular file/);
  });

  it('reads an owned regular-file byte snapshot that remains safe to transfer', async () => {
    const module = addFilesystemFixture();
    const client = createClient(async () => module);
    const bytes = await client.readFilesystemFile('/files/zeta.bin');

    const transferred = structuredClone(bytes, { transfer: [bytes.buffer as ArrayBuffer] });
    expect([...transferred]).toEqual([9, 8, 7]);
    expect(bytes.byteLength).toBe(0);
    await expect(client.readFilesystemFile('/files/zeta.bin')).resolves.toEqual(Uint8Array.from([9, 8, 7]));
  });

  it('dispatches directory reads and transfers file bytes through the Worker client', async () => {
    const module = addFilesystemFixture();
    const channel = new InProcessChannel();
    const client = createWorkerClient(channel);
    void startWorker(async () => module, (message, transfer) => channel.post(message, transfer),
      (listener) => channel.onMessage(listener));

    await expect(client.listFilesystemDirectory('/files')).resolves.toMatchObject([
      { name: 'Alpha.txt', isDirectory: false, sizeBytes: 5 },
      { name: 'nested', isDirectory: true, sizeBytes: null },
      { name: 'zeta.bin', isDirectory: false, sizeBytes: 3 },
    ]);
    const bytes = await client.readFilesystemFile('/files/zeta.bin');
    expect([...bytes]).toEqual([9, 8, 7]);
    expect(channel.transfers.flat()).toEqual([bytes.buffer]);
  });
});
