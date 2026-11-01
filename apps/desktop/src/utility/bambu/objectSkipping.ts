import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { SaxesParser } from 'saxes';
import { BambuResourceError, readBambuProjectResource, type BambuNative } from '@orca/bambu-native';
import type * as D from '@orca/printer-control/domain';
import type { BambuHostConfig } from '../../shared/bambu';
import type { BambuDevices } from './devices';
import type { BambuRepository } from './repository';
import type { BambuMonitor } from './monitor';
import type { CommandContext, PreparedCommand } from './commands';
import { id, number, record, unknown, type TelemetryProjection } from './telemetry';

const value = <T>(reading: D.Reading<T>) => reading.kind === 'known' ? reading.value : undefined;
const failure = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
const blocked = (code: D.ErrorCode, message: string): D.Availability => ({ kind: 'blocked', reasons: [{ code, message }] });
function taskKey(context: TelemetryProjection): string | null {
  const task = value(context.values.status.printStatus.taskId);
  if (!task) return null;
  return JSON.stringify([task, context.machine.jobId, number(context.report.plate_idx) ?? 1,
    typeof context.report.gcode_file === 'string' ? context.report.gcode_file : null]);
}
function sameTarget(a: D.PrinterTarget, b: D.PrinterTarget) { return a.printerId === b.printerId && a.routeId === b.routeId; }
function sameReference(a: D.PrintObjectContextRef, b: D.PrintObjectContextRef) {
  return sameTarget(a, b) && a.configurationRevision === b.configurationRevision && a.taskId === b.taskId && a.token === b.token;
}
interface Catalogue {
  key: string; fingerprint: string; plate: number; labelled: boolean; invalid: boolean; imageFailed: boolean;
  contextRef: D.PrintObjectContextRef; objects: D.PrintObjectSnapshot['objects']; labels: Map<D.Id<'print-object'>, number>; image?: Uint8Array;
}
export interface BambuObjectContext { snapshot: D.PrintObjectSnapshot; labels: ReadonlyMap<D.Id<'print-object'>, number> }
interface ReadJob { target: D.PrinterTarget; key: string | null; revision?: string; controller: AbortController; done: Promise<void>; finish: () => void }

function catalogue(bytes: Uint8Array, plateIndex: number): { labelled: boolean; labels: number[]; names: string[] } {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Invalid object metadata');
  const parser = new SaxesParser(), stack: string[] = [];
  type ParsedPlate = { index?: number; labelled: boolean; labels: number[]; names: string[] };
  let current: ParsedPlate | null = null;
  let selected: ParsedPlate | null = null;
  parser.on('doctype', () => { throw new Error('Invalid object metadata'); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1); stack.push(tag.name);
    if (stack.length > 64) throw new Error('Invalid object metadata');
    if (tag.name === 'plate') {
      if (current) throw new Error('Invalid object metadata');
      current = { labelled: false, labels: [], names: [] };
    } else if (current && parent === 'plate' && tag.name === 'metadata') {
      if (tag.attributes.key === 'index') {
        if (current.index !== undefined || !/^\d+$/.test(tag.attributes.value ?? '')) throw new Error('Invalid object metadata');
        current.index = Number(tag.attributes.value);
      }
      if (tag.attributes.key === 'label_object_enabled') current.labelled = tag.attributes.value === 'true';
    } else if (current && parent === 'plate' && tag.name === 'object') {
      const label = tag.attributes.identify_id, name = tag.attributes.name;
      if (!/^\d+$/.test(label ?? '') || !Number.isSafeInteger(Number(label)) || Number(label) <= 0
        || typeof name !== 'string' || !name || name.length > 4096 || current.labels.length >= 4096 || current.labels.includes(Number(label))) throw new Error('Invalid object metadata');
      current.labels.push(Number(label)); current.names.push(name);
    }
  });
  parser.on('closetag', tag => {
    if (tag.name === 'plate' && current) {
      if (current.index === plateIndex) { if (selected) throw new Error('Invalid object metadata'); selected = current; }
      current = null;
    }
    stack.pop();
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
  if (!selected) throw new Error('Current plate object metadata is absent');
  return selected;
}

/** Owns one current catalogue/map; command admission only uses its validated references. */
export class BambuObjectSkipping {
  private entry: Catalogue | null = null;
  private readonly reads = new Map<string, ReadJob>();
  private readonly cancelled = new Set<string>();
  private closed = false;
  constructor(private readonly config: BambuHostConfig, private readonly native: Pick<BambuNative, 'getCameraUrl' | 'getVersion' | 'installDeviceCertificate'>,
    private readonly monitor: Pick<BambuMonitor, 'acquire' | 'context' | 'stop'>, private readonly devices: Pick<BambuDevices, 'list'>,
    private readonly repository: Pick<BambuRepository, 'read'>, private readonly changed: () => void,
    private readonly readResource: typeof readBambuProjectResource = readBambuProjectResource) {}

  project(context: CommandContext): BambuObjectContext | undefined {
    const key = taskKey(context), phase = value(context.values.status.printStatus.phase);
    for (const job of this.reads.values()) if (sameTarget(job.target, context.target) && job.key !== null
      && (!context.fresh || job.key !== key || job.revision !== context.configurationRevision)) job.controller.abort();
    const entry = this.entry;
    if (!entry || !sameTarget(entry.contextRef, context.target)) return;
    if (entry.key !== key || entry.contextRef.configurationRevision !== context.configurationRevision || ['idle', 'completed', 'cancelled', 'failed'].includes(phase ?? '')) entry.invalid = true;
    if (entry.invalid) return;
    const raw = context.report.s_obj;
    const reported = Array.isArray(raw) && raw.length <= 4096 && raw.every(n => Number.isSafeInteger(n) && n > 0);
    const skipped = reported ? [...entry.labels].filter(([, label]) => raw.includes(label)).map(([objectId]) => objectId) : undefined;
    const allKnown = reported && raw.every(label => [...entry.labels.values()].includes(label));
    const template = context.values.status.printStatus.phase;
    const skippedObjectIds: D.PrintObjectSnapshot['skippedObjectIds'] = allKnown && template.kind === 'known'
      ? { ...template, value: skipped!, freshness: context.fresh ? 'fresh' : 'stale' } : unknown;
    let availability: D.Availability = { kind: 'available' };
    if (!context.fresh) availability = blocked('offline', 'Wait for fresh printer status.');
    else if (!['printing', 'paused'].includes(phase ?? '') || context.report.print_type === 'system' || context.machine.localControlOnly)
      availability = blocked('precondition-failed', 'Object skipping is unavailable for this task.');
    else if (!entry.labelled) availability = blocked('precondition-failed', 'This print was not sliced with object skipping enabled.');
    else if (!entry.objects.length) availability = blocked('precondition-failed', 'This task has no skippable objects.');
    else if (entry.objects.length > 64) availability = blocked('out-of-range', 'Object skipping supports up to 64 objects per plate.');
    else if (!allKnown) availability = blocked('precondition-failed', 'Wait for the current task object state, or reload its object information.');
    else if (skipped!.length === entry.objects.length) availability = blocked('precondition-failed', 'All objects have already been skipped.');
    const canMap = !entry.imageFailed && [...entry.labels.values()].every(label => label <= 0xffffff);
    return { labels: entry.labels, snapshot: { contextRef: { ...entry.contextRef }, objects: entry.objects.map(o => ({ ...o })), skippedObjectIds, availability,
      pickingImage: canMap ? { kind: 'supported', constraints: { mimeType: 'image/png' } } : { kind: 'unsupported', layer: 'route', reason: 'The graphical object view is unavailable. Use the object list.' } } };
  }

  cancel(readId: string) {
    this.reads.get(readId)?.controller.abort(); this.cancelled.add(readId);
    while (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
  }
  private async source(context: CommandContext) {
    const device = (await this.devices.list()).find(d => `bambu:${encodeURIComponent(d.deviceId)}` === context.target.printerId);
    if (!device) throw new Error('Unavailable device');
    const settings = await this.repository.read(), route = device.routes.find(r => r.channel === 'lan');
    const lan = settings.lan.find(r => r.deviceId === device.deviceId && r.revision === route?.revision);
    const cloud = device.routes.some(r => r.channel === 'cloud');
    if (!lan && !cloud) throw new Error('Unavailable access');
    let localUrl: string | null = null;
    if (lan) {
      try { await this.native.installDeviceCertificate(device.deviceId, true); localUrl = `bambu:///local/${lan.ip}?port=6000&user=bblp&passwd=${encodeURIComponent(lan.accessCode)}`; }
      catch { if (!cloud) throw new Error('Unavailable local certificate'); }
    }
    const firmware = context.values.firmware.find(f => f.name === 'ota')?.version ?? '';
    return {
      localUrl,
      remoteUrl: cloud ? async () => {
        await this.native.installDeviceCertificate(device.deviceId, false);
        const url = await this.native.getCameraUrl(`${device.deviceId}|${firmware}|"tutk","agora"`);
        if (!url.startsWith('bambu:///')) throw new Error('Unavailable remote access');
        const query = new URLSearchParams({ device: device.deviceId, net_ver: await this.native.getVersion(), dev_ver: firmware, cli_id: settings.clientId, cli_ver: '2.5.0-dev' });
        return `${url}${url.includes('?') ? '&' : '?'}${query}`;
      } : null,
    };
  }
  private async withRead<T>(target: D.PrinterTarget, readId: string, work: (context: CommandContext, signal: AbortSignal) => Promise<T>): Promise<D.Result<{ context: CommandContext; data: T }>> {
    if (this.closed || this.cancelled.has(readId)) return failure('cancelled', 'Object information reading was cancelled.');
    if (this.reads.has(readId)) return failure('invalid-request', 'This read ID is already in use.');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job: ReadJob = { target, key: null, controller: new AbortController(), done, finish }; this.reads.set(readId, job);
    let token: string | undefined;
    try {
      const lease = await this.monitor.acquire(target); if (!lease.ok) return lease; token = lease.value;
      const before = await this.monitor.context(target); if (!before.ok) return before;
      const context = before.value, key = taskKey(context);
      if (!context.fresh) return failure('offline', 'Wait for fresh printer status.');
      if (!context.machine.partSkipping) return failure('unsupported', 'This device has not reported object-skipping support.');
      if (!key) return failure('precondition-failed', 'The current task cannot be reliably identified.');
      if (!['printing', 'paused'].includes(value(context.values.status.printStatus.phase) ?? '') || context.report.print_type === 'system' || context.machine.localControlOnly)
        return failure('precondition-failed', 'Object skipping is unavailable for this task.');
      job.key = key; job.revision = context.configurationRevision;
      if (job.controller.signal.aborted) return failure('cancelled', 'Object information reading was cancelled.');
      const data = await work(context, job.controller.signal);
      const after = await this.monitor.context(target); if (!after.ok) return after;
      if (!after.value.fresh || taskKey(after.value) !== key || after.value.configurationRevision !== context.configurationRevision)
        return failure('stale-context', 'The task or printer configuration changed while loading object information.');
      if (job.controller.signal.aborted) return failure('cancelled', 'Object information reading was cancelled.');
      return { ok: true, value: { context: after.value, data } };
    } catch (error) {
      if (job.controller.signal.aborted || error instanceof BambuResourceError && error.code === 'cancelled') return failure('cancelled', 'Object information reading was cancelled.');
      return failure(error instanceof BambuResourceError && error.code === 'out-of-range' ? 'out-of-range' : 'transport', 'Current task object information could not be loaded.');
    } finally { if (token) await this.monitor.stop(token).catch(() => undefined); this.reads.delete(readId); job.finish(); }
  }
  private async resource(context: CommandContext, path: string, signal: AbortSignal) {
    const source = join(dirname(this.config.pluginPath), process.platform === 'win32' ? 'BambuSource.dll' : process.platform === 'darwin' ? 'libBambuSource.dylib' : 'libBambuSource.so');
    return this.readResource(this.config.addonPath, source, await this.source(context), path, { signal });
  }
  async read(target: D.PrinterTarget, readId: string = randomUUID()): Promise<D.Result<Extract<D.Reading<D.PrintObjectSnapshot>, { kind: 'known' }>>> {
    const loaded = await this.withRead(target, readId, async (context, signal) => {
      const plate = Math.max(1, number(context.report.plate_idx) ?? 1);
      const bytes = await this.resource(context, 'Metadata/slice_info.config', signal);
      return { plate, parsed: catalogue(bytes, plate), fingerprint: createHash('sha256').update(bytes).digest('hex') };
    });
    if (!loaded.ok) return loaded;
    const { context, data } = loaded.value, key = taskKey(context)!;
    if (!this.entry || this.entry.invalid || this.entry.key !== key || this.entry.fingerprint !== data.fingerprint || !sameTarget(this.entry.contextRef, target)
      || this.entry.contextRef.configurationRevision !== context.configurationRevision) {
      const labels = new Map(data.parsed.labels.map(label => [id<'print-object'>(`object:${label}`), label]));
      this.entry = { key, fingerprint: data.fingerprint, plate: data.plate, labelled: data.parsed.labelled, invalid: false, imageFailed: false,
        contextRef: { ...target, configurationRevision: context.configurationRevision, taskId: value(context.values.status.printStatus.taskId)!, token: id(randomUUID()) },
        labels, objects: data.parsed.labels.map((label, i) => ({ id: id(`object:${label}`), name: data.parsed.names[i] })) };
    }
    this.entry.imageFailed = false;
    const projected = this.project(context), template = context.values.status.printStatus.phase;
    if (!projected || template.kind !== 'known') return failure('stale-context', 'The current task changed.');
    this.changed(); return { ok: true, value: { ...template, value: projected.snapshot } };
  }
  async readMap(ref: D.PrintObjectContextRef, readId: string = randomUUID()): Promise<D.Result<D.PrintObjectMap>> {
    const entry = this.entry;
    if (!entry || entry.invalid || !sameReference(entry.contextRef, ref)) return failure('stale-context', 'This object map is no longer current.');
    const result = await this.withRead(ref, readId, async (context, signal) => {
      if (taskKey(context) !== entry.key || context.configurationRevision !== ref.configurationRevision || entry.invalid) throw new Error('Changed object context');
      const bytes = entry.image ?? await this.resource(context, `Metadata/pick_${entry.plate}.png`, signal);
      const png = Buffer.from(bytes);
      if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 2048 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 2048
        || [...entry.labels.values()].some(label => label > 0xffffff)) throw new Error('Invalid picking map');
      return bytes;
    });
    if (!result.ok) {
      if (result.error.code !== 'cancelled' && result.error.code !== 'stale-context' && this.entry === entry) { entry.imageFailed = true; this.changed(); }
      return result;
    }
    if (this.entry !== entry || entry.invalid) return failure('stale-context', 'This object map is no longer current.');
    entry.image = result.value.data.slice();
    return { ok: true, value: { contextRef: { ...ref }, bytes: entry.image.slice(), mimeType: 'image/png',
      palette: [...entry.labels].map(([objectId, colourId]) => ({ objectId, colourId })) } };
  }
  async reconcile() {
    if (this.entry) { const context = await this.monitor.context(this.entry.contextRef); if (!context.ok) this.entry.invalid = true; else this.project(context.value); }
    for (const [readId, job] of this.reads) { const context = await this.monitor.context(job.target); if (!context.ok || job.revision && context.value.configurationRevision !== job.revision) this.cancel(readId); }
  }
  async close() { this.closed = true; this.entry = null; const jobs = [...this.reads.values()]; for (const job of jobs) job.controller.abort(); await Promise.allSettled(jobs.map(job => job.done)); }
}

export function prepareObjectCommand(context: CommandContext, params: D.PrinterCommandSpecs['jobs.skipObjects']['params']): D.Result<PreparedCommand> {
  const current = context.objects;
  if (!current || !sameReference(current.snapshot.contextRef, params.contextRef)) return failure('stale-context', 'This object selection is no longer current.');
  const snapshot = current.snapshot;
  if (snapshot.availability.kind !== 'available') return failure(snapshot.availability.kind === 'blocked' ? snapshot.availability.reasons[0]?.code ?? 'precondition-failed' : 'precondition-failed', snapshot.availability.kind === 'blocked'
    ? snapshot.availability.reasons.map(r => r.message).join(' ') : snapshot.availability.reason);
  if (!params.objectIds.length || params.objectIds.length > 64 || new Set(params.objectIds).size !== params.objectIds.length || !['skip-selected', 'cancel-print'].includes(params.intent)) return failure('invalid-request', 'Select a valid non-empty object batch.');
  const skipped = value(snapshot.skippedObjectIds);
  if (!skipped || snapshot.skippedObjectIds.kind !== 'known' || snapshot.skippedObjectIds.freshness !== 'fresh') return failure('offline', 'Wait for current object state.');
  if (params.objectIds.some(objectId => !current.labels.has(objectId))) return failure('invalid-target', 'An object is not part of this task.');
  if (params.objectIds.some(objectId => skipped.includes(objectId))) return failure('stale-context', 'Selected objects have already been skipped. Review the remaining selection.');
  const remaining = snapshot.objects.filter(o => !skipped.includes(o.id));
  const all = remaining.length === params.objectIds.length && remaining.every(o => params.objectIds.includes(o.id));
  if (params.intent === 'cancel-print') {
    if (!all) return failure('stale-context', 'The remaining objects changed. Confirm the current selection again.');
    return { ok: true, value: { section: 'print', qos: 1, fields: { command: 'stop', param: '' }, confirmed: next => {
      const task = value(next.values.status.printStatus.taskId);
      return ['idle', 'cancelled', 'failed'].includes(value(next.values.status.printStatus.phase) ?? '') && (task === null || task === params.contextRef.taskId);
    } } };
  }
  if (all) return failure('precondition-failed', 'Skipping every remaining object requires confirmation to stop the print.');
  const labels = params.objectIds.map(objectId => current.labels.get(objectId)!);
  const expected = taskKey(context);
  return { ok: true, value: { section: 'print', qos: 1, fields: { command: 'skip_objects', obj_list: labels }, confirmed: next =>
    taskKey(next) === expected && Array.isArray(next.report.s_obj) && labels.every(label => (next.report.s_obj as unknown[]).includes(label)) } };
}
