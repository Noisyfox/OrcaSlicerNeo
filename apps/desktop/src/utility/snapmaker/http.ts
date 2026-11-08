import type { PrinterTransport } from '@orca/printer-control';

/** Bounded streaming reads execute only in the camera utility process. */
export const cameraHttpTransport: PrinterTransport = {
  async request(request) {
    const limit = request.maxResponseBytes ?? 64 * 1024;
    if (request.method !== 'GET' || !Number.isSafeInteger(limit) || limit <= 0 || limit > 16 * 1024 * 1024) throw new Error('Camera request rejected.');
    const response = await fetch(request.url, { method: 'GET', headers: request.headers, signal: request.signal, redirect: 'error', cache: 'no-store' });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const length = Number(response.headers.get('content-length'));
      if (length > limit) throw new Error('Camera response exceeded its size limit.');
      if (reader) while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error('Camera response exceeded its size limit.');
        chunks.push(next.value);
      }
    } catch (error) { await reader?.cancel().catch(() => undefined); throw error; }
    finally { reader?.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, bytes: async () => bytes, json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  },
};
