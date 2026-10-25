import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { createNodeProfileSource, installProfilePackages, fixtureProfileOptions } from './profile-installer.mjs';
import { buildPaintedFacetProject } from './painted-facet-fixture-builder.mjs';

/** Real native fixture shared by projection, mutation, slice and persistence gates. */
export async function createNozzleMappingFixture(modulePath) {
  const Module = await (await loadModuleFactory(modulePath))({ noInitialRun: true, print: () => {}, printErr: console.error });
  await installProfilePackages(Module, createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')));
  const call = (name, types = [], args = []) => {
    const pointer = Number(Module.ccall(name, 'number', types, args));
    try { return JSON.parse(Module.UTF8ToString(pointer)); } finally { Module._free(pointer); }
  };
  const command = (name, value) => call(name, ['string'], [JSON.stringify(value)]);
  const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
  const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: null, gizmo: null, nativeScopedConfig: {} };
  ok(call('orc_init', ['string'], [fixtureProfileOptions(Module)]));
  async function reset() {
    const bytes = await buildPaintedFacetProject();
    const pointer = Number(Module._malloc(bytes.length));
    Module.HEAPU8.set(bytes, pointer);
    try { ok(call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'nozzle-mapping.3mf'])); }
    finally { Module._free(pointer); }
    ok(call('orc_select_preset', ['string', 'string'], ['printer', 'Bambu Lab H2D 0.4 nozzle']));
    assert.equal(command('orc_history_reset', context).dirty, false);
    return ok(call('orc_get_plate_session_snapshot')).current_plate_id;
  }
  const plateId = await reset();
  const projection = id => call('orc_get_nozzle_mapping', ['string'], [id]);
  const configure = values => ok(command('orc_test_set_filament_reference_fixture', values));
  const observe = () => ({
    mappingInputs: configure({ read_mapping_inputs: true }).mapping_inputs,
    filament: ok(call('orc_get_filament_session_snapshot')),
    history: call('orc_history_status'),
    model: ok(call('orc_get_model_structure')),
    plates: ok(call('orc_get_plate_session_snapshot')),
    config: call('orc_get_native_scoped_config'),
  });
  return { Module, call, command, ok, context, reset, plateId, projection, configure, observe };
}
