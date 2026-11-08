// Real U1 G-code thumbnail encoding, task ownership and immutable result coverage.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createNozzleMappingFixture } from './nozzle-mapping-fixtures.mjs';
import { awaitAsyncTask, exportGcode } from './async-task-mailbox.mjs';

const { Module, call, command, ok, context, projection } = await createNozzleMappingFixture(process.argv[2]);
ok(call('orc_clear_model'));
ok(command('orc_select_printer_with_remembered_rack', { printer: 'Snapmaker U1 (0.4 nozzle)',
  remembered_rack: null, remembered_bed_type: null, history_context: context }));
let rack = ok(call('orc_get_filament_session_snapshot'));
while (rack.slots.length > 1) {
  rack = ok(command('orc_delete_filament_slot', { version: 1, revision: rack.revisions.session,
    slot: rack.slots.length })).result.snapshot;
}
rack = ok(command('orc_select_filament_slot_preset', { version: 1, revision: rack.revisions.session,
  slot: 1, preset: 'Generic PLA @U1 0.4 nozzle' })).result.snapshot;
ok(call('orc_add_shape', ['string', 'string'], ['Cube', 'Neo thumbnail acceptance']));
const session = ok(call('orc_get_plate_session_snapshot'));
const plateId = session.current_plate_id;
const mapping = ok(projection(plateId));
ok(command('orc_mutate_nozzle_mapping', { plateId, revision: call('orc_history_status').revision,
  plateRevision: mapping.revision, history_context: context,
  change: { kind: 'mapping', mode: 2, filamentMap: ok(call('orc_get_filament_session_snapshot')).slots.map(() => 1) } }));
const pixels = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
const pointer = Number(Module._malloc(pixels.length));
Module.HEAPU8.set(pixels, pointer);
const config = { enable_prime_tower: '0', layer_height: '0.3', initial_layer_print_height: '0.3',
  thumbnails: '48x48/PNG, 300x300/PNG, 120x80/PNG' };
const accepted = call('orc_slice_plate', ['string', 'string', 'number', 'string'], [JSON.stringify(config), plateId,
  ok(projection(plateId)).revision, JSON.stringify({ width: 2, height: 2, pixels_ptr: pointer, pixels_length: pixels.length })]);
// An asynchronous task must own its source before the caller frees/reuses the heap.
Module.HEAPU8.fill(0, pointer, pointer + pixels.length);
Module._free(pointer);
const result = ok(await awaitAsyncTask(call, accepted));
const output = ok(exportGcode(call, { receipt: result.receipt, filenameBase: 'Neo thumbnail acceptance' }));
const bytes = Module.FS.readFile(output.path);
const text = new TextDecoder().decode(bytes);
const blocks = [...text.matchAll(/; thumbnail begin (\d+)x(\d+) (\d+)\n([\s\S]*?); thumbnail end/g)];
assert.deepEqual(blocks.map(block => [Number(block[1]), Number(block[2])]), [[48, 48], [300, 300], [120, 80]]);
for (const block of blocks) {
  const encoded = block[4].split('\n').map(line => line.replace(/^; /, '')).join('');
  assert.equal(encoded.length, Number(block[3]));
  const png = Buffer.from(encoded, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), compressed = [];
  assert.deepEqual([width, height], [Number(block[1]), Number(block[2])]);
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  // Orca's miniz thumbnail encoder emits unfiltered RGBA scanlines.
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * 4 + 1;
  for (let row = 0; row < height; row++) assert.equal(raw[row * stride], 0);
  const centre = Math.floor(width / 2) * 4 + 1;
  assert.deepEqual([...raw.subarray(centre, centre + 4)], [0, 0, 255, 255], 'PNG flips bottom-up source rows');
  assert.deepEqual([...raw.subarray((height - 1) * stride + centre, (height - 1) * stride + centre + 4)], [255, 0, 0, 255]);
  if (width !== height) assert.deepEqual([...raw.subarray(1, 5)], [0, 0, 0, 0], 'rectangular targets preserve the source aspect ratio');
  if (process.argv[3]) {
    await mkdir(resolve(process.argv[3]), { recursive: true });
    await writeFile(resolve(process.argv[3], `${width}x${height}.png`), png);
  }
}
const again = ok(exportGcode(call, { receipt: result.receipt, filenameBase: 'Other name' }));
assert.equal(again.path, output.path);
assert.deepEqual(Module.FS.readFile(again.path), bytes, 'export reuses the immutable thumbnail-bearing result');
if (process.argv[3]) await writeFile(resolve(process.argv[3], 'thumbnail-acceptance.gcode'), bytes);
const invalid = call('orc_slice_plate', ['string', 'string', 'number', 'string'], ['{}', plateId,
  ok(projection(plateId)).revision, JSON.stringify({ width: 1, height: 1, pixels_ptr: 0, pixels_length: 4 })]);
assert.notEqual(invalid.ok, true);
assert.match(invalid.error, /thumbnail/);
console.log('PASS U1 G-code embeds configured PNG sizes, fits rectangular images, owns asynchronous pixels and preserves retained exports');
process.exit(0);
