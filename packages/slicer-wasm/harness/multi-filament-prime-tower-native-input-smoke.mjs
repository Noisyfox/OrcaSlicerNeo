// Focused Step 11 native-input smoke. This loads a real MM-painted project
// archive, then checks PartPlate-equivalent used-filament inputs, By Object
// visibility, routing fallbacks, custom tool changes, and rib dimensions.
import assert from 'node:assert/strict';
import { argv } from 'node:process';
import { resolve } from 'node:path';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { setNativeScopedConfig } from './native-scoped-command.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const opts = {};
for (let i = 2; i < argv.length; i += 2) opts[argv[i]?.replace(/^--/, '')] = argv[i + 1];
if (!opts.module) throw new Error('usage: node multi-filament-prime-tower-native-input-smoke.mjs --module out/threaded/orca_slice.js');
const root = resolve(import.meta.dirname, '../../..');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function textEntry(entries, name) {
  const entry = entries.find((item) => item.name === name);
  assert.ok(entry, `archive is missing ${name}`);
  return decoder.decode(entry.content);
}

function buildPaintedProject() {
  const entries = readZipEntries(buildIndependentReader3mf());
  const model = textEntry(entries, '3D/3dmodel.model')
    .replace('transform="1 0 0 0 1 0 0 0 1 0 0 10"', 'transform="1 0 0 0 1 0 0 0 1 100 100 10"');
  // FacetsAnnotation values 4 and 8 encode deterministic Extruder1/2 paint.
  const paintStates = ['4', '8', '4', '8', '4', '8', '4', '8', '4', '8', '4', '8'];
  let triangle = 0;
  const paintedModel = model.replace(/<triangle\b[^>]*\/>/g, (source) =>
    source.replace('/>', ` paint_color="${paintStates[triangle++]}"/>`));
  assert.equal(triangle, paintStates.length);

  const project = JSON.parse(textEntry(entries, 'Metadata/project_settings.config'));
  Object.assign(project, {
    printer_settings_id: 'Bambu Lab H2D 0.4 nozzle', printer_model: 'Bambu Lab H2D',
    filament_settings_id: ['Generic PLA @Project', 'Generic PETG @Project', 'Generic PLA @Project', 'Generic PETG @Project'],
    filament_colour: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
    filament_multi_colour: ['', '', '', ''], filament_colour_type: ['RGB', 'RGB', 'RGB', 'RGB'],
    filament_map: ['1', '1', '1', '1'], filament_volume_map: ['0', '0', '0', '0'],
    filament_nozzle_map: ['0', '0', '0', '0'], filament_map_2: ['1', '1', '1', '1'],
    filament_self_index: ['0', '0', '0', '0'], filament_extruder_variant: ['0', '0', '0', '0'],
    flush_volumes_matrix: ['0', '100', '110', '120', '100', '0', '130', '140',
      '110', '130', '0', '150', '120', '140', '150', '0'],
  });
  const modelSettings = textEntry(entries, 'Metadata/model_settings.config')
    .replace('filament_maps" value="1 1"', 'filament_maps" value="2 1 1 1"')
    .replace('filament_volume_maps" value="0 0"', 'filament_volume_maps" value="0 0 0 0"')
    .replace('filament_nozzle_maps" value="0 0"', 'filament_nozzle_maps" value="0 0 0 0"')
    .replace('</plate>', '<filament id="3" tray_info_idx="PLA-BLUE" type="PLA" color="#0000FF" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/><filament id="4" tray_info_idx="PETG-YELLOW" type="PETG" color="#FFFF00" used_m="0" used_g="0" group_id="0" nozzle_diameter="0.4" volume_type="Standard" used_for_object="true" used_for_support="false"/></plate>');
  const layerGcode = `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
  <plate><plate_info id="1"/><layer top_z="0.2" type="2" extruder="2" color="#00FF00" extra="" gcode="tool_change"/><layer top_z="0.4" type="2" extruder="4" color="#FFFF00" extra="" gcode="tool_change"/><mode value="MultiExtruder"/></plate>
</custom_gcodes_per_layer>
`;
  const filamentEntries = [1, 2, 3, 4].map((index) => {
    const source = JSON.parse(textEntry(entries, `Metadata/filament_settings_${index <= 2 ? index : index - 2}.config`));
    source.name = project.filament_settings_id[index - 1]; source.filament_settings_id = [source.name];
    source.filament_colour = [project.filament_colour[index - 1]];
    return { name: `Metadata/filament_settings_${index}.config`, content: encoder.encode(JSON.stringify(source)) };
  });
  return writeStoredZip(entries
    .filter((entry) => !['3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/project_settings.config',
      'Metadata/custom_gcode_per_layer.xml', 'Metadata/filament_settings_1.config', 'Metadata/filament_settings_2.config',
      'Metadata/filament_settings_3.config', 'Metadata/filament_settings_4.config'].includes(entry.name))
    .concat([
      { name: '3D/3dmodel.model', content: encoder.encode(paintedModel) },
      { name: 'Metadata/model_settings.config', content: encoder.encode(modelSettings) },
      { name: 'Metadata/project_settings.config', content: encoder.encode(JSON.stringify(project)) },
      { name: 'Metadata/custom_gcode_per_layer.xml', content: encoder.encode(layerGcode) },
      ...filamentEntries,
    ]));
}

const Module = await (await loadModuleFactory(resolve(opts.module)))({ noInitialRun: true, print: () => {}, printErr: () => {} });
await installProfilePackages(Module, createNodeProfileSource(resolve(opts['profile-root'] ?? `${root}/packages/profile-resources/dist`)));
function callJson(name, types = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', types, args));
  const result = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr); return result;
}
function setProject(key, value) {
  const result = setNativeScopedConfig(callJson, 'project', undefined, key, value);
  assert.equal(result.ok, true, JSON.stringify(result));
}
const init = callJson('orc_init', ['string'], ['']);
assert.equal(init.ok, true, JSON.stringify(init));
const archive = buildPaintedProject();
const pointer = Module._malloc(archive.byteLength); Module.HEAPU8.set(archive, pointer);
const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, archive.byteLength, 0, 'prime-tower-painted.3mf']);
Module._free(pointer); assert.equal(loaded.ok, true, JSON.stringify(loaded));

setProject('enable_prime_tower', '1'); setProject('prime_tower_width', '25'); setProject('wipe_tower_wall_type', 'rectangle');
setProject('print_sequence', 'by object');
for (const key of ['support_filament', 'support_interface_filament', 'outer_wall_filament_id', 'inner_wall_filament_id',
  'sparse_infill_filament_id', 'internal_solid_filament_id', 'top_surface_filament_id', 'bottom_surface_filament_id']) setProject(key, '0');
setProject('enable_support', '0'); setProject('raft_layers', '0');
let projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, true, JSON.stringify(projection));
assert.deepEqual(projection.plates[0].used_slots, [1, 2, 4], 'painted slots plus custom tool change');

// Native feature/support routing adds the remaining slot through the exact
// fallback families used by PartPlate::get_extruders(true).
setProject('enable_support', '1'); setProject('support_filament', '4'); setProject('support_interface_filament', '3');
setProject('outer_wall_filament_id', '2'); setProject('inner_wall_filament_id', '2');
setProject('sparse_infill_filament_id', '3'); setProject('internal_solid_filament_id', '3');
setProject('top_surface_filament_id', '4'); setProject('bottom_surface_filament_id', '4');
projection = callJson('orc_get_prime_tower_projection');
assert.deepEqual(projection.plates[0].used_slots, [1, 2, 3, 4]);
setProject('wipe_tower_wall_type', 'rib');
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].width, projection.plates[0].depth, 'rib width uses native estimated depth');

// One printable instance is the native By Object allowance; adding another
// printable instance hides the proxy even though the painted slots remain.
const object = callJson('orc_get_model_structure').objects[0];
assert.equal(object.instanceCount, 1);
const added = callJson('orc_add_instance', ['number'], [object.id]);
assert.equal(added.ok, true, JSON.stringify(added));
assert.equal(callJson('orc_set_instance_printable', ['number', 'number'], [added.instanceId, 1]).ok, true);
assert.equal(callJson('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'], [0, 1, 100, 100, 10]).ok, true);
assert.equal(callJson('orc_recompute_plate_membership').ok, true);
projection = callJson('orc_get_prime_tower_projection');
assert.equal(projection.plates[0].eligible, false, JSON.stringify(projection));
console.log(JSON.stringify({ ok: true, paintedAndCustomSlots: [1, 2, 4], routedSlots: [1, 2, 3, 4], byObject: 'one-visible-two-hidden' }));
