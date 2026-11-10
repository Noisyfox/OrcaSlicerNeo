import type { PrinterConfiguration } from '../configuration';
import type * as D from '../domain';
import { safe } from '../http-service';
import { endpoint, fail, MoonrakerFailure } from '../moonraker-http';
import { u1GcodeEndpoint, u1GcodeRef, u1StorageRouteDigest, u1TimelapseAssetEndpoint, u1TimelapsePrefix, u1TimelapseRef } from './file-reference';

export const u1DownloadChunkBytes = 1024 * 1024;

async function downloadSource(printer: Readonly<PrinterConfiguration>, file: D.RemoteFileRef) {
  if (printer.driverId !== 'snapmaker' || printer.id !== file.printerId || file.routeId !== `snapmaker:${printer.id}`)
    fail('invalid-target', 'File belongs to another printer route.');
  const video = file.fileId.startsWith(u1TimelapsePrefix) ? u1TimelapseRef(file) : null;
  const source = video ? { digest: video.digest, filename: video.video, path: u1TimelapseAssetEndpoint(video.video, 'video') } : (() => {
    const { digest, filename } = u1GcodeRef(file);
    return { digest, filename, path: u1GcodeEndpoint(filename) };
  })();
  if (source.digest !== await u1StorageRouteDigest(printer)) fail('stale-context', 'The printer configuration changed. Refresh Storage.');
  return { url: endpoint(printer.apiBaseUrl, source.path), name: source.filename.slice(source.filename.lastIndexOf('/') + 1) };
}

export function u1DownloadSource(printer: Readonly<PrinterConfiguration>, file: D.RemoteFileRef) {
  return safe(() => downloadSource(printer, file));
}

/** Complete-file streaming with backpressure. Never expose the configured URL or key to the sink. */
export function readU1Download(printer: Readonly<PrinterConfiguration>, request: Parameters<D.PrinterFiles['download']>[0],
  options?: D.ReadOptions): Promise<D.Result<D.DownloadedFile>> {
  return safe(async () => {
    if (request.range) fail('range-not-supported', 'U1 downloads require a complete file.');
    const { target } = request;
    const { url, name } = await downloadSource(printer, target);
    const timeout = new AbortController();
    const signal = options?.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
    const interrupted = () => new MoonrakerFailure(options?.signal?.aborted
      ? { code: 'cancelled', message: 'Download cancelled.' }
      : { code: 'transport', message: 'Printer download was interrupted.' });
    const timed = async <T>(read: () => Promise<T>): Promise<T> => {
      const timer = setTimeout(() => timeout.abort(), 15_000);
      try { return await read(); }
      catch { throw interrupted(); }
      finally { clearTimeout(timer); }
    };
    const response = await timed(() => fetch(url, { signal, redirect: 'error', cache: 'no-store',
      headers: printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {} }));
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (response.status !== 200 || !response.body || (encoding && !['identity', 'gzip', 'deflate', 'br', 'zstd'].includes(encoding))) {
      await response.body?.cancel().catch(() => undefined);
      fail(response.status === 401 ? 'authentication-required' : response.status === 403 ? 'permission-denied' :
        response.status === 404 ? 'file-not-found' : 'device-rejected', 'The printer did not return a complete file.');
    }
    // Fetch exposes decoded bytes. A compressed response's length describes the wire body.
    const length = !encoding || encoding === 'identity' ? response.headers.get('content-length') : null;
    const bytes = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
    const reader = response.body.getReader();
    let pending: Uint8Array | undefined, ended = false;
    const iterator: AsyncIterator<Uint8Array> = {
      async next() {
        if (ended) return { done: true, value: undefined };
        if (signal.aborted) throw interrupted();
        if (!pending?.length) {
          const next = await timed(() => reader.read());
          if (next.done) {
            ended = true;
            reader.releaseLock();
            return { done: true, value: undefined };
          }
          pending = next.value;
        }
        const chunk = pending.subarray(0, u1DownloadChunkBytes);
        pending = pending.subarray(chunk.length);
        return { done: false, value: chunk };
      },
      async return() {
        if (!ended) {
          ended = true;
          try { await reader.cancel(); }
          catch (error) { if (!signal.aborted) throw error; }
          finally { reader.releaseLock(); pending = undefined; }
        }
        return { done: true, value: undefined };
      },
    };
    return { file: { ...target }, suggestedFileName: name, mimeType: response.headers.get('content-type'), totalBytes: bytes,
      responseBytes: bytes, returnedRange: null, chunks: { [Symbol.asyncIterator]: () => iterator } };
  });
}
