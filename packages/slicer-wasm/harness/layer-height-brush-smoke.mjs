import assert from 'node:assert/strict';
import { createMixedFilamentFixture } from './mixed-filament-fixture.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';

const { module, call } = await createMixedFilamentFixture(process.argv[2]);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };
ok(call('orc_add_shape', ['string', 'string'], ['Sphere', 'Brush fixture']));
const objectId = ok(call('orc_get_model_structure')).objects[0].id;
const plateId = ok(call('orc_get_plate_session_snapshot')).current_plate_id;
const send = (operation, args = {}) => call('orc_layer_height', ['string'], [JSON.stringify({ objectId, plateId, operation, ...args })]);
const read = () => ok(send('read')).profile;
const begin = () => ok(send('begin', { stamp: read().stamp })).strokeId;
function frame(operation, args) {
  const { profile, pointer, width, height, cells } = ok(send(operation, args));
  assert.ok(cells > 1 && cells <= (width - 1) * height);
  try {
    return { curve: profile.curve, pixels: module.HEAPU8.slice(pointer, pointer + width * height * 4) };
  } finally { module._free(pointer); }
}
const samples = [1, 1, 0, 2, 1, 3, 0].map((action, i) => ({ action, width: 2, z: i < 5 ? 10 : 10.25 }));
const initial = read();
const original = frame('preview');
let id = begin();
const batch = frame('samples', { strokeId: id, samples });
assert.notDeepEqual(batch.curve, original.curve);
assert.notDeepEqual(batch.pixels, original.pixels);
assert.deepEqual(read(), initial);
ok(send('cancel', { strokeId: id }));
assert.deepEqual(read(), initial);
assert.equal(send('finish', { strokeId: id }).ok === true, false);
id = begin();
frame('samples', { strokeId: id, samples: [{ z: 0, width: 2, action: 1 }] });
assert.equal(ok(send('finish', { strokeId: id })).changed, false);
assert.equal(read().hasSavedCurve, false);
id = begin();
let single;
for (const sample of samples) single = frame('samples', { strokeId: id, samples: [sample] });
assert.deepEqual(single, batch);
assert.ok(ok(send('finish', { strokeId: id })).changed);
assert.deepEqual(frame('preview'), batch);
id = begin();
ok(setNativeScopedConfig(call, 'project', undefined, 'initial_layer_print_height', '0.24'));
assert.equal(send('finish', { strokeId: id }).ok === true, false);
assert.equal(read().firstHeight, 0.24);
console.log('PASS ordered native brush, stationary samples, texture replay, cancel, no-op, stale and commit');
process.exit(0);
