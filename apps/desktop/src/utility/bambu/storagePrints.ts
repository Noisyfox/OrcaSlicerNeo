import { randomUUID } from 'node:crypto';
import type * as D from '@orca/printer-control/domain';
import { REMOTE_PRINT_RESOURCES, type RemotePrintMetadata, type RemotePrintResourceBytes } from '../../../../../packages/slicer-runtime/src/core';
import type { RemotePrintInspector } from '../remotePrintInspector';
import { BambuStorageFiles, storageFailure } from './storageFiles';

const failure = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
interface Context { value: D.RemotePrintInspection; name: string; path: string; warnings: Map<string, D.PrintIssue[]>; thumbnails: Map<string, string> }
type StartRequest = Extract<D.CommandRequest, { command: D.CommandOf<'jobs.start'> }>;
type Execute = (request: D.PrintSubmissionRequest, file: { path: string; name: string; plateIndex: number }) => Promise<D.Result<'sent' | 'unknown'>>;

/** Metadata and preparation contexts belong to this agent, never to a Project.
 * Context identity scopes a selected plate; it does not identify file contents. */
export class BambuStoragePrints implements D.PrinterRemotePrints {
  private contexts = new Map<string, Context>();
  private operations = new Map<string, D.CommandOperation>();
  private active = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly files: BambuStorageFiles, private readonly inspector: Pick<RemotePrintInspector, 'inspect'>,
    private readonly preparePrint: (r: D.PrintPreparationRequest) => Promise<D.Result<D.PrintPreparation>>,
    private readonly now = () => Date.now(), private readonly execute?: Execute, private readonly changed = () => {}) {}

  async inspect(file: D.RemoteFileRef, options?: D.ReadOptions): Promise<D.Result<D.RemotePrintInspection>> {
    if (this.closed) return failure('cancelled', 'Storage printing is closing.');
    const source = await this.files.resolveFile(file); if (!source.ok) return source;
    const { name, path, collection } = source.value.address;
    if (collection !== 'model' || !name.endsWith('.gcode.3mf') || !path)
      return failure('unsupported', 'This agent currently inspects sliced .gcode.3mf device files.');
    const normalized = name.replace(/^[. /\\]+/, '').replace(/[ .]+$/, '').replace(/[\x00-\x1f/\\]/g, '_');
    if (normalized !== name) return failure('unsupported', 'The printer plugin would change this file name. Rename it before printing.');
    try {
      const resources: RemotePrintResourceBytes[] = [];
      for (const resource of REMOTE_PRINT_RESOURCES) {
        if (options?.signal?.aborted) return failure('cancelled', 'Device file inspection was cancelled.');
        const data = await source.value.source.resource(path, resource, null, options?.signal);
        if (!data?.byteLength) continue;
        resources.push({ name: resource, bytes: data });
      }
      const metadata = await this.inspector.inspect(resources, options?.signal);
      const current = await this.files.resolveFile(file); if (!current.ok) return current;
      if (options?.signal?.aborted) return failure('cancelled', 'Device file inspection was cancelled.');
      const id = randomUUID() as D.Id<'print-inspection'>, warnings = new Map<string, D.PrintIssue[]>(), thumbnails = new Map<string, string>();
      const targets = metadata.targets.map(plate => {
        const normalized = normalizePlate(metadata, plate, id);
        const resource = plate.thumbnailPath.replace(/^\//, '');
        if (/^Metadata\/[\w.-]+\.(png|jpe?g)$/i.test(resource) && !resource.includes('..')) {
          const previewId = `print-thumbnail:${id}:${plate.plateIndex}` as D.Id<'preview-option'>;
          thumbnails.set(previewId, resource);
          normalized.target.thumbnail = { id: previewId, kind: 'thumbnail', label: `${normalized.target.label} thumbnail`, contentFormat: null };
        }
        warnings.set(normalized.target.id, normalized.warnings); return normalized.target;
      });
      const value: D.RemotePrintInspection = { ref: { file: { ...file }, id }, targets, expiresAtMs: this.now() + 30 * 60_000 };
      for (const [key, c] of this.contexts) if (c.value.expiresAtMs < this.now()) this.contexts.delete(key);
      while (this.contexts.size >= 16) this.contexts.delete(this.contexts.keys().next().value!);
      this.contexts.set(id, { value, name, path, warnings, thumbnails });
      return { ok: true, value: structuredClone(value) };
    } catch (error) {
      if (options?.signal?.aborted) return failure('cancelled', 'Device file inspection was cancelled.');
      return { ok: false, error: storageFailure(error) };
    }
  }

  resolve(ref: D.RemotePrintInspectionRef, targetId: D.Id<'print-target'>): D.Result<{ context: Context; target: D.RemotePrintTarget }> {
    const context = this.contexts.get(ref.id);
    if (!context || context.value.expiresAtMs < this.now() || !sameFile(context.value.ref.file, ref.file))
      return failure('stale-context', 'Reopen this device file to inspect its print targets.');
    const target = context.value.targets.find(t => t.id === targetId);
    if (!target?.requirements || target.availability.kind !== 'available')
      return failure('unsupported', 'This device-file print target is unavailable.');
    return { ok: true, value: { context, target } };
  }
  thumbnail(file: D.RemoteFileRef, previewId: string): string | null {
    const match = /^print-thumbnail:([^:]+):\d+$/.exec(previewId);
    const context = match && this.contexts.get(match[1]);
    return context && context.value.expiresAtMs >= this.now() && sameFile(context.value.ref.file, file)
      ? context.thumbnails.get(previewId) ?? null : null;
  }

  async prepare(request: D.RemotePrintPreparationRequest, options?: D.ReadOptions): Promise<D.Result<D.PrintPreparation>> {
    if (options?.signal?.aborted) return failure('cancelled', 'Device file preparation was cancelled.');
    const resolved = this.resolve(request.inspection, request.targetId); if (!resolved.ok) return resolved;
    const current = await this.files.resolveFile(request.inspection.file); if (!current.ok) return current;
    const file = request.inspection.file;
    const result = await this.preparePrint({ ...request, target: { printerId: file.printerId, routeId: file.routeId,
      expectedConfigurationRevision: file.configurationRevision }, requirements: resolved.value.target.requirements! });
    if (!result.ok) return result;
    if (options?.signal?.aborted) return failure('cancelled', 'Device file preparation was cancelled.');
    return { ok: true, value: { ...result.value, issues: [...result.value.issues, ...resolved.value.context.warnings.get(request.targetId) ?? []],
      ...(result.value.recordingSpace ? { recordingSpace: { ...result.value.recordingSpace, canClean: false } } : {}) } };
  }
  async release(ref: D.RemotePrintInspectionRef): Promise<D.Result<null>> {
    const context = this.contexts.get(ref.id);
    if (context && sameFile(context.value.ref.file, ref.file)) this.contexts.delete(ref.id);
    return { ok: true, value: null };
  }
  async evaluate(target: D.PrinterTarget, command: D.CommandOf<'jobs.start'>): Promise<D.Result<D.CommandEvaluation>> {
    const p = command.params;
    if (!p.inspection || target.printerId !== p.source.printerId || target.routeId !== p.source.routeId)
      return failure('invalid-target', 'Select an inspected print target on this printer.');
    const prepared = await this.prepare({ inspection: { file: p.source, id: p.inspection.id }, targetId: p.inspection.targetId,
      bindings: p.bindings, options: p.options ?? {}, suggest: false, allowAbnormalStorage: p.allowAbnormalStorage ?? false });
    if (!prepared.ok) return prepared;
    const blocking = prepared.value.issues.filter(i => i.severity === 'block');
    return { ok: true, value: { basis: { capabilityRevision: 'bambu-storage-1' }, availability: blocking.length
      ? { kind: 'blocked', reasons: blocking.map(i => ({ code: 'precondition-failed', message: i.message })) } : { kind: 'available' },
      warnings: prepared.value.issues.filter(i => i.severity === 'warning').map(i => ({ id: i.id, message: i.message, helpUrl: null })) } };
  }
  async submit(request: StartRequest): Promise<D.Submission> {
    const reject = (code: D.ErrorCode, message: string): D.Submission => ({ kind: 'rejected', error: { code, message } });
    if (this.closed || !this.execute) return reject('unsupported', 'Device-file printing is unavailable.');
    const p = request.command.params, file = p.source;
    if (!p.inspection || request.target.printerId !== file.printerId || request.target.routeId !== file.routeId)
      return reject('invalid-target', 'Select an inspected print target on this printer.');
    if (request.target.expectedConfigurationRevision !== undefined && request.target.expectedConfigurationRevision !== file.configurationRevision)
      return reject('stale-context', 'The printer configuration changed.');
    if (Object.entries(request.guard ?? {}).some(([key, value]) => key !== 'capabilityRevision' || value !== 'bambu-storage-1'))
      return reject('stale-context', 'Review the current print preparation before sending.');
    const selected = this.resolve({ file, id: p.inspection.id }, p.inspection.targetId); if (!selected.ok) return { kind: 'rejected', error: selected.error };
    const prepared = await this.prepare({ inspection: { file, id: p.inspection.id }, targetId: p.inspection.targetId,
      bindings: p.bindings, options: p.options ?? {}, suggest: false, allowAbnormalStorage: p.allowAbnormalStorage ?? false, checkRecording: true });
    if (!prepared.ok) return { kind: 'rejected', error: prepared.error };
    const issue = prepared.value.issues.find(i => i.severity === 'block' || i.severity === 'warning' && !p.acknowledgedIssues?.includes(i.id));
    if (issue) return reject('precondition-failed', issue.message);
    if (prepared.value.recordingSpace?.status === 'insufficient' && prepared.value.options.timelapse)
      return reject('precondition-failed', 'Disable timelapse or free recording space before printing.');
    if (this.closed || this.active.size >= 4) return reject('busy', 'Wait for the current device-file print request.');
    const { context, target } = selected.value;
    const operation: D.CommandOperation = { kind: 'command', commandType: 'jobs.start',
      ref: { printerId: file.printerId, routeId: file.routeId, id: randomUUID() as D.Id<'operation'> }, requestId: request.requestId,
      configurationRevision: file.configurationRevision, revision: 1, updatedAtMs: this.now(), phase: { kind: 'sent' },
      steps: [{ label: `${context.name} — ${target.label}`, phase: { kind: 'sent' } }] };
    this.operations.set(operation.ref.id, operation); this.changed();
    const work = (async () => {
      let phase: D.CommandOperation['phase'];
      try {
        const result = await this.execute!({ target: { ...request.target, expectedConfigurationRevision: file.configurationRevision },
          requestId: request.requestId, requirements: target.requirements!, bindings: p.bindings, options: p.options ?? {},
          allowAbnormalStorage: p.allowAbnormalStorage ?? false, jobName: context.name, acknowledgedIssues: p.acknowledgedIssues ?? [] },
        { path: context.path, name: context.name, plateIndex: Number(target.id.slice(6)) });
        phase = !result.ok ? { kind: 'failed', error: result.error } : result.value === 'sent' ? { kind: 'submitted' }
          : { kind: 'outcome-unknown', reason: 'Print start is unconfirmed. Check the printer before sending another request.' };
      } catch { phase = { kind: 'outcome-unknown', reason: 'Print start is unconfirmed. Check the printer before sending another request.' }; }
      this.operations.set(operation.ref.id, { ...operation, phase, steps: [{ ...operation.steps[0], phase }], revision: 2, updatedAtMs: this.now() });
      const finished = [...this.operations.values()].filter(v => v.phase.kind !== 'sent');
      for (const old of finished.slice(0, Math.max(0, finished.length - 200))) this.operations.delete(old.ref.id);
      this.changed();
    })().finally(() => this.active.delete(work));
    this.active.add(work);
    return { kind: 'recorded', operation: operation.ref };
  }
  get(ref: D.OperationRef): D.OperationLookup {
    const operation = this.operations.get(ref.id);
    return operation && operation.ref.printerId === ref.printerId && operation.ref.routeId === ref.routeId
      ? { kind: 'found', operation: structuredClone(operation) } : { kind: 'unknown', reason: 'not-found' };
  }
  find(request: D.RequestLookup): D.OperationLookup {
    const operation = [...this.operations.values()].find(o => o.requestId === request.requestId && o.ref.printerId === request.printerId && o.ref.routeId === request.routeId);
    return operation ? this.get(operation.ref) : { kind: 'unknown', reason: 'not-found' };
  }
  async close(): Promise<void> { this.closed = true; this.contexts.clear(); await Promise.allSettled([...this.active]); }
}

function sameFile(a: D.RemoteFileRef, b: D.RemoteFileRef) {
  return a.printerId === b.printerId && a.routeId === b.routeId && a.configurationRevision === b.configurationRevision && a.storageId === b.storageId && a.fileId === b.fileId;
}

function normalizePlate(archive: RemotePrintMetadata, plate: RemotePrintMetadata['targets'][number], contextId: string): { target: D.RemotePrintTarget; warnings: D.PrintIssue[] } {
  const id = `plate:${plate.plateIndex}` as D.Id<'print-target'>;
  const unavailable = (message: string) => ({ target: { id, label: `Plate ${plate.plateIndex + 1}`, requirements: null,
    availability: { kind: 'blocked' as const, reasons: [{ code: 'unsupported' as const, message }] } }, warnings: [] });
  const config = { ...archive.configuration, ...plate.configuration };
  const array = (key: string): (string | number)[] => Array.isArray(config[key]) ? config[key] as (string | number)[] : [];
  const text = (key: string, index?: number) => index === undefined ? typeof config[key] === 'string' ? config[key] as string : '' : String(array(key)[index] ?? '');
  const numeric = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const valid = (n: number) => Number.isFinite(n) && n >= 0;
  const scalar = (value: unknown) => { const n = numeric(value); return valid(n) ? n : 0; };
  const diameters = plate.nozzleDiameters.trim() ? plate.nozzleDiameters.trim().split(/[;,\s]+/).map(Number) : array('nozzle_diameter').map(Number);
  if (!Number.isSafeInteger(plate.plateIndex) || plate.plateIndex < 0 || plate.plateIndex > 63 || plate.gcodePath !== `Metadata/plate_${plate.plateIndex + 1}.gcode`)
    return unavailable('This plate uses an unsupported remote toolpath address.');
  if (!diameters.length || diameters.length > 2 || diameters.some(n => !valid(n) || n <= 0))
    return unavailable('The file does not describe a supported nozzle configuration.');
  const flowNames = ['Standard', 'High Flow', 'TPU High Flow', 'E3D High Flow'];
  const rawFlow = plate.nozzleFlowTypes || text('nozzle_volume_type');
  const flows = rawFlow ? rawFlow.split(/[;,]+|\s+(?=\d)/).map(s => flowNames[Number(s)] ?? s.trim()) : diameters.map(() => 'Standard');
  if (flows.length !== diameters.length || flows.some(s => !flowNames.includes(s))) return unavailable('The file has an unsupported nozzle flow configuration.');
  if (!plate.materials.length || plate.materials.length > 64 || plate.materials.some(m => !Number.isSafeInteger(m.index) || m.index < 0 || m.index >= 64))
    return unavailable('The file has invalid filament metadata.');
  const count = Math.max(...plate.materials.map(m => m.index)) + 1;
  const map = plate.filamentMap.length ? plate.filamentMap : diameters.length === 1 ? Array(count).fill(1) as number[] : [];
  if (map.length > 64 || new Set(plate.materials.map(m => m.index)).size !== plate.materials.length || plate.materials.some(m => !Number.isSafeInteger(map[m.index]) || map[m.index] < 1 || map[m.index] > diameters.length))
    return unavailable('The file does not specify an unambiguous filament-to-nozzle assignment.');
  const incomplete = plate.materials.some(m => ['chamber_temperature', 'temperature_vitrification', 'required_nozzle_HRC'].some(k => !valid(numeric(array(k)[m.index]))));
  const requirements: D.PrintRequirements = { contentId: contextId, plateId: id, printerModel: text('printer_model'), printerModelId: plate.printerModelId,
    nozzleDiameters: diameters, nozzleFlowTypes: flows, filamentMap: map, requiresDynamicMapping: config.enable_filament_dynamic_map === true,
    bedType: text('curr_bed_type'), durationSeconds: scalar(plate.duration), weightGrams: scalar(plate.weight), layerCount: 0, timelapseWarningCode: 0,
    toolpathOutside: plate.toolpathOutside, warnings: plate.warnings,
    materials: plate.materials.map(m => ({ key: `filament-${m.index}`, index: m.index, type: m.type, color: m.color,
      presetId: m.presetId, presetName: text('filament_settings_id', m.index), brand: m.brand || text('filament_vendor', m.index),
      toolIndex: map[m.index] - 1, nozzleDiameter: diameters[map[m.index] - 1], nozzleFlowType: flows[map[m.index] - 1],
      chamberTemperature: scalar(array('chamber_temperature')[m.index]), softeningTemperature: scalar(array('temperature_vitrification')[m.index]),
      requiredNozzleHardness: scalar(array('required_nozzle_HRC')[m.index]), usedGrams: scalar(m.usedGrams), usedMeters: scalar(m.usedMeters) })) };
  return { target: { id, label: `Plate ${plate.plateIndex + 1}`, requirements, availability: { kind: 'available' } }, warnings: incomplete ? [{
    id: 'remote-material-metadata', severity: 'warning', message: 'This device file omits some filament temperature or nozzle-hardness requirements. Check material and nozzle compatibility before printing.',
  }] : [] };
}
