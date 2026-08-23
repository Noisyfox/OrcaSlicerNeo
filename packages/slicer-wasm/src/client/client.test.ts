// packages/slicer-wasm/src/client/client.test.ts
// Contract tests for the typed bridge client, driven against the
// bridge-shaped mock module (Task 1). These pin the M2 bridge
// contract that Task 7 implements in C++.
import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createClient } from './client';
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

  it('addModel stages bytes and reports objects', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await c.addModel(bytes, 'stl');
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
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

  it('mock fixture can expose independently transformable instances', async () => {
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

    it('reorderObjects moves an object immediately before another', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b, d] = before.objects;
      const r = await c.reorderObjects(d.id, a.id);
      expect(r.ok).toBe(true);
      expect(r.objects.map((o) => o.index)).toEqual([0, 1, 2]);
      expect(r.objects.map((o) => o.id)).toEqual([d.id, a.id, b.id]);
    });

    it('reorderVolumes moves a part before another within its object', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1, v2] = objects[0].volumes;
      const r = await c.reorderVolumes(objects[0].id, v2.id, v0.id);
      expect(r.ok).toBe(true);
      expect(r.objects[0].volumes.map((v) => v.id)).toEqual([v2.id, v0.id, v1.id]);
    });

    it('reorder rejects unknown object/volume IDs', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      expect((await c.reorderObjects(999999, objects[0].id)).error).toContain('object not found');
      expect((await c.reorderVolumes(objects[0].id, 999999, objects[0].volumes[0].id)).error).toContain('volume not found');
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
