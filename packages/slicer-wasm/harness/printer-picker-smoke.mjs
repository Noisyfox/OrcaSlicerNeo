// Real native model/variant matching with deterministic profile packages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const moduleArg = process.argv[2];
if (!moduleArg) throw new Error('usage: node harness/printer-picker-smoke.mjs <out/serial/orca_slice.js>');
const root = await mkdtemp(join(tmpdir(), 'orca-printer-picker-'));
const source = join(root, 'source');
const output = join(root, 'packages');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
try {
  await cp(resolve(import.meta.dirname, 'fixtures/compatibility-profiles'), source, { recursive: true });
  const vendorPath = join(source, 'CompatibilityFixture.json');
  const vendor = await readJson(vendorPath);
  for (const [family, variants] of [['alpha', ['0.6', '0.4HS', '0.4+0.6']], ['beta', ['0.6']]]) {
    const template = await readJson(join(source, `CompatibilityFixture/machine/${family}.json`));
    for (const variant of variants) {
      const name = `Compatibility ${family === 'alpha' ? 'Alpha' : 'Beta'} ${variant} nozzle`;
      const subPath = `machine/${family}-${variant}.json`;
      await writeJson(join(source, 'CompatibilityFixture', subPath), {
        ...template, name, alias: name, printer_variant: variant,
        nozzle_diameter: variant === '0.4+0.6' ? ['0.4', '0.6'] : [variant === '0.4HS' ? '0.4' : variant],
      });
      vendor.machine_list.push({ name, sub_path: subPath });
    }
    const modelPath = join(source, `CompatibilityFixture/machine-model/${family}.json`);
    const model = await readJson(modelPath);
    model.nozzle_diameter = ['0.4', ...variants].join(';');
    await writeJson(modelPath, model);
  }
  await writeJson(vendorPath, vendor);
  await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../../profile-resources/scripts/build.mjs')], {
    env: { ...process.env, ORCA_PROFILES_DIR: source, ORCA_PROFILE_OUTPUT: output },
  });
  const Module = await (await loadModuleFactory(moduleArg))({ noInitialRun: true, print: () => {}, printErr: () => {} });
  await installProfilePackages(Module, createNodeProfileSource(output));
  function call(name, types = [], args = []) {
    const ptr = Number(Module.ccall(name, 'number', types, args));
    try { return JSON.parse(Module.UTF8ToString(ptr)); } finally { Module._free(ptr); }
  }
  assert.equal(call('orc_init', ['string'], ['']).ok, true);
  const snapshot = () => call('orc_get_preset_snapshot');
  const select = name => {
    const receipt = call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({
      printer: name, remembered_rack: null, remembered_bed_type: null,
    })]);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.mutation.history_entry_delta, 1);
    assert.equal(receipt.profile_snapshot.printer.name, name);
    return receipt.profile_snapshot;
  };
  let current = select('Compatibility Alpha 0.4 nozzle');
  assert.deepEqual(current.printer_picker.items.map(item => item.label), ['Compatibility Alpha', 'Compatibility Beta']);
  assert.equal(current.printers.length, 6, 'grouping preserves the canonical candidate catalogue');
  assert.deepEqual(current.printer_picker.variants.map(item => item.value), ['0.4', '0.4+0.6', '0.4HS', '0.6']);
  for (const variant of ['0.6', '0.4HS', '0.4+0.6', '0.4']) {
    const target = current.printer_picker.variants.find(item => item.value === variant).preset;
    current = select(target);
    assert.equal(current.printer_picker.selected_variant, variant);
    assert.equal(current.printer_picker.items.find(item => item.id === current.printer_picker.selected_id).preset, target);
  }
  current = select('Compatibility Alpha 0.6 nozzle');
  const beta = current.printer_picker.items.find(item => item.label === 'Compatibility Beta');
  assert.equal(beta.preset, 'Compatibility Beta 0.6 nozzle', 'model selection retains the current variant');
  current = select(beta.preset);
  assert.equal(current.printer_picker.selected_variant, '0.6');
  current = select(current.printer_picker.items.find(item => item.label === 'Compatibility Alpha').preset);
  current = select(current.printer_picker.variants.find(item => item.value === '0.4HS').preset);
  assert.equal(current.printer_picker.items.find(item => item.label === 'Compatibility Beta').preset,
    'Compatibility Beta 0.4 nozzle', 'missing named variant uses native name-ordered fallback');
  const before = snapshot();
  const rejected = call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({
    printer: 'missing', remembered_rack: null, remembered_bed_type: null,
  })]);
  assert.equal(rejected.ok, false);
  assert.deepEqual(snapshot(), before);
  console.log('printer picker smoke OK: grouping, named/mixed variants, preserve/fallback, atomic transition, rejection');
} finally {
  await rm(root, { recursive: true, force: true });
}
