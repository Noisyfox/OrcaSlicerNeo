import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
import { installProfilePackages, createNodeProfileSource, fixtureProfileOptions } from './profile-installer.mjs';
import { createClient } from '../src/client/client.ts';


// Opt in with a freshly built artifact; the ordinary package suite uses mocks.
it.skipIf(!process.env.ORCA_TOPOLOGY_MODULE)('decodes real native topology mutations through the typed client', async () => {
  const harness = import.meta.dirname;
  const factory = await loadModuleFactory(resolve(process.env.ORCA_TOPOLOGY_MODULE));
  const module = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  await installProfilePackages(module, createNodeProfileSource(resolve(harness, '../../profile-resources/dist')));
  const call = (name, types = [], args = []) => {
    const pointer = Number(module.ccall(name, 'number', types, args));
    try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
  };
  expect(call('orc_init', ['string'], [fixtureProfileOptions(module)]).ok).toBe(true);
  const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };
  const client = createClient(async () => module);
  for (const [name, semm, count] of [['Bambu Lab H2D 0.4 nozzle', '1', 3], ['Bambu Lab H2C 0.4 nozzle', '1', 3], ['Snapmaker U1 (0.4 nozzle)', '0', 2]]) {
    expect(call('orc_select_printer_with_remembered_rack', ['string'], [JSON.stringify({history_context:context,printer:name,remembered_rack:null,remembered_bed_type:null})]).ok).toBe(true);
    const before = await client.getPresetDraft('printer', name);
    expect(before.ok, JSON.stringify(before)).toBe(true);
    if (!before.ok) throw new Error(before.error);
    expect(before.effectiveValues.single_extruder_multi_material).toBe(semm);
    const changed = await client.mutatePresetDraft({kind:'printer',canonicalName:name,expectedRevision:before.revision,action:'set',key:'extruders_count',value:String(count)}, context);
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.editorVectors.nozzle_diameter.indexCount).toBe(count);
    expect(changed.effectiveValues.extruders_count).toBe(String(count));
    const enabled = await client.mutatePresetDraft({kind:'printer',canonicalName:name,expectedRevision:changed.revision,action:'set',key:'single_extruder_multi_material',value:'1'}, context);
    expect(enabled.ok, JSON.stringify(enabled)).toBe(true);
    if (!enabled.ok) throw new Error(enabled.error);
    expect(enabled.editorVectors.nozzle_diameter.indexCount).toBe(semm === '1' ? count : 1);
    expect(enabled.optionMetadata.extruders_count.readonly).toBe(semm === '0');
  }
}, 120_000);
