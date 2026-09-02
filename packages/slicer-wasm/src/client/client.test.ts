// packages/slicer-wasm/src/client/client.test.ts
// Contract tests for the typed bridge client, driven against the
// bridge-shaped mock module (Task 1). These pin the M2 bridge
// contract that Task 7 implements in C++.
import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createClient } from './client';
import { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES } from './types';
import type { ModelTransform, VolumeType } from './types';

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

  it('getPresetSnapshot returns the coherent strict-hide picker state', async () => {
    const c = makeClient();
    const snapshot = await c.getPresetSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(snapshot.printers.map((preset) => preset.name)).toEqual([
      'Bambu Lab X1 Carbon 0.4 nozzle',
      'Bambu Lab P1S 0.4 nozzle',
    ]);
    expect(snapshot.prints.map((preset) => preset.name)).toEqual([
      '0.20mm Standard @BBL X1C',
      '0.16mm Optimal @BBL X1C',
    ]);
    expect(snapshot.filaments.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL X1C',
      'Bambu PLA Matte @BBL X1C',
      'Generic PLA @System',
    ]);
    expect(snapshot.printer.name).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(snapshot.print.name).toBe('0.20mm Standard @BBL X1C');
    expect(snapshot.filament.name).toBe('Bambu PLA Basic @BBL X1C');
  });

  it('selectPreset returns the resolved printer-to-process-to-filament snapshot', async () => {
    const c = makeClient();
    const r = await c.selectPreset('printer', 'Bambu Lab P1S 0.4 nozzle');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.printer.name).toBe('Bambu Lab P1S 0.4 nozzle');
    expect(r.print.name).toBe('0.20mm Standard @BBL P1S');
    expect(r.filament.name).toBe('Bambu PLA Basic @BBL P1S');
    expect(r.prints.map((preset) => preset.name)).toEqual(['0.20mm Standard @BBL P1S']);
    expect(r.filaments.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL P1S',
      'Generic PLA @System',
    ]);
  });

  it('selecting a process refreshes its dependent filament candidates and fallbacks', async () => {
    const c = makeClient();
    const matte = await c.selectPreset('filament', 'Bambu PLA Matte @BBL X1C');
    expect(matte.ok).toBe(true);
    const r = await c.selectPreset('print', '0.16mm Optimal @BBL X1C');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.print.name).toBe('0.16mm Optimal @BBL X1C');
    expect(r.filament.name).toBe('Bambu PLA Basic @BBL X1C');
    expect(r.filaments.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL X1C',
      'Bambu PLA Silk @BBL X1C',
      'Generic PLA @System',
    ]);
  });

  it('selectPreset rejects unavailable requests without mutating the snapshot', async () => {
    const c = makeClient();
    const before = await c.getPresetSnapshot();
    const unknown = await c.selectPreset('printer', 'No Such Printer');
    expect(unknown.ok).toBeFalsy();
    if (unknown.ok) throw new Error('expected unknown printer rejection');
    expect(unknown.error).toContain('not found');
    const hidden = await c.selectPreset('printer', 'Afinia H+1(HS)');
    expect(hidden.ok).toBeFalsy();
    if (hidden.ok) throw new Error('expected hidden printer rejection');
    expect(hidden.error).toContain('not visible');
    const incompatible = await c.selectPreset('print', '0.20mm Standard @BBL P1S');
    expect(incompatible.ok).toBeFalsy();
    if (incompatible.ok) throw new Error('expected incompatible process rejection');
    expect(incompatible.error).toContain('incompatible');
    expect(await c.getPresetSnapshot()).toEqual(before);
  });

  it('getOptionMetadata exposes typed keys', async () => {
    const c = makeClient();
    const m = await c.getOptionMetadata();
    expect(m.layer_height?.type).toBe('float');
    expect(m.sparse_infill_pattern?.enum_values).toContain('grid');
  });

  it('addModel stages bytes, preserves the selected basename, and reports objects', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await c.addModel(bytes, 'drc', 'cube_att.drc');
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
    await expect(c.getModelStructure()).resolves.toMatchObject({
      objects: [{ name: 'cube_att.drc' }],
    });
  });

  it('addShape builds every primitive with the engine tessellation', async () => {
    // Vertex counts mirror the libslic3r builders at OrcaSlicer's step
    // angles (the native bridge's orc_add_shape — see bridge-smoke).
    const EXPECTED: Array<[string, number]> = [
      ['Cube', 8], ['Cylinder', 362], ['Sphere', 16022],
      ['Cone', 183], ['Disc', 362], ['Torus', 14400],
    ];
    for (const [type, vertexCount] of EXPECTED) {
      const c = makeClient();
      await c.addShape(type, type);
      const s = await c.getModelStructure();
      expect(s.ok).toBe(true);
      expect(s.objects?.[0].name).toBe(type);
      expect(s.objects?.[0].volumes[0].name).toBe(type);
      const m = await c.getModelMesh();
      expect(m.objects?.[0].vertexCount).toBe(vertexCount);
    }
  });

  it('addShape defaults the name to the primitive type', async () => {
    const c = makeClient();
    await c.addShape('Cube');
    const s = await c.getModelStructure();
    expect(s.ok).toBe(true);
    expect(s.objects?.[0].name).toBe('Cube');
  });

  it('addShape rejects an unsupported primitive', async () => {
    const c = makeClient();
    await expect(c.addShape('Dodecahedron')).resolves.toMatchObject({
      error: expect.stringContaining('unsupported primitive type'),
    });
  });

  it('addModel preserves existing objects and clearModel resets the scene', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const added = await c.addModel(new Uint8Array(4), 'stl');
    expect(added).toMatchObject({ ok: true, objects: 2, instances: 2 });
    expect((await c.getModelMesh()).objects).toHaveLength(2);
    expect(await c.clearModel()).toMatchObject({ ok: true });
    expect((await c.getModelMesh()).error).toContain('no model loaded');
  });

  it('deleteObjects removes whole objects, dedupes, and shifts remaining indices', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    await c.addModel(new Uint8Array(4), 'stl');
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    const ids = objects.map((o) => o.id);
    const r = await c.deleteObjects([ids[1], ids[0], ids[1]]);
    expect(r).toMatchObject({ ok: true, objects: 1, deleted: 2 });
    const mesh = await c.getModelMesh();
    expect(mesh.objects.map((o) => o.objectIdx)).toEqual([0]);
  });

  it('deleteObjects rejects empty lists and unknown object IDs', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    expect((await c.deleteObjects([])).error).toContain('no object ids');
    const missing = await c.deleteObjects([5]);
    expect(missing.error).toContain('object not found');
    expect((await c.getModelMesh()).objects).toHaveLength(1);
  });

  it('deleteObjects on the last object leaves an empty mesh', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    await c.deleteObjects([objects[0].id]);
    const mesh = await c.getModelMesh();
    expect(mesh.ok).toBe(true);
    expect(mesh.objects).toHaveLength(0);
  });

  it('setInstanceOffset round-trips x/y', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await c.addModel(bytes, 'stl');
    const r = await c.setInstanceOffset(0, 0, 10, 20, 0);
    expect(r.ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].offset[0]).toBe(10);
    expect(mesh.objects[0].offset[1]).toBe(20);
  });

  it('round-trips a CompositeID transform pair', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const instance: ModelTransform = { offset: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    const volume: ModelTransform = { offset: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    expect((await c.setModelTransform(0, 0, 0, instance, volume)).ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0]).toMatchObject({ objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: instance, volumeTransform: volume });
  });

  it('getModelMesh extracts vertices and indices, frees the heap', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].vertexCount).toBe(8);
    expect(mesh.objects[0].indexCount).toBe(36);
    expect(mesh.objects[0].positions.byteLength).toBe(8 * 3 * 4);
    expect(mesh.objects[0].indices.byteLength).toBe(36 * 4);
    expect(mesh.objects[0].indices[0]).toBe(0);
  });

  it('mock fixture keeps instance placement independent while sharing part transforms', async () => {
    const c = createClient(async () => createMockModule({ instanceCount: 2, volumeCount: 2 }));
    await c.addModel(new Uint8Array(4), 'stl');
    const before = await c.getModelMesh();
    expect(before.objects).toHaveLength(4);
    expect(before.objects).toMatchObject([
      { instanceIdx: 0, volumeIdx: 0, offset: [0, 0, 0] },
      { instanceIdx: 0, volumeIdx: 1, offset: [0, 0, 0] },
      { instanceIdx: 1, volumeIdx: 0, offset: [50, 0, 0] },
      { instanceIdx: 1, volumeIdx: 1, offset: [50, 0, 0] },
    ]);

    await c.setInstanceOffset(0, 1, 75, 0, 0);
    const after = await c.getModelMesh();
    expect(after.objects.filter((o) => o.instanceIdx === 0).map((o) => o.offset)).toEqual([[0, 0, 0], [0, 0, 0]]);
    expect(after.objects.filter((o) => o.instanceIdx === 1).map((o) => o.offset)).toEqual([[75, 0, 0], [75, 0, 0]]);

    const volume = { offset: [3, 4, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const instance = { offset: [75, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    expect((await c.setModelTransform(0, 1, 1, instance, volume)).ok).toBe(true);
    const transformed = await c.getModelMesh();
    expect(transformed.objects.filter((o) => o.volumeIdx === 1).map((o) => o.volumeTransform)).toEqual([volume, volume]);
    expect(transformed.objects.find((o) => o.instanceIdx === 0 && o.volumeIdx === 0)?.instanceTransform.offset).toEqual([0, 0, 0]);
    expect(transformed.objects.find((o) => o.instanceIdx === 1 && o.volumeIdx === 1)?.instanceTransform).toEqual(instance);
  });

  it('allows transforming an instance added after model load and keeps it in the mesh', async () => {
    const c = createClient(async () => createMockModule());
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    const add = await c.addInstance(objects[0].id);
    expect(add.ok).toBe(true);
    const addedInstance = { offset: [123, 4, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const addedVolume = { offset: [7, 8, 9] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    expect((await c.setModelTransform(0, 0, 1, addedInstance, addedVolume)).ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects).toHaveLength(2);
    expect(mesh.objects.find((o) => o.instanceIdx === 1)).toMatchObject({
      offset: [123, 4, 5], instanceTransform: addedInstance, volumeTransform: addedVolume,
    });
  });

  describe('getModelStructure bridge contract', () => {
    it('returns the object/part/instance tree with stable IDs', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2, volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const r = await c.getModelStructure();
      expect(r.ok).toBe(true);
      expect(r.objects).toHaveLength(1);
      const obj = r.objects[0];
      expect(obj).toMatchObject({
        index: 0, name: 'Object 1', printable: true, instanceCount: 2,
      });
      expect(obj.id).toBeGreaterThan(0);
      expect(obj.volumes).toHaveLength(2);
      expect(obj.instances).toHaveLength(2);
      expect(obj.volumes[0]).toMatchObject({
        index: 0, name: 'Part 1', type: 'model_part', isSplittable: true,
      });
      expect(obj.volumes[0].id).toBeGreaterThan(0);
      expect(obj.instances[0]).toMatchObject({ index: 0, printable: true });
      expect(obj.instances[0].id).toBeGreaterThan(0);
    });

    it('returns an empty tree before any model is loaded', async () => {
      const c = makeClient();
      const r = await c.getModelStructure();
      expect(r.ok).toBe(true);
      expect(r.objects).toEqual([]);
    });

    it('keeps stable IDs after deleting an earlier object', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const keptId = before.objects[1].id;
      await c.deleteObjects([before.objects[0].id]);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(1);
      expect(after.objects[0].id).toBe(keptId);
      expect(after.objects[0].index).toBe(0);
    });
  });

  describe('Step 2 metadata mutations (stable ObjectID)', () => {
    it('renameObject renames an object by stable ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const id = objects[0].id;
      expect((await c.renameObject(id, 'Renamed')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0]).toMatchObject({ id, name: 'Renamed' });
    });

    it('renameVolume renames a specific part by stable ID', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[1];
      expect((await c.renameVolume(volume.id, 'Left wall')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[1]).toMatchObject({ id: volume.id, name: 'Left wall' });
    });

    it('setVolumeType changes a non-last-model-part type', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[0];
      expect((await c.setVolumeType(volume.id, 'negative_volume')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[0]).toMatchObject({ id: volume.id, type: 'negative_volume' });
      // The other part is untouched.
      expect(after.objects[0].volumes[1].type).toBe('model_part');
    });

    it('setVolumeType rejects changing the last solid part', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[0];
      const res = await c.setVolumeType(volume.id, 'negative_volume');
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last solid part');
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[0].type).toBe('model_part');
    });

    it('setVolumeType rejects an unknown type string', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.setVolumeType(objects[0].volumes[0].id, 'not_a_type' as VolumeType);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('invalid volume type');
    });

    it('setObjectPrintable toggles the object gate and every instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      expect(objects[0].printable).toBe(true);
      expect((await c.setObjectPrintable(objects[0].id, false)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].printable).toBe(false);
      expect(after.objects[0].instances.every((i) => i.printable === false)).toBe(true);
    });

    it('setInstancePrintable toggles a single instance only', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [first, second] = objects[0].instances;
      expect((await c.setInstancePrintable(second.id, false)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].instances[0]).toMatchObject({ id: first.id, printable: true });
      expect(after.objects[0].instances[1]).toMatchObject({ id: second.id, printable: false });
    });

    it('reports not-found for unknown IDs and guards blank names', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const missing = 99999;
      expect((await c.renameObject(missing, 'x')).error).toContain('object not found');
      expect((await c.renameVolume(missing, 'x')).error).toContain('volume not found');
      expect((await c.setInstancePrintable(missing, true)).error).toContain('instance not found');
      expect((await c.renameObject((await c.getModelStructure()).objects[0].id, '')).error).toContain('name is required');
    });

    it('invalidates the slice result after a non-destructive mutation', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.slice({});
      expect((await c.getSliceResult()).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.renameObject(objects[0].id, 'Renamed');
      const after = await c.getSliceResult();
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('no slice result');
    });
  });

  describe('Step 3 delete, clone, and reorder (stable ObjectID)', () => {
    it('deleteVolumes removes specific parts by ID and leaves the rest', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1] = objects[0].volumes;
      const r = await c.deleteVolumes([v1.id]);
      expect(r).toMatchObject({ ok: true, deleted: 1, objects: 1 });
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes).toHaveLength(1);
      expect(after.objects[0].volumes[0].id).toBe(v0.id);
    });

    it('deleteVolumes rejects removing the last solid part', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.deleteVolumes([objects[0].volumes[0].id]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last solid part');
      expect((await c.getModelStructure()).objects[0].volumes).toHaveLength(1);
    });

    it('deleteVolumes rejects an unknown volume ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.deleteVolumes([999999]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('volume not found');
    });

    it('cloneObjects mints fresh stable IDs for the clones', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2, instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const source = before.objects[0];
      const r = await c.cloneObjects([source.id]);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(1);
      expect(r.objects).toBe(2);
      expect(r.newObjectIds[0]).not.toBe(source.id);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(2);
      const clone = after.objects[1];
      expect(clone.id).toBe(r.newObjectIds[0]);
      expect(clone.name).toBe(source.name);
      // Clone volumes/instances get fresh IDs too.
      expect(clone.volumes.map((v) => v.id)).not.toContain(source.volumes[0].id);
      expect(clone.instances.map((i) => i.id)).not.toContain(source.instances[0].id);
    });

    it('reorderObjects moves an object to a destination index', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b, d] = before.objects;
      const r = await c.reorderObjects(d.id, a.index);
      expect(r.ok).toBe(true);
      expect(r.objects.map((o) => o.index)).toEqual([0, 1, 2]);
      expect(r.objects.map((o) => o.id)).toEqual([d.id, a.id, b.id]);
    });

    it('reorderObjects appends an object when toIndex == object count', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b, d] = before.objects;
      const r = await c.reorderObjects(a.id, before.objects.length);
      expect(r.ok).toBe(true);
      expect(r.objects.map((o) => o.id)).toEqual([b.id, d.id, a.id]);
    });

    it('reorderVolumes moves a part to a destination index within its object', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1, v2] = objects[0].volumes;
      const r = await c.reorderVolumes(objects[0].id, v2.id, v0.index);
      expect(r.ok).toBe(true);
      expect(r.objects[0].volumes.map((v) => v.id)).toEqual([v2.id, v0.id, v1.id]);
    });

    it('reorderVolumes appends a part when toIndex == volume count', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1, v2] = objects[0].volumes;
      const r = await c.reorderVolumes(objects[0].id, v0.id, objects[0].volumes.length);
      expect(r.ok).toBe(true);
      expect(r.objects[0].volumes.map((v) => v.id)).toEqual([v1.id, v2.id, v0.id]);
    });

    it('reorder rejects unknown object/volume IDs', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      expect((await c.reorderObjects(999999, 0)).error).toContain('object not found');
      expect((await c.reorderVolumes(objects[0].id, 999999, 0)).error).toContain('volume not found');
    });

    it('deleteObjects invalidates the slice result', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.slice({});
      expect((await c.getSliceResult()).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.deleteObjects([objects[0].id]);
      const after = await c.getSliceResult();
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('no slice result');
    });
  });

  describe('Step 4a split volume to parts (stable ObjectID)', () => {
    it('splits a splittable volume into fresh-ID parts and clears the old ID', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const originalId = objects[0].volumes[0].id;
      const r = await c.splitVolumeToParts(originalId);
      expect(r.ok).toBe(true);
      expect(r.parts).toBe(3);
      expect(r.newVolumeIds).toHaveLength(3);
      // The original volume ID is now stale (re-IDed by the split).
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes).toHaveLength(3);
      expect(after.objects[0].volumes.map((v) => v.id)).toEqual(r.newVolumeIds);
      expect(after.objects[0].volumes.map((v) => v.id)).not.toContain(originalId);
      // The returned structure matches the re-read.
      expect(r.objects?.[0].volumes.map((v) => v.id)).toEqual(after.objects[0].volumes.map((v) => v.id));
    });

    it('rejects a non-splittable volume', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      // In the mock only volume index 0 is splittable.
      const volume = objects[0].volumes[1];
      const res = await c.splitVolumeToParts(volume.id);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('not splittable');
    });

    it('rejects an unknown volume ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.splitVolumeToParts(999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('volume not found');
    });

    it('invalidates the slice result after a split', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      await c.slice({});
      expect((await c.getSliceResult()).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.splitVolumeToParts(objects[0].volumes[0].id);
      const after = await c.getSliceResult();
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('no slice result');
    });
  });

  describe('Step 4b split object to objects (stable ObjectID)', () => {
    it('mints fresh object IDs for the split objects', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const originalId = objects[0].id;
      const r = await c.splitObjectToObjects(originalId);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(2);
      expect(r.objects).toBe(2);
      const after = await c.getModelStructure();
      expect(after.objects.map((o) => o.id)).toEqual(r.newObjectIds);
      expect(after.objects.map((o) => o.id)).not.toContain(originalId);
    });

    it('rejects an unknown object ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.splitObjectToObjects(999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('object not found');
    });

    it('invalidates the slice result after a split', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      await c.slice({});
      expect((await c.getSliceResult()).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.splitObjectToObjects(objects[0].id);
      const after = await c.getSliceResult();
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('no slice result');
    });
  });

  describe('Step 4c merge objects to multipart (stable ObjectID)', () => {
    it('assembles objects into one multipart object and removes the sources', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2, instanceCount: 1 }));
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b] = before.objects;
      const r = await c.mergeObjectsToMultipart([a.id, b.id], 'Assembly');
      expect(r.ok).toBe(true);
      expect(r.objectId).toBeGreaterThan(0);
      expect(r.objects).toBe(1);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(1);
      expect(after.objects[0].id).toBe(r.objectId);
      expect(after.objects[0].name).toBe('Assembly');
      // One object per source source volume: 2 + 2.
      expect(after.objects[0].volumes).toHaveLength(4);
      expect(after.objects.map((o) => o.id)).not.toContain(a.id);
      expect(after.objects.map((o) => o.id)).not.toContain(b.id);
    });

    it('rejects an unknown object ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.mergeObjectsToMultipart([999999], 'X');
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('object not found');
    });

    it('invalidates the slice result after assembly', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.slice({});
      expect((await c.getSliceResult()).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.mergeObjectsToMultipart([objects[0].id, objects[1].id], 'Asm');
      const after = await c.getSliceResult();
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('no slice result');
    });
  });

  describe('Step 4d separate instances into objects (stable ObjectID)', () => {
    it('creates one object per selected instance and drops them from the source', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const source = objects[0];
      const [i0, i1, i2] = source.instances;
      const r = await c.separateInstances(source.id, [i1.id, i2.id]);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(2);
      expect(r.objects).toBe(3); // source (1 instance left) + 2 new
      const after = await c.getModelStructure();
      expect(after.objects.map((o) => o.id)).toEqual(
        expect.arrayContaining([source.id, ...r.newObjectIds]),
      );
      // The source kept only instance 0.
      const kept = after.objects.find((o) => o.id === source.id);
      expect(kept?.instances.map((i) => i.id)).toEqual([i0.id]);
      // Each new object has exactly one instance.
      for (const id of r.newObjectIds) {
        const o = after.objects.find((x) => x.id === id);
        expect(o?.instances).toHaveLength(1);
      }
    });

    it('rejects an unknown instance ID', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.separateInstances(objects[0].id, [999999]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('instance not found');
    });

    it('rejects an empty instance list', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.separateInstances(objects[0].id, []);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('no instance ids');
    });
  });

  describe('add / remove instance (stable ObjectID)', () => {
    it('addInstance mints a new instance and grows the instance count', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const beforeIds = objects[0].instances.map((i) => i.id);
      const r = await c.addInstance(objects[0].id);
      expect(r.ok).toBe(true);
      expect(r.instanceId).toBeGreaterThan(0);
      const after = await c.getModelStructure();
      expect(after.objects[0].instanceCount).toBe(3);
      expect(after.objects[0].instances.map((i) => i.id)).toEqual([...beforeIds, r.instanceId]);
    });

    it('removeInstance removes a specific instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [first, second] = objects[0].instances;
      expect((await c.removeInstance(objects[0].id, second.id)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].instanceCount).toBe(1);
      expect(after.objects[0].instances.map((i) => i.id)).toEqual([first.id]);
    });

    it('removeInstance rejects removing the last instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 1 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.removeInstance(objects[0].id, objects[0].instances[0].id);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last instance');
    });

    it('removeInstance rejects an unknown instance ID', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.removeInstance(objects[0].id, 999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('instance not found');
    });
  });

  it('slice fires progress and returns unrecognized_keys', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await c.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(r.unrecognized_keys).toEqual([]);
    expect(events).toContain(0);
    expect(events).toContain(100);
  });

  it('threaded client publishes progress through shared memory, never addFunction', async () => {
    const module = createMockModule({ threaded: true });
    const c = createClient(async () => module);
    await c.init();
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const words = new Int32Array(module.HEAPU8.buffer, 128, 4);
    expect(Atomics.load(words, 0)).toBeGreaterThan(0);
    expect(Atomics.load(words, 0) % 2).toBe(0);
    expect(Atomics.load(words, 1)).toBe(100);
    expect(module._functionRegistrations).toBe(0);
  });

  it('beforeInit runs once across repeated init calls (StrictMode double-mount)', async () => {
    // App.tsx boots from a StrictMode effect in dev, so init() is sent twice.
    // Profile installation must not re-fetch/re-mount on the second call.
    let installRuns = 0;
    const c = createClient(async () => createMockModule(), undefined, undefined, async () => { installRuns += 1; });
    await c.init();
    await c.init();
    expect(installRuns).toBe(1);
  });

  it('beforeInit retries a rejected install on the next init', async () => {
    let installRuns = 0;
    const c = createClient(async () => createMockModule(), undefined, undefined, async () => {
      installRuns += 1;
      if (installRuns === 1) throw new Error('first install failed');
    });
    await expect(c.init()).rejects.toThrow('first install failed');
    await expect(c.init()).resolves.toMatchObject({ ok: true });
    expect(installRuns).toBe(2);
  });

  it('getSliceResult extracts toolpath buffers with layer ranges', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({}, () => {});
    const r = await c.getSliceResult();
    expect(r.layers).toBe(40);
    expect(r.toolpath.vertexCount).toBe(2400);
    expect(r.toolpath.positions.byteLength).toBe(2400 * 3 * 4);
    expect(r.toolpath.features.length).toBeGreaterThanOrEqual(2);
  });

  it('decodes continuous v2 segments, indexes, palettes and metadata', async () => {
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 2, toolpathVertices: 4,
        features: [{ id: 0, name: 'Perimeter', color: [255, 0, 0] }, { id: 1, name: 'Infill', color: [0, 0, 255] }],
        extruderPalette: [
          { id: 0, name: 'Red PLA', color: [255, 0, 0], tool: 0 },
          { id: 1, name: 'Blue PETG', color: [0, 0, 255], tool: 1 },
        ],
        resultId: 42,
        optionalMetrics: { feedrate: [10, 20, 30, 40], volumetric_flow: [1, 2, 3, 4] },
        analysis: {
          summary: { estimatedTimeSeconds: 12.5, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07 },
          featureStatistics: [{ featureId: 0, timeSeconds: 8, filamentLengthMeters: 0.75 }, { featureId: 1, timeSeconds: 4.5, filamentWeightGrams: 1.2 }],
        },
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const r = await c.getSliceResult();
    const t = r.toolpath;
    expect(t.segmentCount).toBe(4);
    expect(t.starts.length).toBe(12);
    expect(t.ends.length).toBe(12);
    for (let i = 1; i < t.segmentCount; i++)
      expect(Array.from(t.starts.slice(i * 3, i * 3 + 3))).toEqual(Array.from(t.ends.slice((i - 1) * 3, i * 3)));
    expect(t.layerIds.length).toBe(4);
    expect(t.moveOrders).toEqual(new Uint32Array([0, 1, 0, 1]));
    expect(t.gcodeIds).toEqual(new Uint32Array([1, 2, 3, 4]));
    expect(t.widths[1]).toBeCloseTo(0.45);
    expect(t.metrics.feedrate).toEqual(new Float32Array([10, 20, 30, 40]));
    expect(t.metrics.actualFeedrate).toBeUndefined();
    expect(r.metadata.resultId).toBe(42);
    expect(r.metadata.sourceText).toEqual({ available: true });
    expect(r.metadata.layerRanges).toHaveLength(2);
    expect(r.metadata.extruderPalette?.[0].tool).toBe(0);
    expect(r.metadata.extruderPalette).toEqual([
      { id: 0, name: 'Red PLA', color: [255, 0, 0], tool: 0 },
      { id: 1, name: 'Blue PETG', color: [0, 0, 255], tool: 1 },
    ]);
    expect(r.metadata.analysis?.summary).toEqual({
      estimatedTimeSeconds: 12.5, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07,
    });
    expect(r.metadata.analysis?.featureStatistics).toEqual([
      { featureId: 0, timeSeconds: 8, filamentLengthMeters: 0.75 },
      { featureId: 1, timeSeconds: 4.5, filamentWeightGrams: 1.2 },
    ]);
    expect(r.metadata.analysis?.metricRanges).toEqual({
      feedrate: { min: 10, max: 40 }, volumetricFlow: { min: 1, max: 4 },
    });
  });

  it('omits unavailable optional metrics while preserving required arrays', async () => {
    const c = createClient(async () => createMockModule({
      sliceFixture: { layers: 1, toolpathVertices: 2, features: [{ id: 0, name: 'Travel', color: [1, 2, 3] }] },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const r = await c.getSliceResult();
    expect(r.toolpath.segmentCount).toBe(2);
    expect(r.toolpath.metrics).toEqual({});
    expect(r.metadata.sourceLineMapping?.available).toBe(true);
  });

  it('exportGcode returns the MEMFS bytes', async () => {
    const c = makeClient();
    const r = await c.exportGcode();
    expect(r.ok).toBe(true);
    expect(new TextDecoder().decode(r.bytes.slice(0, 6))).toBe('; mock');
  });

  it('reads bounded UTF-8 source chunks by completed result id', async () => {
    const sourceText = '; 注释\nG1 X1\nG1 X2\n';
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 1, toolpathVertices: 2,
        features: [{ id: 0, name: 'Perimeter', color: [255, 0, 0] }],
        resultId: 17, sourceText,
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const result = await c.getSliceResult();
    const encoded = new TextEncoder().encode(sourceText);
    const middle = await c.readTextChunk({ resultId: result.metadata.resultId, offset: 3, length: 5 });
    expect(middle.offset).toBe(2);
    expect(middle.text).toBe('注释');
    expect(middle.eof).toBe(false);
    const tail = await c.readTextChunk({ resultId: result.metadata.resultId, offset: encoded.length - 1, length: 1 });
    expect(tail.text).toBe('\n');
    await expect(c.readTextChunk({ resultId: 16, offset: 0, length: 1 })).rejects.toThrow('unavailable');
    await expect(c.readTextChunk({ resultId: 17, offset: 0, length: 64 * 1024 + 1 })).rejects.toThrow('at most');
  });

  it('bounds both UTF-8 alignment edges for a maximum-size request', async () => {
    const sourceText = `😀${'a'.repeat(65534)}😀tail`;
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 1, toolpathVertices: 2,
        features: [{ id: 0, name: 'Perimeter', color: [255, 0, 0] }],
        resultId: 18, sourceText,
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const result = await c.getSliceResult();
    const chunk = await c.readTextChunk({
      resultId: result.metadata.resultId,
      offset: 3,
      length: PREVIEW_TEXT_CHUNK_MAX_BYTES,
    });
    expect(chunk.offset).toBe(0);
    expect(new TextEncoder().encode(chunk.text).byteLength).toBe(PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES);
    expect(chunk.eof).toBe(false);
  });

  it('cancel is safe', async () => {
    const c = makeClient();
    const r = await c.cancel();
    expect(r.ok).toBe(true);
  });

  it('init forwards globalThis.ORCA_LOG_LEVEL in the options JSON', async () => {
    let initJson = '';
    const c = createClient(async () => {
      const m = await createMockModule();
      const orig = m.ccall.bind(m);
      m.ccall = ((name: string, ret: string, argTypes: string[], args: unknown[]) => {
        if (name === 'orc_init') initJson = String(args[0]);
        return orig(name, ret, argTypes, args);
      }) as typeof m.ccall;
      return m;
    });
    const global = globalThis as { ORCA_LOG_LEVEL?: unknown };
    global.ORCA_LOG_LEVEL = 'debug';
    try {
      const r = await c.init();
      expect(r.ok).toBe(true);
      expect(JSON.parse(initJson)).toEqual({ log_level: 'debug' });
    } finally {
      delete global.ORCA_LOG_LEVEL;
    }
  });

  it('init omits log_level when the global is unset', async () => {
    let initJson = '';
    const c = createClient(async () => {
      const m = await createMockModule();
      const orig = m.ccall.bind(m);
      m.ccall = ((name: string, ret: string, argTypes: string[], args: unknown[]) => {
        if (name === 'orc_init') initJson = String(args[0]);
        return orig(name, ret, argTypes, args);
      }) as typeof m.ccall;
      return m;
    });
    const global = globalThis as { ORCA_LOG_LEVEL?: unknown };
    delete global.ORCA_LOG_LEVEL;
    await c.init();
    // The C++ bridge defaults to info when the key is absent.
    expect(JSON.parse(initJson)).toEqual({});
  });

  it('readLog returns the MEMFS log file', async () => {
    const c = createClient(async () => {
      const m = await createMockModule();
      m.FS.writeFile('/tmp/orca.log', new TextEncoder().encode('[2026-08-21 10:00:00.000000] [info] orc_init: bridge ready\n'));
      return m;
    });
    const r = await c.readLog();
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/tmp/orca.log');
    expect(new TextDecoder().decode(r.bytes)).toContain('[info] orc_init: bridge ready');
  });

  it('readLog reports (not throws) when no log file exists', async () => {
    const c = makeClient();
    const r = await c.readLog();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
    expect(r.bytes.length).toBe(0);
  });
});
