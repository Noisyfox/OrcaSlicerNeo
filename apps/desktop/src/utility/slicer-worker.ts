import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startSlicerHost } from '../../../../packages/slicer-runtime/src/slicer/workerHost';
import type { OrcaModule, WorkerMessage } from '../../../../packages/slicer-wasm/src/client';

if (!parentPort) throw new Error('Slicer requires a Node Worker');
const temporaryDirectory: unknown = workerData?.temporaryDirectory;
if (typeof temporaryDirectory !== 'string' || temporaryDirectory.includes('\0') || !isAbsolute(temporaryDirectory)) {
  throw new Error('Slicer requires an absolute session temporary directory');
}
const port = parentPort;
// Generated assets are unpacked in packaged apps so Node/Emscripten pthreads
// can import the ES module and read its WASM/data files without asar hooks.
const assets = (import.meta.env.DEV
  ? join(__dirname, '../../src/renderer/public')
  : join(__dirname, '../renderer')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

startSlicerHost({
  threaded: typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object',
  nativeTemporaryDirectory: temporaryDirectory,
  async load(variant) {
    const directory = join(assets, 'wasm', variant);
    const mod = await import(/* @vite-ignore */ pathToFileURL(join(directory, 'orca_slice.js')).href) as {
      default: (options: { noInitialRun: boolean; locateFile(path: string): string }) => Promise<OrcaModule>;
    };
    return mod.default({ noInitialRun: true, locateFile: (path) => join(directory, path) });
  },
  profiles: { fetch: async (relative) => readFile(join(assets, 'profiles', relative)) },
  post: (message, transfer) => port.postMessage(message, transfer as ArrayBuffer[] | undefined),
  onMessage: (listener) => port.on('message', (message: WorkerMessage) => listener(message)),
});
