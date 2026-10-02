import { createRuntimeBootstrap, type WorkerMessage, type WorkerTransport } from '@orca/slicer-runtime';

/** Connect directly to the utility host; main/preload only broker the port. */
export function createElectronRuntime() {
  let port: MessagePort | undefined;
  let failure: string | undefined;
  const listeners = new Set<(message: WorkerMessage) => void>();
  const queued: WorkerMessage[] = [];
  const receive = (message: WorkerMessage) => {
    for (const listener of listeners) listener(message);
  };
  const fail = (error: string) => {
    failure = error;
    queued.length = 0;
    receive({ type: 'fatal', error });
  };
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      fail('Slicer utility process connection timed out');
      reject(new Error(failure));
    }, 30_000);
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.channel === 'orca:slicer-failed') {
        clearTimeout(timeout);
        fail(String(event.data.error));
        reject(new Error(failure));
      }
      if (event.data?.channel !== 'orca:slicer-port' || port || failure) return;
      const received = event.ports[0];
      if (!received) return;
      port = received;
      port.onmessage = (message) => receive(message.data as WorkerMessage);
      port.onmessageerror = () => fail('Slicer utility process message could not be decoded');
      port.start();
      clearTimeout(timeout);
      for (const message of queued.splice(0)) port.postMessage(message);
      resolve();
    });
    window.orca.connectSlicerRuntime();
  });
  const transport: WorkerTransport = {
    post(message) {
      if (failure) throw new Error(failure);
      if (port) port.postMessage(message);
      else queued.push(message);
    },
    onMessage(listener) { listeners.add(listener); },
  };
  const runtime = createRuntimeBootstrap({ transport, initialize: () => connected });
  // The app observes init() for its startup error UI. Also observe the optional
  // lifecycle promise so a failed connection cannot become an unhandled rejection.
  void runtime.ready.catch(() => {});
  return runtime;
}
