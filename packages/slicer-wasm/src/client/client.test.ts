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
