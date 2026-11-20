import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import {
  createNodeProfileSource,
  fixtureProfileOptions,
  installProfilePackages,
} from './profile-installer.mjs';

export async function createMixedFilamentFixture(modulePath) {
  const factory = await loadModuleFactory(resolve(modulePath));
  const module = await factory({ noInitialRun: true, print() {}, printErr() {} });
  function call(name, types = [], args = []) {
    const ptr = Number(module.ccall(name, 'number', types, args));
    try {
      return JSON.parse(module.UTF8ToString(ptr));
    } finally {
      module._free(ptr);
    }
  }
  await installProfilePackages(
    module,
    createNodeProfileSource(resolve(import.meta.dirname, '../../profile-resources/dist')),
  );
  assert.equal(call('orc_init', ['string'], [fixtureProfileOptions(module)]).ok, true);
  const printer = call('orc_get_preset_snapshot').printers.find((p) =>
    p.name.includes('Bambu Lab P1P 0.4 nozzle'),
  );
  assert.equal(call('orc_select_preset', ['string', 'string'], ['printer', printer.name]).ok, true);
  const rack = () => call('orc_get_filament_session_snapshot');
  const run = (name, fields = {}) =>
    call(name, ['string'], [JSON.stringify({ version: 1, revision: rack().revisions.session, ...fields })]);
  function edit(name, fields) {
    const r = run(name, fields);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.mutation.history_entry_delta, 1);
    return r.result.snapshot;
  }
  while (rack().slots.length < 2) edit('orc_add_filament_slot');
  return { module, call, rack, run, edit, printer };
}
