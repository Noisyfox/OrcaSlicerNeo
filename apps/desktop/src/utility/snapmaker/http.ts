import type { PrinterTransport } from '@orca/printer-control';

/** Camera HTTP requests execute in the utility process. */
export const cameraHttpTransport: PrinterTransport = {
  async request(request) {
    if (request.method !== 'GET') throw new Error('Camera request rejected.');
    const response = await fetch(request.url, { method: 'GET', headers: request.headers, signal: request.signal, redirect: 'error', cache: 'no-store' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes: async () => bytes, json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  },
};
