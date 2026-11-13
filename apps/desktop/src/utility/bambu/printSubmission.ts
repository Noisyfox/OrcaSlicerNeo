import type { BambuDeviceContext } from './controlContext';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { BambuNative, NativeEvent } from '@orca/bambu-native';
import type * as D from '@orca/platform-contract';
import type { BambuSubmissionInputs } from '../../shared/bambuSubmission';
import type { BambuDeviceAccess } from './deviceAccess';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import { record, text } from './protocol';
import { prepareBambuPrint } from './printValidation';
import { printParameters } from './printParameters';
import { printerPrintProfile } from './printResources';
type File = { descriptor: D.PrintArtifactDescriptor; path: string; handle: FileHandle; offset: number };
type Job = { request: D.PrintSubmissionRequest; signature: string; state: D.PrintSubmissionState; files: Map<string, File>; directory: string; token: string; name: { display: string; remote: string }; nativeDone: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null };
const error = (message: string, code: D.ErrorCode = 'precondition-failed') => ({ ok: false as const, error: { code, message } });
const cancelling = (job: Job) => job.state.phase === 'cancelling';
const final = (phase: D.PrintSubmissionState['phase']) => ['sent', 'failed', 'cancelled', 'unknown'].includes(phase);
export class BambuPrintSubmissions {
  private jobs = new Map<string, Job>();
  private queue: Promise<unknown> = Promise.resolve();
  private active: Job | null = null;
  private remoteActive = false;
  private remoteJobs = new Set<Promise<unknown>>();
  private closed = false;
  private sequence = 800000;
  private queries = new Map<string, { deviceId: string; resolve(value: Record<string, unknown> | null): void }>();
  constructor(private readonly native: BambuNative, private readonly access: BambuDeviceAccess,
    private readonly devices: Pick<BambuDevices, 'list'>, private readonly repository: Pick<BambuRepository, 'read'>,
    private readonly directory: string, private readonly changed: () => void) {}
  private serialize<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn); this.queue = next.catch(() => undefined); return next; }
  private async delivery(target: D.PrinterTarget, context: BambuDeviceContext, allowAbnormal = false) {
    const device = (await this.devices.list()).find(d => `bambu:${encodeURIComponent(d.deviceId)}` === target.printerId);
    const lan = device && (await this.repository.read()).lan.find(l => l.deviceId === device.deviceId && device.routes.some(r => r.channel === 'lan' && r.revision === l.revision));
    const cloud = !!device?.routes.some(r => r.channel === 'cloud');
    const storage = context.machine.storage;
    const defaults = record(printerPrintProfile(context.model, context.values.firmware.find(f => f.name === 'ota')?.version).print);
    const reported = context.report.support_cloud_print_only, capability = record(record(context.report.capabilities).flags).support_cloud_print_only;
    const cloudOnly = typeof capability === 'boolean' ? capability : typeof reported === 'boolean' ? reported : defaults.support_cloud_print_only === true;
    const qualifiedLan = lan && !cloudOnly && (storage === 'normal' || storage === 'abnormal' && allowAbnormal);
    return { device, lan, cloud, route: qualifiedLan || lan && !cloud ? 'lan' as const : cloud ? 'cloud' as const : null };
  }
  async prepare(request: D.PrintPreparationRequest): Promise<D.Result<D.PrintPreparation>> {
    const context = await this.access.context(request.target);
    if (!context.ok) return context;
    const delivery = await this.delivery(request.target, context.value, request.allowAbnormalStorage);
    const value = prepareBambuPrint(request, context.value, delivery.route);
    if (this.remoteActive || this.active && !final(this.active.state.phase)) value.issues = [...value.issues, { id: 'submission-busy', severity: 'block', message: 'Another print submission is still active.' }];
    if (request.checkRecording && value.options.timelapse && context.value.machine.internalRecording && !value.issues.some(i => i.severity === 'block')) {
      const token = await this.access.acquire(request.target);
      if (!token.ok) return token;
      try { value.recordingSpace = await this.recording(request.target, value.options.timelapseStorage ?? 'internal', request.requirements.layerCount); }
      finally { await this.access.stop(token.value); }
      if (value.recordingSpace.status === 'unknown') value.issues = [...value.issues, { id: 'recording-space-unknown', severity: 'notice', message: 'Recording space could not be checked. The timelapse might not be saved.' }];
    }
    return { ok: true, value };
  }
  private async recording(target: D.PrinterTarget, storage: string, layers: number): Promise<NonNullable<D.PrintPreparation['recordingSpace']>> {
    const sequence = String(++this.sequence), deviceId = decodeURIComponent(target.printerId.slice(6));
    const response = new Promise<Record<string, unknown> | null>(resolve => {
      const timer = setTimeout(() => { this.queries.delete(sequence); resolve(null); }, 5000);
      this.queries.set(sequence, { deviceId, resolve: value => { clearTimeout(timer); this.queries.delete(sequence); resolve(value); } });
    });
    const sent = await this.access.dispatch(target, async (_c, send) => {
      const code = await send('camera', { sequence_id: sequence, command: 'ipcam_get_media_info', sub_command: 'is_timelapse_storage_enough', storage, total_layer: layers }, 1);
      return code === 0 ? { ok: true as const, value: null } : error('Recording space request failed');
    }).catch(() => error('Recording space request failed'));
    if (!sent.ok) this.queries.get(sequence)?.resolve(null);
    const value = await response;
    return !value || value.result !== 0 ? { status: 'unknown', canClean: false }
      : { status: value.is_enough === false ? 'insufficient' : 'enough', canClean: storage === 'internal' || typeof value.file_count === 'number' && value.file_count >= 0 };
  }
  begin(input: BambuSubmissionInputs['print.begin']): Promise<D.Result<{ ref: D.PrintSubmissionRef; created: boolean }>> {
    return this.serialize(async () => {
      const signature = JSON.stringify(input), r = input.request;
      const previous = [...this.jobs.values()].find(j => j.request.requestId === r.requestId && j.state.ref.printerId === r.target.printerId && j.state.ref.routeId === r.target.routeId);
      if (previous) return previous.signature === signature ? { ok: true, value: { ref: previous.state.ref, created: false } } : error('Request ID was already used for different print content.', 'invalid-request');
      if (this.closed || this.active || this.remoteActive) return error('Another print submission is active or the application is closing.', 'busy');
      const token = await this.access.acquire(r.target); if (!token.ok) return token;
      let directory: string | null = null;
      const files = new Map<string, File>();
      try {
        const context = await this.access.context(r.target); if (!context.ok) return context;
        const delivery = await this.delivery(r.target, context.value, r.allowAbnormalStorage);
        const prepared = prepareBambuPrint({ ...r, suggest: false }, context.value, delivery.route);
        const issue = prepared.issues.find(i => i.severity === 'block' || i.severity === 'warning' && !r.acknowledgedIssues.includes(i.id));
        if (issue) return error(issue.message);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(this.directory, 'print-'));
        for (const descriptor of input.artifacts) {
          const path = join(directory, `${descriptor.role}.3mf`);
          files.set(descriptor.role, { descriptor, path, handle: await open(path, 'wx', 0o600), offset: 0 });
        }
        const id = randomUUID() as D.Id<'print-submission'>;
        const ref = { printerId: r.target.printerId, routeId: r.target.routeId, id };
        const job: Job = { request: structuredClone(r), signature, directory, files, token: token.value,
          name: { display: r.jobName, remote: `Neo_${id.replaceAll('-', '')}` }, nativeDone: null, timer: null,
          state: { ref, requestId: r.requestId, phase: 'staging', route: delivery.route, progress: 0, message: 'Preparing print artifacts', canCancel: true } };
        this.jobs.set(id, job); this.active = job;
        job.timer = setTimeout(() => { void this.serialize(async () => { if (job.state.phase === 'staging') await this.finish(job, 'cancelled', 'Artifact transfer expired before sending.'); }); }, 120000);
        this.changed();
        return { ok: true, value: { ref, created: true } };
      } catch { return error('Print artifacts could not be prepared.', 'transport'); }
      finally { if (this.active?.token !== token.value) { await Promise.allSettled([...files.values()].map(f => f.handle.close())); if (directory) await rm(directory, { recursive: true, force: true }); await this.access.stop(token.value); } }
    });
  }
  private job(ref: D.PrintSubmissionRef) { const job = this.jobs.get(ref.id); return job?.state.ref.printerId === ref.printerId && job.state.ref.routeId === ref.routeId ? job : undefined; }
  get(ref: D.PrintSubmissionRef): D.Result<D.PrintSubmissionState> { const job = this.job(ref); return job ? { ok: true, value: structuredClone(job.state) } : error('Print submission outcome is unavailable.', 'invalid-target'); }
  chunk(input: BambuSubmissionInputs['print.chunk']): Promise<D.Result<null>> { return this.serialize(async () => {
    const job = this.job(input.ref), file = job?.files.get(input.role);
    if (!job || job.state.phase !== 'staging' || !file || file.offset !== input.offset || file.offset + input.bytes.byteLength > file.descriptor.sizeBytes) return error('Invalid artifact chunk.', 'invalid-request');
    try {
      let written = 0;
      while (written < input.bytes.length) { const result = await file.handle.write(input.bytes, written, input.bytes.length - written, file.offset + written); if (!result.bytesWritten) throw new Error('No write progress'); written += result.bytesWritten; }
      file.offset += written; job.state.progress = [...job.files.values()].reduce((n, f) => n + f.offset, 0) / [...job.files.values()].reduce((n, f) => n + f.descriptor.sizeBytes, 0);
      this.changed(); return { ok: true, value: null };
    } catch { await this.finish(job, 'failed', 'Artifact transfer failed.'); return error('Artifact transfer failed.', 'transport'); }
  }); }
  commit(ref: D.PrintSubmissionRef): Promise<D.Result<D.PrintSubmissionState>> { return this.serialize(async () => {
    const job = this.job(ref); if (!job) return error('Unknown submission.', 'invalid-target');
    if (job.state.phase !== 'staging') return this.get(ref);
    if ([...job.files.values()].some(f => f.offset !== f.descriptor.sizeBytes)) return error('Artifact transfer is incomplete.');
    try {
      await Promise.all([...job.files.values()].map(f => f.handle.close()));
      if (job.timer) clearTimeout(job.timer);
      job.state = { ...job.state, phase: 'sending', progress: null, message: 'Sending print', canCancel: true }; this.changed();
      job.nativeDone = this.send(job);
      return this.get(ref);
    } catch { await this.finish(job, 'failed', 'Print preparation failed.'); return this.get(ref); }
  }); }
  private async send(job: Job) {
    let nativeInvoked = false;
    try {
      const context = await this.access.context(job.state.ref); if (!context.ok) throw new Error('Printer unavailable');
      const delivery = await this.delivery(job.state.ref, context.value, job.request.allowAbnormalStorage);
      const prepared = prepareBambuPrint({ ...job.request, suggest: false }, context.value, delivery.route);
      const issue = prepared.issues.find(i => i.severity === 'block' || i.severity === 'warning' && !job.request.acknowledgedIssues.includes(i.id));
      if (issue) { await this.finish(job, 'failed', issue.message); return; }
      if (this.closed || cancelling(job)) { await this.finish(job, 'cancelled', 'Sending cancelled.'); return; }
      if (job.request.recordingSpaceAction === 'disable-timelapse') prepared.options.timelapse = false;
      if (prepared.options.timelapse && context.value.machine.internalRecording && job.request.recordingSpaceAction === 'clean-oldest') {
        const storage = prepared.options.timelapseStorage ?? 'internal';
        const cleanup = await this.access.dispatch(job.state.ref, async (_c, send) => {
          if (this.closed || cancelling(job)) return error('Sending cancelled.', 'cancelled');
          return await send('camera', { command: 'ipcam_delete_oldest_timelapse', sequence_id: String(++this.sequence), storage, total_layer: job.request.requirements.layerCount }, 1) === 0 ? { ok: true, value: null } : error('Recording cleanup failed.');
        });
        if (!cleanup.ok) { await this.finish(job, cleanup.error.code === 'cancelled' ? 'cancelled' : 'failed', cleanup.error.message); return; }
      }
      if (this.closed || cancelling(job)) { await this.finish(job, 'cancelled', 'Sending cancelled.'); return; }
      // Like Orca's PrintJob, retain this send's prepared state and connection data.
      const options = printParameters(job.request, prepared, job.name, context.value.machine);
      const run = async (route: 'lan' | 'cloud') => {
        job.state.route = route; this.changed();
        const lan = delivery.lan;
        let connected = true;
        if (route === 'lan' && lan) {
          await this.native.installDeviceCertificate(delivery.device!.deviceId, !delivery.cloud);
          connected = await this.native.connectPrinter(lan.deviceId, lan.ip, 'bblp', lan.accessCode, true) === 0;
        }
        if (this.closed || cancelling(job)) return { code: -18, mayHaveStarted: false, cancelRequested: true };
        if (!connected) return { code: -6010, mayHaveStarted: false, cancelRequested: false };
        nativeInvoked = true;
        return this.native.startPrint(route, { ...options, dev_id: delivery.device!.deviceId, filename: job.files.get('print')!.path, config_filename: job.files.get('configuration')!.path,
          plate_index: 1, connection_type: route, dev_name: delivery.device!.name, dev_ip: route === 'lan' ? lan?.ip ?? '' : '', username: 'bblp', password: route === 'lan' ? lan?.accessCode ?? '' : '', use_ssl_for_ftp: true, use_ssl_for_mqtt: true });
      };
      let result = await run(delivery.route!);
      if (result.code < 0 && result.code !== -1 && !result.mayHaveStarted && !result.cancelRequested && !this.closed && !cancelling(job) && job.state.route === 'lan' && delivery.cloud) result = await run('cloud');
      // Like Orca, a successful plugin return completes sending; Device owns physical print progress.
      if (result.code >= 0) await this.finish(job, 'sent', 'Print job sent.');
      else if (result.mayHaveStarted) await this.finish(job, 'unknown', 'Start outcome is unknown. Check the printer; do not send a duplicate.');
      else await this.finish(job, result.cancelRequested || result.code === -18 ? 'cancelled' : 'failed', result.cancelRequested ? 'Sending cancelled.' : 'Sending failed. You can retry.');
    } catch { if (!nativeInvoked) { await this.finish(job, cancelling(job) ? 'cancelled' : 'failed', 'Sending did not start. You can retry.'); return; } if (!final(job.state.phase)) await this.finish(job, 'unknown', 'The sending outcome is unknown. Check the printer.'); }
  }
  /** Existing device files use the plugin's SD-card entrypoint. They never
   * export, stage or upload an artifact. Admission is shared with local sends. */
  sendDeviceFile(request: D.PrintSubmissionRequest, file: { path: string; name: string; plateIndex: number }): Promise<D.Result<'sent' | 'unknown'>> {
    const work = this.sendRemote(request, file);
    this.remoteJobs.add(work);
    void work.finally(() => this.remoteJobs.delete(work)).catch(() => {});
    return work;
  }
  private async sendRemote(request: D.PrintSubmissionRequest, file: { path: string; name: string; plateIndex: number }): Promise<D.Result<'sent' | 'unknown'>> {
    const admitted = await this.serialize(async () => {
      if (this.closed || this.active || this.remoteActive) return false;
      this.remoteActive = true; return true;
    });
    if (!admitted) return error('Another print submission is active or the application is closing.', 'busy');
    let token: string | null = null, invoked = false;
    try {
      const lease = await this.access.acquire(request.target); if (!lease.ok) return lease;
      token = lease.value;
      const context = await this.access.context(request.target); if (!context.ok) return context;
      if (context.value.configurationRevision !== request.target.expectedConfigurationRevision) return error('The printer configuration changed.', 'stale-context');
      const delivery = await this.delivery(request.target, context.value, request.allowAbnormalStorage);
      const prepared = prepareBambuPrint({ ...request, suggest: false }, context.value, delivery.route);
      const issue = prepared.issues.find(i => i.severity === 'block' || i.severity === 'warning' && !request.acknowledgedIssues.includes(i.id));
      if (issue) return error(issue.message);
      if (!delivery.device || !delivery.route) return error('The printer route is unavailable.', 'transport');
      const lan = delivery.lan;
      if (delivery.route === 'lan' && lan) {
        await this.native.installDeviceCertificate(delivery.device.deviceId, !delivery.cloud);
        if (await this.native.connectPrinter(lan.deviceId, lan.ip, 'bblp', lan.accessCode, true) !== 0) return error('The printer connection failed.', 'transport');
      }
      if (this.closed) return error('The application is closing.', 'cancelled');
      const current = await this.access.context(request.target); if (!current.ok) return current;
      if (current.value.configurationRevision !== request.target.expectedConfigurationRevision) return error('The printer configuration changed.', 'stale-context');
      const finalPreparation = prepareBambuPrint({ ...request, suggest: false }, current.value, delivery.route);
      const finalIssue = finalPreparation.issues.find(i => i.severity === 'block' || i.severity === 'warning' && !request.acknowledgedIssues.includes(i.id));
      if (finalIssue) return error(finalIssue.message);
      const params = printParameters(request, finalPreparation, { display: file.name, remote: file.name }, current.value.machine);
      if (this.closed) return error('The application is closing.', 'cancelled');
      invoked = true;
      const result = await this.native.startPrint('device-file', { ...params, dev_id: delivery.device.deviceId, dev_name: delivery.device.name,
        filename: '', config_filename: '', ftp_file: '', project_name: file.name, dst_file: file.path,
        plate_index: file.plateIndex + 1, print_type: 'from_sdcard_view', connection_type: delivery.route,
        dev_ip: lan?.ip ?? '', username: 'bblp', password: lan?.accessCode ?? '', use_ssl_for_ftp: true, use_ssl_for_mqtt: true });
      return result.code >= 0 ? { ok: true, value: 'sent' } : result.mayHaveStarted ? { ok: true, value: 'unknown' }
        : error('The printer did not accept the device-file print request.', result.cancelRequested ? 'cancelled' : 'device-rejected');
    } catch { return invoked ? { ok: true, value: 'unknown' } : error('Device-file printing could not be prepared.', 'transport'); }
    finally { this.remoteActive = false; if (token) await this.access.stop(token).catch(() => {}); this.changed(); }
  }
  async cancel(ref: D.PrintSubmissionRef): Promise<D.Result<D.PrintSubmissionState>> {
    const job = this.job(ref); if (!job) return error('Unknown submission.', 'invalid-target');
    if (job.state.phase === 'staging') return this.serialize(async () => { if (job.state.phase === 'staging') await this.finish(job, 'cancelled', 'Sending cancelled.'); return this.get(ref); });
    if (job.state.canCancel) { job.state.phase = 'cancelling'; job.state.message = 'Cancelling sending…'; job.state.canCancel = false; this.native.cancelPrint(); this.changed(); }
    return this.get(ref);
  }
  private async finish(job: Job, phase: 'failed' | 'cancelled' | 'sent' | 'unknown', message: string) {
    if (job.timer) clearTimeout(job.timer);
    job.state.canCancel = false;
    // Sending completes only after the native call has stopped reading these files.
    await this.release(job);
    job.state = { ...job.state, phase, message, canCancel: false, progress: phase === 'unknown' ? null : job.state.progress }; this.changed();
  }
  private async release(job: Job) {
    await Promise.allSettled([...job.files.values()].map(f => f.handle.close()));
    await rm(job.directory, { recursive: true, force: true });
    if (this.active === job) this.active = null;
    await this.access.stop(job.token).catch(() => undefined);
  }
  async onEvent(event: NativeEvent) {
    const job = this.active;
    if (event.type === 'print-progress' && job && !final(job.state.phase)) {
      if (event.args[2]) { job.state.canCancel = false; if (this.closed || cancelling(job)) { job.state.phase = 'sending'; job.state.message = 'Finishing print submission…'; } }
      if (event.args[0] === 1 && event.args[1] >= 0 && event.args[1] <= 100) job.state.progress = event.args[1] / 100;
      this.changed(); return;
    }
    if (event.type !== 'message' && event.type !== 'local-message') return;
    let root; try { root = record(JSON.parse(event.args[1])); } catch { return; }
    const camera = record(root.camera), query = this.queries.get(String(camera.sequence_id));
    if (query?.deviceId === event.args[0] && camera.command === 'ipcam_get_media_info' && camera.sub_command === 'is_timelapse_storage_enough') query.resolve(camera);
  }
  async close() { this.closed = true;
    if (this.active && !final(this.active.state.phase)) { this.active.state.phase = 'cancelling'; this.active.state.canCancel = false; }
    if (this.active || this.remoteActive) this.native.cancelPrint();
    await this.queue;
    for (const query of this.queries.values()) query.resolve(null); await Promise.allSettled([...this.remoteJobs]); for (const job of this.jobs.values()) { if (job.timer) clearTimeout(job.timer); await job.nativeDone; await this.release(job); } }
}
