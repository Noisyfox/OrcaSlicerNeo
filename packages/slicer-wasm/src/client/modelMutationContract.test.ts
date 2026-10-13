import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { ModelMutationResult, ModelObjectStructure, SlicerClient } from './types';

type Operation = {
  name: string;
  fields: string[];
  invoke: (client: SlicerClient, objects: ModelObjectStructure[]) => Promise<ModelMutationResult>;
};
const operations: Operation[] = [
  { name: 'orc_add_model', fields: ['objects', 'instances'], invoke: c => c.addModel(new Uint8Array(4), 'stl') },
  { name: 'orc_add_shape', fields: ['objects', 'instances'], invoke: c => c.addShape('Cube') },
  { name: 'orc_clear_model', fields: [], invoke: c => c.clearModel() },
  { name: 'orc_delete_objects', fields: ['objects', 'deleted'], invoke: (c, o) => c.deleteObjects([o[0].id]) },
  { name: 'orc_delete_volumes', fields: ['objects', 'deleted'], invoke: (c, o) => c.deleteVolumes([o[0].volumes[0].id]) },
  { name: 'orc_add_volume', fields: ['volumeId'], invoke: (c, o) => c.addVolume({ objectId: o[0].id, instanceId: o[0].instances[0].id, volumeType: 'model_part', shape: 'Cube' }) },
  { name: 'orc_clone_objects', fields: ['objects', 'newObjectIds'], invoke: (c, o) => c.cloneObjects([o[0].id]) },
  { name: 'orc_reorder_objects', fields: ['objects'], invoke: (c, o) => c.reorderObjects(o[0].id, 0) },
  { name: 'orc_reorder_volumes', fields: ['objects'], invoke: (c, o) => c.reorderVolumes(o[0].id, o[0].volumes[0].id, 0) },
  { name: 'orc_split_volume_to_parts', fields: ['parts', 'newVolumeIds', 'objects'], invoke: (c, o) => c.splitVolumeToParts(o[0].volumes[0].id) },
  { name: 'orc_split_object_to_objects', fields: ['objects', 'newObjectIds'], invoke: (c, o) => c.splitObjectToObjects(o[0].id) },
  { name: 'orc_merge_objects_to_multipart', fields: ['objects', 'objectId'], invoke: (c, o) => c.mergeObjectsToMultipart(o.map(object => object.id), 'merged') },
  { name: 'orc_instances_to_separate_objects', fields: ['objects', 'newObjectIds'], invoke: (c, o) => c.separateInstances(o[0].id, [o[0].instances[1].id]) },
  { name: 'orc_add_instance', fields: ['objectId', 'instanceId'], invoke: (c, o) => c.addInstance(o[0].id) },
  { name: 'orc_remove_instance', fields: [], invoke: (c, o) => c.removeInstance(o[0].id, o[0].instances[1].id) },
  { name: 'orc_set_volume_type', fields: [], invoke: (c, o) => c.setVolumeType(o[0].volumes[0].id, 'model_part') },
  { name: 'orc_set_object_printable', fields: [], invoke: (c, o) => c.setObjectPrintable(o[0].id, true) },
  { name: 'orc_set_instance_printable', fields: [], invoke: (c, o) => c.setInstancePrintable(o[0].instances[0].id, true) },
];

async function run(operation: Operation, rewrite?: (payload: Record<string, any>) => void) {
  const module = createMockModule({ volumeCount: 2, instanceCount: 2, splitParts: 2 });
  const client = createClient(async () => module);
  await client.addModel(new Uint8Array(4), 'stl');
  await client.addModel(new Uint8Array(4), 'stl');
  const { objects } = await client.getModelStructure();
  const ccall = module.ccall;
  module.ccall = (name, ret, types, args) => {
    const pointer = ccall(name, ret, types, args);
    if (name !== operation.name || !rewrite) return pointer;
    const payload = JSON.parse(module.UTF8ToString(Number(pointer)));
    module._free(Number(pointer));
    rewrite(payload);
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const replacement = module._malloc(bytes.length + 1);
    module.HEAPU8.set(bytes, replacement);
    module.HEAPU8[replacement + bytes.length] = 0;
    return replacement;
  };
  return operation.invoke(client, objects);
}

describe.each(operations)('$name success contract', operation => {
  it('accepts the native-shaped receipt, including unchanged reorder/printability', async () => {
    const result = await run(operation);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.plateSession.nativeScopedConfig.kind).toBe('full');
    expect(result).not.toHaveProperty('plate_session');
  });
  it.each([undefined, null, {}, { ok: false, error: 'invalid plate mutation' }])('rejects a missing or invalid plate receipt: %j', async receipt => {
    const result = await run(operation, payload => { payload.plate_session = receipt; });
    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });
  it.each(operation.fields)('rejects an omitted success field %s', async field => {
    expect(await run(operation, payload => { delete payload[field]; })).toEqual({ ok: false, error: 'invalid model mutation details' });
  });
});

describe('complete model plate invalidation receipt', () => {
  const clear = operations.find(operation => operation.name === 'orc_clear_model')!;
  it.each(['instance_transforms', 'input_revisions', 'affected_plate_ids_before', 'affected_plate_ids_after', 'affected_plate_ids', 'dirty_reasons', 'native_scoped_config'])(
    'rejects missing %s', async field => {
      expect(await run(clear, payload => { delete payload.plate_session[field]; })).toMatchObject({ ok: false });
    },
  );
  it.each([{}, { invalid: -1 }, { invalid: '1' }])('rejects incomplete or invalid revisions: %j', async revisions => {
    expect(await run(clear, payload => { payload.plate_session.input_revisions = revisions; })).toMatchObject({ ok: false });
  });
  it.each([-1, 1.5, '1', null])('does not coerce invalid deletion counts: %j', async count => {
    expect(await run(operations[3], payload => { payload.deleted = count; })).toMatchObject({ ok: false });
  });
  it.each([0, -1, 1.5, '1', null])('rejects an invalid generated ID: %j', async id => {
    const clone = operations.find(operation => operation.name === 'orc_clone_objects')!;
    expect(await run(clone, payload => { payload.newObjectIds = [id]; })).toMatchObject({ ok: false });
  });
  it('rejects malformed structural objects instead of returning them as typed structures', async () => {
    const reorder = operations.find(operation => operation.name === 'orc_reorder_objects')!;
    expect(await run(reorder, payload => { payload.objects[0].volumes[0].type = 'invented'; })).toMatchObject({ ok: false });
  });
  it('preserves an explicit native failure', async () => {
    expect(await run(clear, payload => { payload.ok = false; payload.error = 'native failed'; })).toEqual({ ok: false, error: 'native failed' });
  });
  it('accepts an empty scene and an unsplit success with no generated IDs', async () => {
    const client = createClient(async () => createMockModule());
    expect(await client.clearModel()).toMatchObject({ ok: true, plateSession: { instances: [], affectedPlateIds: [] } });
    const split = operations.find(operation => operation.name === 'orc_split_volume_to_parts')!;
    for (const parts of [0, 1]) {
      expect(await run(split, payload => { payload.parts = parts; payload.newVolumeIds = []; })).toMatchObject({ ok: true });
    }
  });
});
