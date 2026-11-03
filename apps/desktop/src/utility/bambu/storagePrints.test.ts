import { describe, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { RemotePrintMetadata } from '../../../../../packages/slicer-runtime/src/core';
import { BambuStorageFiles, type BambuStorageSource } from './storageFiles';
import { BambuStoragePrints } from './storagePrints';

const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const plate = (index = 0): RemotePrintMetadata['targets'][number] => ({ plateIndex: index, gcodePath: `Metadata/plate_${index + 1}.gcode`, thumbnailPath: '', printerModelId: 'N1', nozzleDiameters: '0.4', nozzleFlowTypes: '0', filamentMap: [1], duration: '120', weight: '2', toolpathOutside: false, configuration: {}, warnings: [],
  materials: [{ index: 0, type: 'PLA', color: '#FF0000', presetId: 'GFA00', brand: '', usedGrams: 2, usedMeters: 1, nozzleDiameter: 0.4, nozzleFlowType: 'Standard' }] });
async function fixture(name = 'part.gcode.3mf', metadata: RemotePrintMetadata = { configuration: {}, targets: [plate(), plate(1)] }) {
  let now = 1000;
  const source: BambuStorageSource = { configurationRevision: 'r1', discover: async () => ['sdcard'],
    list: vi.fn(async () => [{ name, path: `/${name}`, sizeBytes: 3, modifiedAtSeconds: null }]),
    download: vi.fn(), remove: vi.fn(), resource: vi.fn(async () => Uint8Array.of(1)) };
  const files = new BambuStorageFiles(async () => ({ ok: true, value: source }));
  const page = await files.list({ target, storageId: 'sdcard' as D.Id<'storage'>, location: { kind: 'collection', collectionId: 'model' as D.Id<'file-collection'> } });
  if (!page.ok) throw new Error('fixture');
  const inspect = vi.fn(async () => metadata), prepare = vi.fn(async (): Promise<D.Result<D.PrintPreparation>> => ({ ok: true, value: {
    nozzleLabels: [], materialCatalogIds: [], configurationRevision: 'r1', route: 'lan', bindings: [], candidates: [], options: {}, optionDescriptors: [], issues: [],
  } }));
  const execute = vi.fn(async (): Promise<D.Result<'sent' | 'unknown'>> => ({ ok: true, value: 'sent' }));
  const prints = new BambuStoragePrints(files, { inspect }, prepare, () => now, execute);
  return { source, file: page.value.files[0].ref, prints, inspect, prepare, execute, advance: () => { now += 31 * 60_000; } };
}
describe('device-file inspection contexts', () => {
  it('requires current warning acknowledgement and records submitted separately from confirmed printing', async () => {
    const f = await fixture(), inspection = await f.prints.inspect(f.file); if (!inspection.ok) throw new Error('fixture');
    const request = { target, requestId: 'start' as D.Id<'request'>, command: { type: 'jobs.start' as const, params: {
      source: f.file, inspection: { id: inspection.value.ref.id, targetId: inspection.value.targets[0].id }, bindings: [], acknowledgedIssues: [] as string[],
    } } };
    expect(await f.prints.submit(request)).toMatchObject({ kind: 'rejected', error: { code: 'precondition-failed' } });
    expect(f.execute).not.toHaveBeenCalled();
    request.command.params.acknowledgedIssues = ['remote-material-metadata'];
    const result = await f.prints.submit(request); if (result.kind !== 'recorded') throw new Error('fixture');
    await vi.waitFor(() => expect(f.prints.get(result.operation)).toMatchObject({ kind: 'found', operation: { phase: { kind: 'submitted' } } }));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ requirements: expect.objectContaining({ plateId: 'plate:0' }) }), { name: 'part.gcode.3mf', path: '/part.gcode.3mf', plateIndex: 0 });
    expect(f.prints.get({ ...result.operation, routeId: 'other' as D.Id<'route'> })).toMatchObject({ kind: 'unknown' });
    f.execute.mockResolvedValueOnce({ ok: true, value: 'unknown' });
    const uncertain = await f.prints.submit({ ...request, requestId: 'second' as D.Id<'request'> }); if (uncertain.kind !== 'recorded') throw new Error('fixture');
    await f.prints.close();
    expect(f.prints.get(uncertain.operation)).toMatchObject({ kind: 'found', operation: { phase: { kind: 'outcome-unknown' } } });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('reads bounded metadata without full download and prepares only the selected agent-owned plate', async () => {
    const f = await fixture(), result = await f.prints.inspect(f.file);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.targets.map(t => t.label)).toEqual(['Plate 1', 'Plate 2']);
    expect(f.source.resource).toHaveBeenCalledTimes(6); expect(f.source.download).not.toHaveBeenCalled();
    const request: D.RemotePrintPreparationRequest = { inspection: result.value.ref, targetId: result.value.targets[1].id, bindings: [], options: {}, suggest: true, allowAbnormalStorage: false };
    result.value.targets[1].requirements!.printerModelId = 'forged';
    expect(await f.prints.prepare(request)).toMatchObject({ ok: true, value: { issues: [{ id: 'remote-material-metadata' }] } });
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ requirements: expect.objectContaining({ printerModelId: 'N1', plateId: 'plate:1' }) }));
    expect(await f.prints.prepare({ ...request, inspection: { ...request.inspection, file: { ...f.file, storageId: 'other' as D.Id<'storage'> } } })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    await f.prints.release(result.value.ref);
    expect((await f.prints.prepare(request)).ok).toBe(false);
  });
  it('keeps format decisions in the agent and refuses plugin filename rewriting', async () => {
    for (const name of ['part.gcode', '.part.gcode.3mf', ' part.gcode.3mf', 'part.GCODE.3MF']) {
      const f = await fixture(name);
      expect(await f.prints.inspect(f.file)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
      expect(f.source.resource).not.toHaveBeenCalled();
    }
  });
  it('rejects missing subfiles, changed device configuration and expired contexts without file version checks', async () => {
    const f = await fixture(); vi.mocked(f.source.resource).mockResolvedValue(null);
    expect(await f.prints.inspect(f.file)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.source.download).not.toHaveBeenCalled();
    vi.mocked(f.source.resource).mockResolvedValue(Uint8Array.of(1));
    const result = await f.prints.inspect(f.file); if (!result.ok) throw new Error('fixture');
    const request: D.RemotePrintPreparationRequest = { inspection: result.value.ref, targetId: result.value.targets[0].id, bindings: [], options: {}, suggest: false, allowAbnormalStorage: false };
    f.source.configurationRevision = 'r2';
    expect(await f.prints.prepare(request)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    f.source.configurationRevision = 'r1'; f.advance();
    expect(await f.prints.prepare(request)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  });
  it('marks ambiguous dual-nozzle maps unavailable instead of inventing an assignment', async () => {
    const p = { ...plate(), nozzleDiameters: '0.4 0.4', nozzleFlowTypes: '0 0', filamentMap: [] };
    const f = await fixture('part.gcode.3mf', { configuration: {}, targets: [p] });
    const result = await f.prints.inspect(f.file);
    expect(result).toMatchObject({ ok: true, value: { targets: [{ requirements: null, availability: { kind: 'blocked' } }] } });
  });
});
