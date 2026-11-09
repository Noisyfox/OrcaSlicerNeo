/** Current-task identity, timing and thumbnails from U1 file metadata. */
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import { MoonrakerHttp, record, fail } from '../moonraker-http';
import { gcodeMetadataEndpoint, gcodeThumbnailPath, readGcodeThumbnail } from './file-thumbnail';

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
    return this.http.get(this.printer, gcodeMetadataEndpoint(name), signal);
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
    const path = gcodeThumbnailPath(before.name, before.metadata);
    if (!path) fail('preview-unavailable', 'No current task preview is available.');
    const image = await readGcodeThumbnail(this.http, this.printer, path, signal);
    const after = await this.current(signal);
    if (before.taskId !== after?.taskId) fail('stale-context', 'The current task changed while reading its preview.');
    return { printerId: target.printerId, routeId: target.routeId, configurationRevision, taskId: before.taskId, ...image };
  }
}
