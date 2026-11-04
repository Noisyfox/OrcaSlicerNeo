// Opt-in real bridge/client/history acceptance. No mocked geometry is used.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { installProfilePackages, createNodeProfileSource, fixtureProfileOptions } from './profile-installer.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { createClient } from '../src/client/client.ts';

const artifact = process.env.ORCA_MESH_BOOLEAN_MODULE;
const faults = process.env.ORCA_MESH_BOOLEAN_FAULTS === '1';
const here = import.meta.dirname;
const context = { selection: { mode: 'instance', objectIds: [], partIds: [], instanceIds: [] },
  activePlateId: null, gizmo: null, nativeScopedConfig: {} };
const trs = (offset = [0, 0, 0]) => ({ offset, rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });

describe.skipIf(!artifact)('real Mesh Boolean project operations', () => {
  let client, module, cube;
  beforeAll(async () => {
    const path = resolve(artifact);
    const wasm = await readFile(path.replace(/\.(?:m|c)?js$/, '.wasm'));
    expect(wasm.includes(Buffer.from('Injected Mesh Boolean publication failure'))).toBe(faults);
    module = await (await loadModuleFactory(path))({ noInitialRun: true, print: () => {}, printErr: () => {} });
    await installProfilePackages(module, createNodeProfileSource(resolve(here, '../../profile-resources/dist')));
    const pointer = Number(module.ccall('orc_init', 'number', ['string'], [fixtureProfileOptions(module)]));
    try { expect(JSON.parse(module.UTF8ToString(pointer)).ok).toBe(true); } finally { module._free(pointer); }
    client = createClient(async () => module);
    cube = new Uint8Array(await readFile(resolve(here, '../fixtures/cube.stl')));
  }, 120_000);
  beforeEach(async () => {
    expect((await client.clearModel()).ok).toBe(true);
    expect((await client.resetPlateSession()).ok).toBe(true);
  });

  async function pair(toolType = 'model_part', painted = false) {
    if (painted) {
      const entries = readZipEntries(await readFile(resolve(here, '../fixtures/painted-facet/painted-facet-instances.3mf')));
      const encoder = new TextEncoder(), decoder = new TextDecoder();
      for (const entry of entries) if (entry.name.endsWith('.model')) {
        entry.content = encoder.encode(decoder.decode(entry.content).replace(/<triangle\b[^>]*\/>/g,
          triangle => triangle.replace(/\s+paint_color="[^"]*"/g, '').replace('/>',
            ' paint_color="4" paint_supports="4" paint_seam="4" paint_fuzzy_skin="4"/>')));
      }
      expect((await client.loadProject(writeStoredZip(entries), 'project', 'painted-boolean.3mf')).ok).toBe(true);
    } else expect((await client.addModel(cube, 'stl', 'Boolean object')).ok).toBe(true);
    let object = (await client.getModelStructure()).objects[0];
    const added = await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id,
      volumeType: toolType, ext: 'stl', name: 'Tool B' }, cube);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    object = (await client.getModelStructure()).objects[0];
    const a = object.volumes.find(volume => volume.id !== added.volumeId).id;
    const b = added.volumeId;
    const mesh = (await client.getModelMesh()).objects.find(item => item.volumeId === b);
    expect((await client.setModelTransform(mesh.objectIdx, mesh.volumeIdx, mesh.instanceIdx,
      mesh.instanceTransform, trs([7.5, 5, 2.5]))).ok).toBe(true);
    await client.recomputePlateMembership();
    return { object, a, b, request: { entry: 'gizmo', objectId: object.id, instanceId: object.instances[0].id,
      sourceVolumeId: a, toolVolumeId: b, operation: 'union', deleteInput: false, keepPainting: false } };
  }
  async function meshFor(id) {
    return (await client.getModelMesh()).objects.find(item => item.volumeId === id);
  }
  function volume(mesh) {
    let total = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = [...mesh.indices.slice(i, i + 3)].map(index => [...mesh.positions.slice(index * 3, index * 3 + 3)]);
      total += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    return Math.abs(total);
  }
  function bounds(mesh, world = false) {
    const apply = (point, matrix) => point.map((_, axis) => matrix[axis] * point[0] +
      matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis]);
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      let point = apply([...mesh.positions.slice(i, i + 3)], mesh.volumeTransform.matrix);
      if (world) point = apply(point, mesh.instanceTransform.matrix);
      for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], point[axis]); high[axis] = Math.max(high[axis], point[axis]); }
    }
    return [...low, ...high];
  }
  async function instances() {
    return (await client.getModelMesh()).objects.filter(item => item.volumeIdx === 0)
      .map(item => ({ id: item.instanceId, transform: item.instanceTransform }));
  }
  async function transaction(request) {
    await client.resetHistory(context);
    let result;
    const committed = await client.runProjectHistoryTransaction('Mesh Boolean', 'project', context,
      async () => { result = await client.meshBoolean(request); expect(result.ok, JSON.stringify(result)).toBe(true); return result; },
      () => result.changed ? { ...context, selection: { mode: 'part', objectIds: [result.objectId],
        partIds: [result.volumeId], instanceIds: request.instanceId ? [request.instanceId] : [] } } : context);
    return committed;
  }
  async function exportModels() {
    const exported = await client.exportProject();
    expect(exported.ok, JSON.stringify(exported.error)).toBe(true);
    const text = readZipEntries(exported.bytes).filter(entry => entry.name.endsWith('.model'))
      .map(entry => new TextDecoder().decode(entry.content)).join('\n');
    return { bytes: exported.bytes, text };
  }
  const channels = ['paint_color', 'paint_supports', 'paint_seam', 'paint_fuzzy_skin'];

  it('reuses one session for slicing, Boolean, reslicing and a project roundtrip', async () => {
    const { request } = await pair();
    const sliceCurrent = async () => {
      const plate = await client.getPlateSessionSnapshot();
      const target = { plateId: plate.currentPlateId, inputRevision: plate.inputRevisions[plate.currentPlateId] };
      const result = await client.slicePlate(target, {});
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(client.getRuntimeExecutionState().sliceActive).toBe(false);
      return result.receipt;
    };
    const first = await sliceCurrent();
    const result = (await transaction(request)).result;
    expect(result.changed).toBe(true);
    const second = await sliceCurrent();
    expect(second.inputStamp).toBeGreaterThan(first.inputStamp);
    const project = await exportModels();
    expect((await client.loadProject(project.bytes, 'project', 'boolean-roundtrip.3mf')).ok).toBe(true);
    const restored = (await client.getModelMesh()).objects;
    expect(restored).toHaveLength(1);
    expect(Math.abs(volume(restored[0]) - 12718.75)).toBeLessThan(1);
  }, 120_000);

  it.each([
    ['union', false, 1, 12718.75], ['difference', false, 2, 4718.75],
    ['difference', true, 1, 4718.75], ['intersection', false, 2, 3281.25], ['intersection', true, 1, 3281.25],
  ])('%s deleteInput=%s produces geometry, one history entry and stable instances', async (operation, deleteInput, count, expected) => {
    const { object, a, b, request } = await pair();
    await client.addInstance(object.id);
    const beforeInstances = await instances();
    const before = await client.getModelStructure();
    const ab = bounds(await meshFor(a)), bb = bounds(await meshFor(b));
    const commit = await transaction({ ...request, operation, deleteInput });
    const result = commit.result;
    expect(result.changed).toBe(true);
    expect(result.objects[0].volumes).toHaveLength(count);
    expect(Math.abs(volume(await meshFor(result.volumeId)) - expected)).toBeLessThan(1);
    const expectedBounds = operation === 'difference' ? ab : Array.from({ length: 6 }, (_, i) =>
      (operation === 'union' ? i < 3 : i >= 3) ? Math.min(ab[i], bb[i]) : Math.max(ab[i], bb[i]));
    bounds(await meshFor(result.volumeId)).forEach((value, i) => expect(Math.abs(value - expectedBounds[i])).toBeLessThan(.01));
    expect(await instances()).toEqual(beforeInstances);
    expect(commit.status.undoEntries).toHaveLength(1);
    expect(commit.sceneDelta.volumeIds).toContain(result.volumeId);
    expect(result.objects[0].volumes.map(part => part.id)).not.toContain(a);
    expect(result.objects[0].volumes.some(part => part.id === b)).toBe(operation !== 'union' && !deleteInput);
    expect((await client.undoHistory()).ok).toBe(true);
    expect(await client.getModelStructure()).toEqual(before);
    const redo = await client.redoHistory();
    expect(redo.ok).toBe(true);
    expect(redo.context.selection.partIds).toEqual([result.volumeId]);
    expect((await client.getModelStructure()).objects).toEqual(result.objects);
    expect(await instances()).toEqual(beforeInstances);
  });

  it('bakes mirrored Part matrices into object-local geometry without changing instances', async () => {
    const { a, b, request } = await pair();
    const linear = [0, -1.1, 0, 0, -.9, 0, 0, 0, 0, 0, 1.3, 0];
    for (const [id, offset] of [[a, [-4, 2, 1]], [b, [-8.5, -6.25, 4.25]]]) {
      const mesh = await meshFor(id);
      expect((await client.setModelTransform(mesh.objectIdx, mesh.volumeIdx, mesh.instanceIdx,
        mesh.instanceTransform, { ...trs(), matrix: [...linear, ...offset, 1] })).ok).toBe(true);
    }
    const before = await instances();
    const result = await client.meshBoolean(request);
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    const mesh = await meshFor(result.volumeId);
    expect(Math.abs(volume(mesh) - 12718.75 * 1.287)).toBeLessThan(2);
    expect(mesh.volumeTransform.matrix.map(value => value || 0)).toEqual([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    expect(await instances()).toEqual(before);
  });

  it('Union replaces a later A at its original position and retains unrelated Parts', async () => {
    const { object } = await pair();
    await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id,
      volumeType: 'model_part', ext: 'stl', name: 'Later A' }, cube);
    const parts = (await client.getModelStructure()).objects[0].volumes;
    const retained = parts[1], source = parts[2];
    await client.setNativeScopedConfig({ scope: 'part', id: String(retained.id) }, 'wall_loops', '5');
    const before = await meshFor(retained.id);
    const result = await client.meshBoolean({ entry: 'gizmo', objectId: object.id,
      instanceId: object.instances[0].id, sourceVolumeId: source.id, toolVolumeId: parts[0].id,
      operation: 'union', deleteInput: false, keepPainting: false });
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    expect(result.objects[0].volumes.map(part => part.id)).toEqual([retained.id, result.volumeId]);
    expect(result.objects[0].volumes[1].name).toBe(`${source.name} - union`);
    const after = await meshFor(retained.id);
    expect(after.positions).toEqual(before.positions);
    expect(after.indices).toEqual(before.indices);
    expect(after.volumeTransform).toEqual(before.volumeTransform);
    const config = await client.getNativeScopedConfig();
    expect(config.nativeScopedConfig.snapshot.parts[String(retained.id)].wall_loops).toBe('5');
  });

  it('object entry consumes auxiliary volumes, preserves object config and invalidates every instance plate', async () => {
    const { object, a, request } = await pair('negative_volume');
    await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id, volumeType: 'support_blocker', shape: 'Cube' });
    expect((await client.setNativeScopedConfig({ scope: 'object', id: String(object.id) }, 'wall_loops', '7')).ok).toBe(true);
    expect((await client.setNativeScopedConfig({ scope: 'part', id: String(a) }, 'wall_loops', '3')).ok).toBe(true);
    const added = await client.addInstance(object.id);
    const plate = await client.addPlate();
    const secondPlate = plate.plates.at(-1);
    const mesh = (await client.getModelMesh()).objects.find(item => item.instanceId === added.instanceId && item.volumeId === a);
    await client.setModelTransform(mesh.objectIdx, mesh.volumeIdx, mesh.instanceIdx,
      trs([secondPlate.origin[0] + 50, secondPlate.origin[1] + 50, 10]), mesh.volumeTransform);
    await client.recomputePlateMembership();
    const before = await instances();
    const result = (await transaction({ entry: 'object', objectId: request.objectId, keepPainting: false })).result;
    expect(result.changed).toBe(true);
    expect(result.objects[0]).toMatchObject({ id: object.id, name: object.name });
    expect(result.objects[0].volumes).toEqual([expect.objectContaining({ id: result.volumeId, type: 'model_part' })]);
    expect(result.plateSession.affectedPlateIds).toHaveLength(2);
    expect(await instances()).toEqual(before);
    expect(Math.abs(volume(await meshFor(result.volumeId)) - 4718.75)).toBeLessThan(1);
    const scoped = await client.getNativeScopedConfig();
    expect(scoped.nativeScopedConfig.snapshot.objects[String(object.id)].wall_loops).toBe('7');
    expect(scoped.nativeScopedConfig.snapshot.parts[String(result.volumeId)] ?? {}).not.toHaveProperty('wall_loops');
  });

  it.each(['model_part', 'negative_volume', 'parameter_modifier', 'support_blocker', 'support_enforcer'])('allows %s as A and inherits its type/config', async type => {
    const { a, request } = await pair();
    await client.setVolumeType(a, type);
    if (type === 'model_part' || type === 'parameter_modifier')
      await client.setNativeScopedConfig({ scope: 'part', id: String(a) }, 'wall_loops', '4');
    const result = await client.meshBoolean(request);
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    expect(result.objects[0].volumes[0].type).toBe(type);
    if (type === 'model_part' || type === 'parameter_modifier') {
      const scoped = await client.getNativeScopedConfig();
      expect(scoped.nativeScopedConfig.snapshot.parts[String(result.volumeId)].wall_loops).toBe('4');
    }
  });

  it.each([false, true])('preserves partial painting in all four channels with mirror=%s', async mirror => {
    const entries = readZipEntries(await readFile(resolve(here, '../fixtures/painted-facet/painted-facet-instances.3mf')));
    let triangle = 0;
    for (const entry of entries) if (entry.name.endsWith('.model')) {
      entry.content = new TextEncoder().encode(new TextDecoder().decode(entry.content).replace(/<triangle\b[^>]*\/>/g, face => {
        const clean = face.replace(/\s+paint_color="[^"]*"/g, '');
        return triangle++ === 0 ? clean.replace('/>', ' paint_color="401" paint_supports="401" paint_seam="401" paint_fuzzy_skin="401"/>') : clean;
      }));
    }
    expect((await client.loadProject(writeStoredZip(entries), 'project', 'partial-boolean.3mf')).ok).toBe(true);
    const object = (await client.getModelStructure()).objects[0], a = object.volumes[0].id;
    const added = await client.addVolume({ objectId: object.id, instanceId: object.instances[0].id,
      volumeType: 'model_part', ext: 'stl', name: 'Disjoint B' }, cube);
    const source = await meshFor(a), tool = await meshFor(added.volumeId);
    await client.setModelTransform(source.objectIdx,source.volumeIdx,source.instanceIdx,source.instanceTransform,
      { ...trs(), scale: [1.3,.9,1.1], mirror: [mirror ? -1 : 1,1,1] });
    await client.setModelTransform(tool.objectIdx,tool.volumeIdx,tool.instanceIdx,tool.instanceTransform,trs([60,0,0]));
    const before = await client.getModelMesh(), sourceMatrix = (await meshFor(a)).volumeTransform.matrix;
    function moment(paint, matrix) {
      let area = 0; const weighted = [0,0,0];
      for (const group of paint.drawGroups) if (group.stateId === 1) for (let i = group.startIndex; i < group.startIndex + group.indexCount; i += 3) {
        const points = [...paint.indices.slice(i,i+3)].map(index => [0,1,2].map(axis =>
          matrix[axis]*paint.positions[index*3] + matrix[4+axis]*paint.positions[index*3+1] +
          matrix[8+axis]*paint.positions[index*3+2] + matrix[12+axis]));
        const [a,b,c] = points, ab = a.map((v,axis)=>b[axis]-v), ac = a.map((v,axis)=>c[axis]-v);
        const weight = Math.hypot(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])/2;
        area += weight; weighted.forEach((_,axis)=>{weighted[axis] += weight*(a[axis]+b[axis]+c[axis])/3;});
      }
      return { area, centroid: weighted.map(value=>value/area) };
    }
    const expected = moment(before.paintGeometries.find(paint=>paint.volumeId===a),sourceMatrix);
    expect(expected.area).toBeGreaterThan(0);
    const result = await client.meshBoolean({ entry: 'gizmo', objectId: object.id, instanceId: object.instances[0].id,
      sourceVolumeId: a, toolVolumeId: added.volumeId, operation: 'difference', deleteInput: true, keepPainting: true });
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    const after = await client.getModelMesh();
    const actual = moment(after.paintGeometries.find(paint=>paint.volumeId===result.volumeId), (await meshFor(result.volumeId)).volumeTransform.matrix);
    expect(Math.abs(actual.area-expected.area)/expected.area).toBeLessThan(.05);
    actual.centroid.forEach((value,axis)=>expect(Math.abs(value-expected.centroid[axis])).toBeLessThan(.2));
    const exported = await exportModels();
    const annotated = [...exported.text.matchAll(/<triangle\b[^>]*\/>/g)].map(match => channels.map(channel =>
      match[0].match(new RegExp(`${channel}="([^"]+)"`))?.[1] ?? '')).filter(values => values.some(Boolean));
    expect(annotated.length).toBeGreaterThan(0);
    for (const values of annotated) expect(new Set(values).size).toBe(1);
  }, 120_000);

  it('empty output and stale/cross-object operands leave model, plates and history unchanged', async () => {
    const { a, b, request } = await pair();
    const mesh = await meshFor(b);
    await client.setModelTransform(mesh.objectIdx, mesh.volumeIdx, mesh.instanceIdx, mesh.instanceTransform, trs([50, 0, 0]));
    await client.recomputePlateMembership();
    const before = await client.getModelStructure();
    const plates = await client.getPlateSessionSnapshot();
    const empty = await transaction({ ...request, operation: 'intersection' });
    expect(empty.result).toEqual({ ok: true, changed: false, warning: 'empty_result' });
    expect(empty.status.undoEntries).toHaveLength(0);
    expect(await client.getModelStructure()).toEqual(before);
    expect(await client.getPlateSessionSnapshot()).toEqual(plates);
    for (const invalid of [{ ...request, sourceVolumeId: 999999 }, { ...request, toolVolumeId: a }])
      expect((await client.meshBoolean(invalid)).ok).toBe(false);
    await client.addModel(cube, 'stl', 'Other object');
    const structure = await client.getModelStructure();
    expect((await client.meshBoolean({ ...request, toolVolumeId: structure.objects[1].volumes[0].id })).ok).toBe(false);
    expect(await client.getModelStructure()).toEqual(structure);
  });

  it.each([false, true])('keepPainting=%s preserves all four channels and roundtrips', async keepPainting => {
    const { object, a, request } = await pair('model_part', true);
    await client.setNativeScopedConfig({ scope: 'part', id: String(a) }, 'extruder', '2');
    const before = await instances();
    const result = (await transaction({ ...request, keepPainting })).result;
    expect(result.changed).toBe(true);
    const exported = await exportModels();
    for (const channel of channels) expect(exported.text.includes(`${channel}="`), channel).toBe(keepPainting);
    const scoped = await client.getNativeScopedConfig();
    expect(scoped.nativeScopedConfig.snapshot.parts[String(result.volumeId)].extruder).toBe('2');
    const expectedVolume = volume(await meshFor(result.volumeId));
    const worldBounds = (await client.getModelMesh()).objects.map(mesh => bounds(mesh, true));
    expect((await client.loadProject(exported.bytes, 'project', 'boolean-roundtrip.3mf')).ok).toBe(true);
    const restored = (await client.getModelStructure()).objects[0];
    expect(restored.name).toBe(object.name);
    expect(restored.instances).toHaveLength(before.length);
    expect(Math.abs(volume(await meshFor(restored.volumes[0].id)) - expectedVolume)).toBeLessThan(.01);
    const restoredBounds = (await client.getModelMesh()).objects.map(mesh => bounds(mesh, true));
    expect(restoredBounds).toHaveLength(worldBounds.length);
    restoredBounds.forEach((box, index) => box.forEach((value, i) => expect(Math.abs(value - worldBounds[index][i])).toBeLessThan(.01)));
    const roundtrip = await exportModels();
    for (const channel of channels) expect(roundtrip.text.includes(`${channel}="`), channel).toBe(keepPainting);
  }, 120_000);

  it.each(['union', 'difference', 'intersection'])('%s uses B painting only where Orca does', async operation => {
    const { a, b, request } = await pair('model_part', true);
    const result = await client.meshBoolean({ ...request, sourceVolumeId: b, toolVolumeId: a,
      operation, deleteInput: true, keepPainting: true });
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    const { text } = await exportModels();
    for (const channel of channels) expect(text.includes(`${channel}="`), channel).toBe(operation !== 'difference');
  }, 120_000);

  it.each([false, true])('object entry keepPainting=%s remaps positive Parts in object coordinates', async keepPainting => {
    const { object, a } = await pair('negative_volume', true);
    await client.setNativeScopedConfig({ scope: 'part', id: String(a) }, 'extruder', '2');
    const before = await instances();
    const result = await client.meshBoolean({ entry: 'object', objectId: object.id, keepPainting });
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    expect(await instances()).toEqual(before);
    const { text } = await exportModels();
    for (const channel of channels) expect(text.includes(`${channel}="`), channel).toBe(keepPainting);
    const scoped = await client.getNativeScopedConfig();
    expect(scoped.nativeScopedConfig.snapshot.parts[String(result.volumeId)] ?? {}).not.toHaveProperty('extruder');
  }, 120_000);

  it('keepPainting off leaves a retained B unchanged in every painting channel', async () => {
    const { a, b, request } = await pair('model_part', true);
    const paintedTriangles = text => text.match(/<triangle\b[^>]*(?:paint_color|paint_supports|paint_seam|paint_fuzzy_skin)=[^>]*\/>/g) ?? [];
    const before = paintedTriangles((await exportModels()).text);
    expect(before.length).toBeGreaterThan(0);
    const result = await client.meshBoolean({ ...request, sourceVolumeId: b, toolVolumeId: a,
      operation: 'difference', deleteInput: false, keepPainting: false });
    expect(result.ok && result.changed, JSON.stringify(result)).toBe(true);
    expect(result.objects[0].volumes.some(part => part.id === a)).toBe(true);
    expect(paintedTriangles((await exportModels()).text)).toEqual(before);
  }, 120_000);

  it.skipIf(!faults)('post-publication faults restore the original model and exact plate stamps', async () => {
    const { request } = await pair();
    const before = await client.getModelStructure(), plates = await client.getPlateSessionSnapshot(), matrices = await instances();
    const result = await client.meshBoolean({ ...request, testFailPublish: true });
    expect(result).toEqual({ ok: false, error: 'Injected Mesh Boolean publication failure' });
    expect(await client.getModelStructure()).toEqual(before);
    expect(await client.getPlateSessionSnapshot()).toEqual(plates);
    expect(await instances()).toEqual(matrices);
    expect((await client.meshBoolean(request)).ok).toBe(true);
  });
  it.skipIf(!faults)('empty combined mesh retains positive Parts with the native warning', async () => {
    const { object } = await pair('negative_volume');
    const result = await client.meshBoolean({ entry: 'object', objectId: object.id, keepPainting: false, testEmptyCombined: true });
    expect(result.ok && result.changed).toBe(true);
    expect(result.warning).toBe('positive_parts_only');
    expect(volume(await meshFor(result.volumeId))).toBeCloseTo(8000, 4);
  });
});
