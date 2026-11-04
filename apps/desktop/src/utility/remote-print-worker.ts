import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectRemotePrintResources } from '../../../../packages/slicer-runtime/src/core';
import type { OrcaModule, RemotePrintResourceBytes } from '../../../../packages/slicer-runtime/src/core';

if (!parentPort) throw new Error('Remote print inspection requires a Node Worker');
const port = parentPort;
const resources = workerData as RemotePrintResourceBytes[];
const assets = (import.meta.env.DEV
  ? join(__dirname, '../../src/renderer/public')
  : join(__dirname, '../renderer')).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
void inspectRemotePrintResources(resources, async () => {
  const directory = join(assets, 'wasm', 'threaded');
  const factory = await import(/* @vite-ignore */ pathToFileURL(join(directory, 'orca_slice.js')).href) as {
    default: (options: { noInitialRun: boolean; locateFile(path: string): string }) => Promise<OrcaModule>;
  };
  return factory.default({ noInitialRun: true, locateFile: path => join(directory, path) });
}).then(value => port.postMessage({ ok: true, value }),
  () => port.postMessage({ ok: false, error: 'Cannot inspect the device file metadata' }));
