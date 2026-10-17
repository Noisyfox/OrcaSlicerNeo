import { fixtureProfileOptions } from './profile-installer.mjs';
// Real native model/variant matching with deterministic profile packages.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';
import { buildIndependentReader3mf } from './multi-filament-fixture-builder.mjs';
import { readZipEntries, writeStoredZip } from './native-3mf-parser.mjs';

const editingContext = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };

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
  for (const [family, variants] of [['alpha', ['0.6', '0.4HS', '0.4+0.4', '0.4+0.6']], ['beta', ['0.6']]]) {
    const template = await readJson(join(source, `CompatibilityFixture/machine/${family}.json`));
    for (const variant of variants) {
      const name = `Compatibility ${family === 'alpha' ? 'Alpha' : 'Beta'} ${variant} nozzle`;
      const subPath = `machine/${family}-${variant}.json`;
      await writeJson(join(source, 'CompatibilityFixture', subPath), {
        ...template, name, alias: name, printer_variant: variant,
        nozzle_diameter: variant === '0.4HS' ? ['0.4'] : variant.split('+'),
      });
      vendor.machine_list.push({ name, sub_path: subPath });
    }
    const modelPath = join(source, `CompatibilityFixture/machine-model/${family}.json`);
    const model = await readJson(modelPath);
    model.nozzle_diameter = ['0.4', ...variants].join(';');
    await writeJson(modelPath, model);
  }
  // Deliberately broad native variant strings make each policy gate observable.
  const alphaPath = join(source, 'CompatibilityFixture/machine/alpha.json');
  const alpha = await readJson(alphaPath);
  alpha.extruder_variant_list = ['Direct Drive Standard;Direct Drive High Flow;Direct Drive TPU High Flow;Direct Drive E3D High Flow;Direct Drive Extra High Flow'];
  alpha.extruder_max_nozzle_count = ['2'];
  await writeJson(alphaPath, alpha);
  // Preserve hand-written short lists: SEMM profiles do not normalize physical
  // extruder vectors. These are loaded through the real native profile loader.
  for (const [file, drives, variants, defaults] of [
    ['beta.json', ['Direct Drive', 'Direct Drive'], ['Direct Drive Standard', 'Direct Drive Standard'], ['Standard']],
    ['alpha-0.4+0.6.json', ['Direct Drive', 'Direct Drive'], ['Direct Drive Standard'], ['Standard', 'Standard']],
    ['alpha-0.4HS.json', ['Direct Drive'], ['Direct Drive Standard', 'Direct Drive Standard'], ['Standard', 'Standard']],
    ['beta-0.6.json', ['Direct Drive', 'Bowden'], ['Direct Drive Standard', 'Bowden Standard'], ['Standard', 'Standard']],
  ]) {
    const path = join(source, 'CompatibilityFixture/machine', file);
    const profile = await readJson(path);
    await writeJson(path, { ...profile, single_extruder_multi_material: '1', nozzle_diameter: file === 'alpha-0.4+0.6.json' ? profile.nozzle_diameter : ['0.4', '0.4'],
      extruder_type: drives, extruder_variant_list: variants, default_nozzle_volume_type: defaults,
      extruder_max_nozzle_count: file === 'beta.json' ? [] : ['2'] });
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
  assert.equal(call('orc_init', ['string'], [fixtureProfileOptions(Module)]).ok, true);
  const snapshot = () => call('orc_get_preset_snapshot');
  const select = name => {
    const receipt = call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ history_context: editingContext,
      printer: name, remembered_rack: null, remembered_bed_type: null,
    })]);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.mutation.history_entry_delta, 1);
    assert.equal(receipt.profile_snapshot.printer.name, name);
    return receipt.profile_snapshot;
  };
  let current = select('Compatibility Alpha 0.4 nozzle');
  assert.deepEqual(current.printer_picker.items.map(item => item.label), ['Compatibility Alpha', 'Compatibility Beta']);
  assert.equal(current.printers.length, 7, 'grouping preserves the canonical candidate catalogue');
  assert.deepEqual(current.printer_picker.variants.map(item => item.value), ['0.4', '0.4+0.4', '0.4+0.6', '0.4HS', '0.6']);
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
  const rejected = call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({ history_context: editingContext,
    printer: 'missing', remembered_rack: null, remembered_bed_type: null,
  })]);
  assert.equal(rejected.ok, false);
  assert.deepEqual(snapshot(), before);
  current = select('Compatibility Alpha 0.4 nozzle');
  const draft = call('orc_get_preset_draft', ['string', 'string'], ['printer', current.printer.name]);
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const customized = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({ history_context: editingContext,
    action: 'set', kind: 'printer', canonical_name: current.printer.name,
    expected_revision: draft.revision, key: 'nozzle_diameter', value: '0.5',
  })]);
  assert.equal(customized.ok, true, JSON.stringify(customized));
  const customizedPicker = snapshot().printer_picker;
  assert.equal(customizedPicker.selected_variant, '0.4',
    'the unified selector retains the profile variant after a nozzle draft edit');
  assert.deepEqual(customizedPicker.variants, current.printer_picker.variants,
    'physical nozzle edits cannot add phantom or disabled profile variants');
  const setDiameter = (index, diameter, revision) => call('orc_set_toolhead_diameter', ['string'],
    [JSON.stringify({ history_context: editingContext, index, diameter, expected_revision: revision })]);
  const singleHead = snapshot();
  assert.equal(setDiameter(1, 0.5, customized.revision_after).ok, false);
  assert.deepEqual(snapshot(), singleHead, 'editing a second head cannot resize a single-head profile');
  // Physical index cardinality comes from the source profile, not a draft value.
  current = select('Compatibility Alpha 0.4+0.4 nozzle');
  const toolheadDraft = call('orc_get_preset_draft', ['string', 'string'], ['printer', current.printer.name]);
  assert.equal(toolheadDraft.ok, true, JSON.stringify(toolheadDraft));
  assert.equal(toolheadDraft.editor_vectors.nozzle_diameter.index_count, 2);
  const customizedHead = setDiameter(1, 0.5, toolheadDraft.revision);
  assert.equal(customizedHead.ok, true, JSON.stringify(customizedHead));
  assert.equal(customizedHead.profile_snapshot.project_config.nozzle_diameter, '0.4,0.5');
  assert.equal(customizedHead.profile_snapshot.printer_picker.selected_variant, '0.4+0.4');
  assert.deepEqual(customizedHead.profile_snapshot.printer_picker.variants, current.printer_picker.variants,
    'customizing one head of a uniform profile cannot add a disabled mixed variant');
  const mixed = setDiameter(1, 0.6, customizedHead.history_status.revision);
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  assert.equal(mixed.profile_snapshot.printer.name, 'Compatibility Alpha 0.4+0.6 nozzle');
  assert.equal(mixed.profile_snapshot.project_config.nozzle_diameter, '0.4,0.6');
  assert.equal(mixed.mutation.kind, 'set-toolhead-diameter');
  assert.equal(mixed.mutation.history_entry_delta, 1);
  assert.equal(mixed.history_status.revision, customizedHead.history_status.revision + 1);
  const custom = setDiameter(0, 0.6, mixed.history_status.revision);
  assert.equal(custom.ok, true, JSON.stringify(custom));
  assert.equal(custom.profile_snapshot.printer.name, mixed.profile_snapshot.printer.name,
    'a one-nozzle 0.6 profile cannot match a two-nozzle vector');
  assert.equal(custom.profile_snapshot.project_config.nozzle_diameter, '0.6,0.6');
  assert.deepEqual(custom.profile_snapshot.printer_picker.variants, mixed.profile_snapshot.printer_picker.variants);
  assert.equal(custom.profile_snapshot.printer_picker.selected_variant, '0.4+0.6');
  assert.equal(custom.mutation.history_entry_delta, 1);
  const reversed = setDiameter(1, 0.4, custom.history_status.revision);
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.equal(reversed.profile_snapshot.project_config.nozzle_diameter, '0.6,0.4',
    'matching preserves toolhead order instead of sorting diameters');
  assert.deepEqual(reversed.profile_snapshot.printer_picker.variants, mixed.profile_snapshot.printer_picker.variants,
    'editing another toolhead must not synthesize an ordered or deduplicated variant');
  assert.equal(reversed.profile_snapshot.printer_picker.selected_variant, '0.4+0.6');
  // The editor wrapper must publish replacement candidates for both custom
  // diameters and canonical mixed-profile transitions.
  current = select('Compatibility Alpha 0.4+0.4 nozzle');
  for (const diameter of [0.5, 0.6]) {
    const editorDiameter = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({
      history_context: editingContext, action: 'set-element', kind: 'printer',
      canonical_name: snapshot().printer.name, expected_revision: call('orc_history_status').revision,
      key: 'nozzle_diameter', scalar_type: 'float', index: 1, value: diameter,
    })]);
    assert.equal(editorDiameter.ok, true, JSON.stringify(editorDiameter));
    assert.equal(editorDiameter.editor_candidates.kind, 'replace');
    const freshDraft = call('orc_get_preset_draft', ['string', 'string'], ['printer', editorDiameter.canonical_name]);
    assert.deepEqual(editorDiameter.editor_candidates.items, freshDraft.editor_candidates);
  }
  const retained = snapshot();
  assert.equal(setDiameter(0, 0.4, custom.history_status.revision).ok, false);
  assert.deepEqual(snapshot(), retained, 'stale edits cannot mutate the current vector');
  assert.equal(setDiameter(2, 0.4, call('orc_history_status').revision).ok, false);
  assert.deepEqual(snapshot(), retained, 'invalid indices cannot resize the nozzle vector');
  const setPrinter = (key, value) => {
    const printer = snapshot().printer.name;
    const result = call('orc_mutate_preset_draft', ['string'], [JSON.stringify({
      history_context: editingContext, action: 'set', kind: 'printer', canonical_name: printer,
      expected_revision: call('orc_history_status').revision, key, value,
    })]);
    assert.equal(result.ok, true, JSON.stringify(result));
    return snapshot().printer_picker;
  };
  current = select('Compatibility Alpha 0.4 nozzle');
  const flowValues = picker => picker.flows.map(flow => flow.choices.map(choice => choice.value));
  assert.equal(current.printer_picker.base_printer, current.printer.name);
  assert.deepEqual(flowValues(current.printer_picker), [[0, 1, 2, 3, 5, 6]], 'enum definition order keeps E3D identity 5');
  assert.equal(current.printer_picker.flows[0].actual, 0);
  // The same small policy fixture also proves enum identity and the existing
  // flow receipt/history contract on either native artifact variant.
  const changedFlow = call('orc_set_project_flow', ['string'], [JSON.stringify({ index: 0, flow: 5,
    expected_revision: call('orc_history_status').revision, history_context: editingContext })]);
  assert.equal(changedFlow.ok, true, JSON.stringify(changedFlow));
  assert.equal(changedFlow.profile_snapshot.printer_picker.flows[0].actual, 5);
  assert.equal(changedFlow.filament_session.mappings.volume[0], 5);
  const flowUndo = call('orc_history_undo');
  assert.equal(flowUndo.profile_snapshot.printer_picker.flows[0].actual, 0);
  const flowRedo = call('orc_history_redo');
  assert.equal(flowRedo.profile_snapshot.printer_picker.flows[0].actual, 5);
  assert.equal(call('orc_history_undo').ok, true);
  current = snapshot();
  const historyBeforeRead = call('orc_history_status');
  const sessionBeforeRead = call('orc_get_filament_session_snapshot');
  assert.deepEqual(snapshot(), current);
  assert.deepEqual(call('orc_history_status'), historyBeforeRead, 'reads do not create history');
  assert.deepEqual(call('orc_get_filament_session_snapshot'), sessionBeforeRead, 'reads do not rewrite mappings');
  assert.deepEqual(flowValues(setPrinter('nozzle_diameter', '0.2')), [[0, 1, 2, 3, 5, 6]], 'physical diameter does not filter flows');
  assert.deepEqual(flowValues(setPrinter('printer_variant', '0.2')), [[0, 2, 3, 6]], 'canonical variant filters HF and E3D');
  assert.deepEqual(flowValues(setPrinter('printer_variant', '0.6')), [[0, 1, 2, 3, 5, 6]], 'E3D is admitted for canonical 0.6');
  assert.deepEqual(flowValues(setPrinter('printer_variant', '0.4HS')), [[0, 1, 2, 3, 6]], 'named variants do not masquerade as canonical 0.4');
  setPrinter('printer_variant', '0.4');
  assert.deepEqual(flowValues(setPrinter('printer_model', 'Bambu Lab X1E')), [[0, 2, 3, 5, 6]], 'X1E excludes HF only');
  setPrinter('printer_model', 'Compatibility Alpha');
  assert.deepEqual(flowValues(setPrinter('extruder_max_nozzle_count', 'nil')), [[0, 1, 3, 5, 6]], 'nil count cannot offer Hybrid');
  assert.deepEqual(flowValues(setPrinter('extruder_type', 'Bowden')), [[]], 'drive strings must match');
  setPrinter('extruder_type', 'Direct Drive');
  assert.deepEqual(flowValues(setPrinter('extruder_variant_list', 'Direct Drive Hybrid')), [[2]], 'explicit Hybrid string is eligible even with nil count');
  assert.deepEqual(flowValues(setPrinter('extruder_variant_list', 'unmatched')), [[]], 'empty candidates preserve actual flow');
  assert.equal(snapshot().printer_picker.flows[0].actual, 2, 'empty candidates preserve the repaired Hybrid actual');
  const importFlows = (flows, printer = 'Compatibility Beta 0.6 nozzle') => {
    const entries = readZipEntries(buildIndependentReader3mf());
    const project = entries.find(entry => entry.name === 'Metadata/project_settings.config');
    const config = JSON.parse(new TextDecoder().decode(project.content));
    config.printer_settings_id = printer;
    config.nozzle_volume_type = flows;
    project.content = new TextEncoder().encode(JSON.stringify(config));
    const bytes = writeStoredZip(entries);
    const pointer = Number(Module._malloc(bytes.length));
    Module.HEAPU8.set(bytes, pointer);
    try {
      const result = call('orc_load_project', ['pointer', 'number', 'number', 'string'], [pointer, bytes.length, 0, 'flow-policy.3mf']);
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally { Module._free(pointer); }
  };
  importFlows(['High Flow', 'E3D High Flow']);
  current = select('Compatibility Beta 0.6 nozzle');
  assert.deepEqual(current.printer_picker.flows.map(flow => flow.actual), [0, 0], 'unavailable imported enums are repaired before pure reads');
  assert.deepEqual(flowValues(current.printer_picker), [[0, 2], [0, 2]]);
  const invalidBefore = snapshot();
  const invalidHistory = call('orc_history_status');
  const invalidSession = call('orc_get_filament_session_snapshot');
  assert.deepEqual(snapshot(), invalidBefore);
  assert.deepEqual(call('orc_history_status'), invalidHistory, 'post-load reads create no repair history');
  assert.deepEqual(call('orc_get_filament_session_snapshot'), invalidSession, 'post-load reads preserve mappings');
  importFlows(['Standard', 'E3D High Flow'], 'Compatibility Alpha 0.4HS nozzle');
  const emptyImported = snapshot();
  assert.equal(emptyImported.printer_picker.flows[1].actual, 5, 'empty candidates preserve an unavailable imported actual');
  assert.deepEqual(emptyImported.printer_picker.flows[1].choices, []);
  assert.deepEqual(snapshot(), emptyImported, 'empty-candidate reads stay pure');
  importFlows(['Standard', 'Standard']);
  current = select('Compatibility Beta 0.6 nozzle');
  assert.deepEqual(flowValues(current.printer_picker), [[0, 2], [0, 2]], 'short max count uses get_at first entry across drives');
  current = select('Compatibility Alpha 0.4+0.6 nozzle');
  assert.deepEqual(flowValues(current.printer_picker), [[0, 2], []], 'short variants hide the missing head');
  current = select('Compatibility Alpha 0.4HS nozzle');
  assert.deepEqual(flowValues(current.printer_picker), [[0, 2], []], 'short drives hide the missing head');
  importFlows(['Standard'], 'Compatibility Beta 0.4 nozzle');
  current = select('Compatibility Beta 0.4 nozzle');
  assert.deepEqual(flowValues(current.printer_picker), [[0], []], 'empty max counts do not offer Hybrid; short actual flow hides the missing head');
  assert.equal(current.printer_picker.flows[1].actual, null, 'missing actual is not invented');
  const unavailableBefore = snapshot();
  const unavailableHistory = call('orc_history_status');
  const unavailableSession = call('orc_get_filament_session_snapshot');
  assert.deepEqual(snapshot(), unavailableBefore);
  assert.deepEqual(call('orc_history_status'), unavailableHistory);
  assert.deepEqual(call('orc_get_filament_session_snapshot'), unavailableSession);
  const sourcePrinter = snapshot().printer.name;
  const prepared = call('orc_prepare_user_preset', ['string'], [JSON.stringify({
    history_context: editingContext, action: 'save-as', kind: 'printer', canonical_name: sourcePrinter,
    expected_revision: call('orc_history_status').revision, name: 'Flow inherited user printer',
  })]);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(call('orc_finish_user_preset', ['string'], [JSON.stringify({ token: prepared.token, commit: true })]).ok, true);
  current = select('Flow inherited user printer');
  assert.equal(current.printer_picker.base_printer, sourcePrinter, 'inherited user identity resolves through native base preset');
  console.log('printer picker smoke OK: read-only Sidebar flow policy, grouping, named/mixed variants, atomic transition, toolhead exact matching, indexed fallback, stale/index rejection');
} finally {
  await rm(root, { recursive: true, force: true });
}
