// packages/slicer-wasm/src/client/client.test.ts
// Contract tests for the typed bridge client, driven against the
// bridge-shaped mock module (Task 1). These pin the M2 bridge
// contract that Task 7 implements in C++.
import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createClient } from './client';
import type { ModelTransform } from './types';

function makeClient() {
  return createClient(async () => createMockModule());
}

describe('SlicerClient bridge contract', () => {
  it('init loads preset collections', async () => {
    const c = makeClient();
    const r = await c.init();
    expect(r.ok).toBe(true);
    expect(r.printers).toBeGreaterThan(0);
  });

  it('getPresets lists names per kind', async () => {
    const c = makeClient();
    const p = await c.getPresets('printer');
    expect(p.presets.length).toBeGreaterThan(0);
    expect(p.presets[0]).toHaveProperty('name');
  });

  it('getPresets entries carry the M4 installed/selection flags', async () => {
    const c = makeClient();
    const p = await c.getPresets('printer');
    expect(p.presets[0]).toMatchObject({
      is_visible: true,
      is_default: false,
      vendor_id: 'bambulab',
      model: 'X1 Carbon',
      variant: '0.4',
      selected: true,
    });
    // the fixture's hidden entry exercises the picker's not-installed group
    expect(p.presets.some((x) => !x.is_visible)).toBe(true);
    // exactly one entry per kind is selected
    for (const kind of ['printer', 'print', 'filament'] as const) {
      const list = await c.getPresets(kind);
      expect(list.presets.filter((x) => x.selected)).toHaveLength(1);
    }
  });

  it('init accepts an app config JSON and getAppConfig round-trips it', async () => {
    const c = makeClient();
    const cfg = { models: [], presets: { machine: 'Bambu Lab P1S 0.4 nozzle' } };
    const r = await c.init(cfg);
    expect(r.ok).toBe(true);
    const back = await c.getAppConfig();
    expect(back.ok).toBe(true);
    expect(back.presets).toEqual({ machine: 'Bambu Lab P1S 0.4 nozzle' });
  });

  it('setAppConfig re-inits with a new config', async () => {
    const c = makeClient();
    const r = await c.setAppConfig({ models: [], presets: {} });
    expect(r.ok).toBe(true);
    expect(r.printers).toBeGreaterThan(0);
  });

  it('selectPreset moves the selection and reports all three', async () => {
    const c = makeClient();
    const r = await c.selectPreset('printer', 'Bambu Lab P1S 0.4 nozzle');
    expect(r.ok).toBe(true);
    expect(r.printer.name).toBe('Bambu Lab P1S 0.4 nozzle');
    expect(r.print.name).toBe('0.20mm Standard @BBL X1C');
    expect(r.filament.name).toBe('Bambu PLA Basic @BBL X1C');
    // the enriched list reflects the new selection
    const p = await c.getPresets('printer');
    expect(p.presets.find((x) => x.selected)?.name).toBe('Bambu Lab P1S 0.4 nozzle');
  });

  it('selectPreset rejects unknown names', async () => {
    const c = makeClient();
    const r = await c.selectPreset('printer', 'No Such Printer');
    // bridge error contract: {error} without ok
    expect(r.ok).toBeFalsy();
    expect(r.error).toContain('not found');
  });

  it('getOptionMetadata exposes typed keys', async () => {
    const c = makeClient();
    const m = await c.getOptionMetadata();
    expect(m.layer_height?.type).toBe('float');
    expect(m.sparse_infill_pattern?.enum_values).toContain('grid');
  });

  it('loadModel stages bytes and reports objects', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await c.loadModel(bytes, 'stl');
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
  });

  it('setInstanceOffset round-trips x/y', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await c.loadModel(bytes, 'stl');
    const r = await c.setInstanceOffset(0, 0, 10, 20, 0);
    expect(r.ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].offset[0]).toBe(10);
    expect(mesh.objects[0].offset[1]).toBe(20);
  });

  it('round-trips a CompositeID transform pair', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    const instance: ModelTransform = { offset: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    const volume: ModelTransform = { offset: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    expect((await c.setModelTransform(0, 0, 0, instance, volume)).ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0]).toMatchObject({ objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: instance, volumeTransform: volume });
  });

  it('getModelMesh extracts vertices and indices, frees the heap', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].vertexCount).toBe(8);
    expect(mesh.objects[0].indexCount).toBe(36);
    expect(mesh.objects[0].positions.byteLength).toBe(8 * 3 * 4);
    expect(mesh.objects[0].indices.byteLength).toBe(36 * 4);
    expect(mesh.objects[0].indices[0]).toBe(0);
  });

  it('mock fixture can expose independently transformable instances', async () => {
    const c = createClient(async () => createMockModule({ instanceCount: 2 }));
    await c.loadModel(new Uint8Array(4), 'stl');
    const before = await c.getModelMesh();
    expect(before.objects).toHaveLength(2);
    expect(before.objects[1]).toMatchObject({ instanceIdx: 1, offset: [50, 0, 0] });

    await c.setInstanceOffset(0, 1, 75, 0, 0);
    const after = await c.getModelMesh();
    expect(after.objects[0].offset).toEqual([0, 0, 0]);
    expect(after.objects[1].offset).toEqual([75, 0, 0]);
  });

  it('slice fires progress and returns unrecognized_keys', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await c.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(r.unrecognized_keys).toEqual([]);
    expect(events).toContain(0);
    expect(events).toContain(100);
  });

  it('getSliceResult extracts toolpath + mesh buffers with layer ranges', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    await c.slice({}, () => {});
    const r = await c.getSliceResult();
    expect(r.layers).toBe(40);
    expect(r.toolpath.vertexCount).toBe(2400);
    expect(r.toolpath.positions.byteLength).toBe(2400 * 3 * 4);
    expect(r.toolpath.features.length).toBeGreaterThanOrEqual(2);
    expect(r.mesh.vertexCount).toBeGreaterThan(0);
    expect(r.mesh.indexCount).toBe(36);
    // every triangle index < vertex count
    const maxIdx = Math.max(...Array.from(r.mesh.indices));
    expect(maxIdx).toBeLessThan(r.mesh.vertexCount);
  });

  it('exportGcode returns the MEMFS bytes', async () => {
    const c = makeClient();
    const r = await c.exportGcode();
    expect(r.ok).toBe(true);
    expect(new TextDecoder().decode(r.bytes.slice(0, 6))).toBe('; mock');
  });

  it('cancel is safe', async () => {
    const c = makeClient();
    const r = await c.cancel();
    expect(r.ok).toBe(true);
  });
});
