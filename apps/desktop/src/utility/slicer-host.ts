import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { collectTransferables } from '../../../../packages/slicer-wasm/src/client/transfer';

// Electron ports and Node worker ports are different APIs. Keep this event loop
// free even when the serial slicer occupies its Node Worker.
process.parentPort.once('message', (event) => {
  const port = event.ports[0];
  if (!port || event.data?.type !== 'connect') process.exit(1);
  const worker = new Worker(join(__dirname, 'slicer-worker.js'));
  worker.on('message', (message) => port.postMessage(message));
  worker.on('error', (error) => {
    port.postMessage({ type: 'fatal', error: error.message });
    process.exitCode = 1;
  });
  worker.on('exit', (code) => {
    port.postMessage({ type: 'fatal', error: `Slicer worker exited (${code})` });
  });
  // IPC already produced utility-owned input buffers. Move them to the Node
  // Worker instead of cloning a large project a second time inside the host.
  port.on('message', (message) => worker.postMessage(message.data, collectTransferables(message.data)));
  port.start();
});
