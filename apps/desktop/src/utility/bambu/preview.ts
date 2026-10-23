import type { BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuMonitor } from './monitor';
import { number, record, records } from './telemetry';
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
/** Only provider-owned CDN URLs are fetched, with no caller URLs, cookies or auth headers. */
function previewUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['bambulab.com', 'bambulab.cn', 'bb-cloud.com', 'bb-cloud.cn'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url : null;
  } catch { return null; }
}
/** Resolve the current task independently. No file-list, history, camera or active UI watch is needed. */
export async function readCurrentPrintPreview(monitor: Pick<BambuMonitor, 'acquire' | 'context' | 'stop'>, native: Pick<BambuNative, 'getSubtaskInfo'>,
  target: D.TargetRequest, fetchImage: typeof fetch = fetch): Promise<D.Result<D.CurrentPrintPreview>> {
  const lease = await monitor.acquire(target); if (!lease.ok) return lease;
  try {
    const before = await monitor.context(target); if (!before.ok) return before;
    const context = before.value, task = context.values.status.printStatus.taskId;
    if (!context.fresh) return failure('offline', 'Wait for fresh printer status.');
    if (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== context.configurationRevision) return failure('stale-context', 'Printer configuration changed.');
    if (task.kind !== 'known' || !task.value) return failure('preview-unavailable', 'No current task preview is available.');
    let url = previewUrl(context.report.thumbnail_url);
    if (!url) {
      const response = await native.getSubtaskInfo(task.value);
      if (response.result !== 0 || response.httpCode !== 200 || response.body.length > 2 * 1024 * 1024) return failure('preview-unavailable', 'No current task preview is available.');
      const metadata = record(JSON.parse(response.body));
      const content = typeof metadata.content === 'string' ? record(JSON.parse(metadata.content)) : record(metadata.content);
      const plate = number(record(content.info).plate_idx) ?? number(context.report.plate_idx);
      // A multi-plate job must never display an arbitrarily selected plate.
      url = previewUrl(record(records(record(metadata.context).plates).find(value => number(value.index) === plate)?.thumbnail).url);
    }
    if (!url) return failure('preview-unavailable', 'No current task preview is available.');
    const response = await fetchImage(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10_000) });
    const mimeType = response.headers.get('content-type')?.split(';')[0];
    if (!response.ok || !response.body || mimeType !== 'image/png' && mimeType !== 'image/jpeg') return failure('preview-unavailable', 'The current task preview is unavailable.');
    const limit = 4 * 1024 * 1024, chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > limit) return failure('out-of-range', 'The current task preview is too large.');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const bytes = Buffer.concat(chunks, size);
    const valid = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid) return failure('preview-unavailable', 'The current task preview is unavailable.');
    const after = await monitor.context(target);
    if (!after.ok || !after.value.fresh || after.value.configurationRevision !== context.configurationRevision
      || after.value.values.status.printStatus.taskId.kind !== 'known' || after.value.values.status.printStatus.taskId.value !== task.value) return failure('stale-context', 'The active task changed while loading its preview.');
    return { ok: true, value: { printerId: target.printerId, routeId: target.routeId, configurationRevision: context.configurationRevision, taskId: task.value, mimeType, bytes: new Uint8Array(bytes) } };
  } catch { return failure('transport', 'The current task preview could not be loaded.'); }
  finally { await monitor.stop(lease.value).catch(() => undefined); }
}
