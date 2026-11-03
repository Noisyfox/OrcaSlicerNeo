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
  const prints = new BambuStoragePrints(files, { inspect }, prepare, () => now);
  return { source, file: page.value.files[0].ref, prints, inspect, prepare, advance: () => { now += 31 * 60_000; } };
}
describe('device-file inspection contexts', () => {
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
