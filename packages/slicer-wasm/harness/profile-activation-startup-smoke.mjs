import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';

if (!process.argv[2]) throw new Error('usage: node profile-activation-startup-smoke.mjs <module.js>');
const source = resolve(import.meta.dirname, 'fixtures/compatibility-profiles');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const activation = { models: [{ vendor: 'CompatibilityFixture', model: 'Compatibility Alpha', nozzle_diameter: ['0.4'] }],
  filaments: ['Generic PLA @System', 'Excluded filament @Unselected'] };
async function start() {
  const Module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  const FS = Module.FS;
  async function copy(directory, target) {
    FS.mkdirTree(target);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await copy(join(directory, entry.name), `${target}/${entry.name}`);
      else FS.writeFile(`${target}/${entry.name}`, await readFile(join(directory, entry.name)));
    }
  }
  await copy(source, '/profiles'); FS.mkdirTree('/system'); FS.mkdirTree('/profiles/Unselected');
  FS.writeFile('/profiles/Unselected.json', '{invalid excluded vendor');
  const nativeOpens = [];
  const originalOpen = FS.open;
  FS.open = function(path, ...args) { nativeOpens.push(path); return originalOpen.call(this, path, ...args); };
  function call(name, types = [], args = []) {
    const ptr = Number(Module.ccall(name, 'number', types, args));
    try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
  }
  function init(record) {
    for (const vendor of ['CompatibilityFixture', 'OrcaFilamentLibrary', 'Unselected'])
      for (const suffix of ['.json', '']) { try { FS.unlink(`/system/${vendor}${suffix}`); } catch {} }
    for (const vendor of new Set(['OrcaFilamentLibrary', ...(record?.models.map(model => model.vendor) ?? [])])) {
      if (!FS.analyzePath(`/profiles/${vendor}.json`).exists) continue;
      FS.symlink(`/profiles/${vendor}.json`, `/system/${vendor}.json`);
      FS.symlink(`/profiles/${vendor}`, `/system/${vendor}`);
    }
    nativeOpens.length = 0;
    const result = call('orc_init', ['string'], [JSON.stringify({ log_level: 'error', profile_activation: record })]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(nativeOpens.some(path => typeof path === 'string' && path.includes('Unselected')), false,
      'filament names do not cause excluded vendor parsing');
    return result;
  }
  return { Module, call, init };
}
const session = await start();
for (const vendor of ['../bad', 'C:', ' ', 'bad\u0000vendor']) {
  const result = session.call('orc_init', ['string'], [JSON.stringify({ log_level: 'error', profile_activation:
    { models: [{ vendor, model: 'P', nozzle_diameter: ['0.4'] }], filaments: [] } })]);
  assert.notEqual(result.ok, true, 'unsafe vendor rejected by native init');
}

let initialized = session.init(null);
assert.equal(initialized.setupRequired, true); assert.equal(initialized.printers, 1, 'only built-in default printer');
assert.equal(initialized.filaments, 2, 'permanent library plus built-in default');
assert.deepEqual(session.call('orc_get_preset_snapshot').printers, []);
assert.notEqual(session.call('orc_select_preset', ['string', 'string'], ['printer', 'Compatibility Alpha 0.4 nozzle']).ok, true,
  'saved current printer cannot activate an excluded source vendor');
initialized = session.init(activation);
assert.equal(initialized.setupRequired, false); assert.equal(initialized.printers, 3, 'entire selected vendor parses');
assert.deepEqual(session.call('orc_get_preset_snapshot').printers.map(item => item.name), ['Compatibility Alpha 0.4 nozzle'],
  'only enabled model/nozzle is admitted');
const stale = { models: [{ vendor: 'CompatibilityFixture', model: 'Removed model', nozzle_diameter: ['0.4'] },
  { vendor: 'MissingVendor', model: 'Old model', nozzle_diameter: ['0.4'] }], filaments: ['Old PLA'] };
assert.equal(session.init(stale).setupRequired, true, 'stale records are not usable printers');
const recreated = await start();
assert.equal(recreated.init(activation).setupRequired, false, 'recreated runtime uses the saved activation');
assert.deepEqual(recreated.call('orc_get_preset_snapshot').printers.map(item => item.name), ['Compatibility Alpha 0.4 nozzle']);
console.log('profile activation startup smoke OK: permanent base, model visibility, excluded vendors, stale records, recreation');
