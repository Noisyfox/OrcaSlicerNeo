/** Current-task identity, timing and thumbnails from U1 file metadata. */
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import { MoonrakerHttp, record, fail } from '../moonraker-http';

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function taskId(name: string, metadata: Record<string, unknown>): D.Id<'device-task'> | undefined {
  const start = finite(metadata.print_start_time), job = metadata.job_id;
  if (!start || start < 0 || typeof job !== 'string' || !job) return undefined;
  return `snapmaker-task:${JSON.stringify([name, job, start, metadata.uuid])}` as D.Id<'device-task'>;
}
function filename(status: Record<string, unknown>): string | undefined {
  const stats = record(status.print_stats);
  if (!['printing', 'paused', 'complete', 'cancelled', 'error'].includes(String(stats.state))) return undefined;
  return typeof stats.filename === 'string' && stats.filename ? stats.filename : undefined;
}

export class U1PrintTask {
  private file?: { name: string; active: boolean; duration: number | undefined; metadata?: Record<string, unknown> };
  constructor(private readonly http: MoonrakerHttp, private readonly printer: PrinterConfiguration) {}

  async observe(status: Record<string, unknown>, signal?: AbortSignal): Promise<{ remainingSeconds?: number; taskId?: D.Id<'device-task'> }> {
    const stats = record(status.print_stats), sd = record(status.virtual_sdcard);
    const name = filename(status), duration = finite(stats.total_duration);
    const active = stats.state === 'printing' || stats.state === 'paused';
    if (!name) { this.file = undefined; return stats.state === 'complete' ? { remainingSeconds: 0 } : {}; }
    if (!this.file || this.file.name !== name || active && !this.file.active ||
        duration !== undefined && this.file.duration !== undefined && duration < this.file.duration) {
      this.file = { name, duration, active };
    }
    const file = this.file;
    file.duration = duration;
    file.active = active;
    if (!file.metadata) {
      try { file.metadata = await this.metadata(name, signal); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    const metadata = file.metadata ?? {};
    const identity = taskId(name, metadata);
    if (stats.state === 'complete') return { taskId: identity, remainingSeconds: 0 };
    if (!active) return { taskId: identity };
    const position = finite(sd.file_position), start = finite(metadata.gcode_start_byte), end = finite(metadata.gcode_end_byte);
    const estimate = finite(metadata.estimated_time);
    if (start === undefined || end === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end <= start || estimate === undefined || estimate <= 0) {
      file.metadata = undefined;
      return { taskId: identity };
    }
    if (position === undefined || !Number.isSafeInteger(position) || position < start) return { taskId: identity };
    const progress = Math.min(1, (position - start) / (end - start));
    return { taskId: identity, remainingSeconds: Math.trunc(estimate * (1 - progress)) };
  }

  private metadata(name: string, signal?: AbortSignal) {
    return this.http.get(this.printer, `/server/files/metadata?filename=${encodeURIComponent(name)}`, signal);
  }

  async current(signal?: AbortSignal) {
    const response = await this.http.get(this.printer, '/printer/objects/query?print_stats', signal);
    const name = filename(record(response.status));
    if (!name) return undefined;
    const metadata = await this.metadata(name, signal);
    const identity = taskId(name, metadata);
    if (!identity) return undefined;
    return { name, metadata, taskId: identity };
  }

  async preview(target: D.TargetRequest, configurationRevision: D.Revision, signal?: AbortSignal): Promise<D.CurrentPrintPreview> {
    const before = await this.current(signal);
    if (!before) fail('preview-unavailable', 'No current task preview is available.');
    const thumbnails = Array.isArray(before.metadata.thumbnails) ? before.metadata.thumbnails.map(record) : [];
    const thumbnail = thumbnails.filter(item => typeof item.relative_path === 'string' &&
      finite(item.width) !== undefined && Number(item.width) > 0 && finite(item.height) !== undefined && Number(item.height) > 0)
      .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height))[0];
    if (!thumbnail) fail('preview-unavailable', 'No current task preview is available.');
    const path = [...before.name.split('/').slice(0, -1), String(thumbnail.relative_path)].join('/');
    // File paths stay within the configured printer's gcodes root, including behind a proxy.
    if (path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
        path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      fail('preview-unavailable', 'Invalid printer thumbnail path.');
    }
    const bytes = await this.http.getBytes(this.printer, `/server/files/gcodes/${path.split('/').map(encodeURIComponent).join('/')}`, signal);
    if (bytes.byteLength > 4 * 1024 * 1024) fail('out-of-range', 'Printer thumbnail is too large.');
    let mimeType: D.CurrentPrintPreview['mimeType'];
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) mimeType = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
    else fail('preview-unavailable', 'Invalid printer thumbnail.');
    const after = await this.current(signal);
    if (before.taskId !== after?.taskId) fail('stale-context', 'The current task changed while reading its preview.');
    return { printerId: target.printerId, routeId: target.routeId, configurationRevision, taskId: before.taskId, mimeType, bytes };
  }
}
