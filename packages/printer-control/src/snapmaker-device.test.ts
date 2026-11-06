import { describe, it, expect, vi } from 'vitest';
import type * as D from './domain';
import { MoonrakerHttp } from './moonraker-http';
import { normalizePrinterConfigurationDocument } from './configuration';
import { u1MaterialInventory, u1FilamentType, matchU1Materials } from './snapmaker-observation';
import { readU1Device, u1DeviceCapabilities, u1DeviceCommand, u1DeviceValues, type U1DeviceSnapshot } from './snapmaker-device';
const id = <K extends string>(s: string) => s as D.Id<K>;
const snapshot: U1DeviceSnapshot = { receivedAtMs: 123, objects: ['print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed', 'purifier', 'led cavity_led', 'filament_feed left', 'filament_feed right'],
  commands: ['SET_HEATER_TEMPERATURE', 'SET_PURIFIER', 'SET_LED', 'FEED_AUTO', 'SET_PRINT_FILAMENT_CONFIG'], status: {
    print_stats: { state: 'printing' }, print_task_config: { nozzle_diameter: [1], filament_exist: [true] },
    extruder: { temperature: 210, target: 215, nozzle_diameter: .6, nozzle_volume_type: 'high_flow' },
    configfile: { settings: { extruder: { max_temp: 300 } } }, purifier: { power_detected: false, mode: 2, inner_fan: { speed: .6 } },
    'filament_feed left': { extruder0: { channel_state: 'load_heating' }, extruder1: { channel_state: 'unload_fail' } },
  } };
describe('U1 physical Device controls', () => {
  it('keeps material revisions stable across telemetry polls and new observation timestamps', () => {
    const target = { printerId: id<'printer'>('p'), routeId: id<'route'>('r') };
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const first = u1MaterialInventory(snapshot.status, target, 'r');
    const polled = u1MaterialInventory({ ...snapshot.status,
      extruder: { ...snapshot.status.extruder as object, temperature: 209.8, target: 220 },
      print_stats: { state: 'standby', print_duration: 5 }, purifier: { mode: 0 },
      print_task_config: { ...snapshot.status.print_task_config as object, bed_mesh: true },
    }, target, 'r');
    clock.mockRestore();
    expect(first.state.slots[0].material).toMatchObject({ receivedAtMs: 100 });
    expect(polled.state.slots[0].material).toMatchObject({ receivedAtMs: 200 });
    expect(polled.state.inventoryRevision).toBe(first.state.inventoryRevision);
  });
  it.each(['filament_exist', 'filament_vendor', 'filament_type', 'filament_sub_type', 'filament_color_rgba',
    'loaded', 'sensor-enabled', 'feed-stage', 'configuration'])(
    'invalidates material revisions when %s changes on any physical head', change => {
      for (const head of [0, 1, 2, 3]) {
        const status: Record<string, unknown> = { print_task_config: {
          filament_exist: [true, true, true, true], filament_vendor: ['A', 'A', 'A', 'A'], filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
          filament_sub_type: ['Basic', 'Basic', 'Basic', 'Basic'], filament_color_rgba: ['FFFFFFFF', 'FFFFFFFF', 'FFFFFFFF', 'FFFFFFFF'],
        }, [`filament_motion_sensor e${head}_filament`]: { enabled: true, filament_detected: true },
        [`filament_feed ${head < 2 ? 'left' : 'right'}`]: { [`extruder${head}`]: { channel_state: 'load_finish' } } };
        const target = { printerId: id<'printer'>('p'), routeId: id<'route'>('r') };
        const first = u1MaterialInventory(status, target, 'r');
        if (change.startsWith('filament_')) (status.print_task_config as Record<string, unknown[]>)[change][head] = change === 'filament_exist' ? false : 'Changed';
        else if (change === 'loaded' || change === 'sensor-enabled')
          (status[`filament_motion_sensor e${head}_filament`] as Record<string, boolean>)[change === 'loaded' ? 'filament_detected' : 'enabled'] = false;
        else if (change === 'feed-stage') status[`filament_feed ${head < 2 ? 'left' : 'right'}`] = { [`extruder${head}`]: { channel_state: 'unload_start' } };
        expect(u1MaterialInventory(status, target, change === 'configuration' ? 'r2' : 'r').state.inventoryRevision)
          .not.toBe(first.state.inventoryRevision);
      }
    });
  it.each([
    [null, 'CF', 'PLA'], [' pla ', 'SnapSpeed', 'PLA HIGH SPEED'], ['PETG', 'HS', 'PETG HIGH SPEED'],
    ['PA', 'CF', 'PA-CF'], ['PA', 'GF', 'PA-GF'], ['PLA', 'Silk', 'PLA SILK'], ['PLA', 'Wood', 'PLA WOOD'],
    ['PLA', 'Matte', 'PLA MATTE'], ['PLA', 'Marble', 'PLA MARBLE'], ['PLA', 'Basic', 'PLA'], ['PLA', 'Polylite', 'PLA'],
    ['PETG', 'NONE', 'PETG'], ['ABS', '', 'ABS'],
  ])('combines %s / %s as Orca does: %s', (type, sub, expected) => {
    expect(u1FilamentType(type, sub)).toBe(expected);
  });
  it('matches only present materials through the native catalogue, ignoring SKU and allowing an unknown vendor', async () => {
    const status = { print_task_config: {
      filament_exist: [true, false, true], filament_type: ['PLA', 'PETG', '', 'PLA'],
      filament_vendor: ['Snapmaker', 'Third party', '', ''], filament_sub_type: ['SnapSpeed', 'HF', '', ''],
      filament_sku: [900001, 0, 123456, 0], filament_color_rgba: ['080A0DFF', 'FF0000FF', 'FFFFFFFF', '000000FF'],
    } };
    const inventory = u1MaterialInventory(status, { printerId: id('p'), routeId: id('r') }, 'r');
    let inputs: unknown;
    await matchU1Materials(inventory, async materials => { inputs = materials; return ['native-id-a', 'native-id-b']; }, status);
    expect(inputs).toEqual([
      { presetName: 'Snapmaker PLA SnapSpeed', manufacturer: 'Snapmaker', materialType: 'PLA HIGH SPEED', colorRgba: '#080A0DFF' },
      { presetName: null, manufacturer: '', materialType: 'PLA', colorRgba: '#FFFFFFFF' },
    ]);
    const materials = inventory.state.slots.map(s => s.material.kind === 'known' ? s.material.value : null);
    expect(materials[0]?.catalogRefs).toEqual([{ namespace: 'orca-filament', value: 'native-id-a' }]);
    expect(materials[1]).toBeNull();
    expect(materials[2]?.catalogRefs).toEqual([{ namespace: 'orca-filament', value: 'native-id-b' }]);
    expect(materials[3]).toBeNull();
  });
  it('addresses all four physical feed channels independent of print state or logical mappings', () => {
    const commands = [0, 1, 2, 3].map(i => u1DeviceCommand(snapshot, { type: 'materials.load', params: { pathId: id(`snapmaker-path:${i}`) } }));
    expect(commands).toEqual(['FEED_AUTO MODULE=left CHANNEL=1 LOAD=1', 'FEED_AUTO MODULE=left CHANNEL=0 LOAD=1', 'FEED_AUTO MODULE=right CHANNEL=0 LOAD=1', 'FEED_AUTO MODULE=right CHANNEL=1 LOAD=1']);
    expect(u1DeviceCommand(snapshot, { type: 'materials.unload', params: { toolId: id('snapmaker-tool:2') } })).toBe('FEED_AUTO MODULE=right CHANNEL=0 UNLOAD=1');
    expect(() => u1DeviceCommand(snapshot, { type: 'materials.load', params: { pathId: id('snapmaker-path:4') } })).toThrow();
  });
  it('reports support per command and missing information without inventing hardware', () => {
    expect(u1DeviceCapabilities()['materials.load']?.kind).toBe('unknown');
    expect(u1DeviceCapabilities({ ...snapshot, commands: [] })['materials.load']?.kind).toBe('unsupported');
    const descriptor: D.PrinterDescriptor = { revision: 'r', identity: { id: id('p'), displayName: 'U1', manufacturer: null, model: null, serialNumber: null, externalRefs: [] }, technology: 'fdm', firmware: { kind: 'unknown', reason: 'not-reported' }, buildVolume: null,
      topology: { revision: 'r', completeness: 'partial', motionGroups: [], extruders: [], nozzles: [], tools: [], heaters: [], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } } };
    const values = u1DeviceValues(snapshot, { printerId: id('p'), routeId: id('r') }, 'r', descriptor,
      { vendorId: 'Snapmaker', model: 'Snapmaker U1' });
    expect(values.descriptor?.identity).toMatchObject({ manufacturer: 'Snapmaker', model: 'Snapmaker U1' });
    const unconfigured = u1DeviceValues(snapshot, { printerId: id('p'), routeId: id('r') }, 'r', structuredClone(descriptor), undefined);
    expect(unconfigured.descriptor?.identity).toMatchObject({ manufacturer: null, model: null });
    const configured = u1DeviceValues({ ...snapshot, objects: [] }, { printerId: id('p'), routeId: id('r') }, 'r', structuredClone(descriptor),
      { vendorId: 'Selected vendor', model: 'Selected model' });
    expect(configured.descriptor?.identity).toMatchObject({ manufacturer: 'Selected vendor', model: 'Selected model' });
    expect(values.descriptor?.topology.nozzles[0]).toMatchObject({ diameterMm: .6, flowType: 'high_flow', constructionMaterial: null });
    expect(values.descriptor?.topology.nozzles[1].diameterMm).toBeNull();
    expect(values.materials?.state.tools.map(t => t.activity)).toMatchObject([{ value: 'loading' }, { value: 'error' }, { kind: 'unknown' }, { kind: 'unknown' }]);
    expect(values.sensors?.readings.find(s => s.sensorId === 'snapmaker-cover-present')?.reading).toMatchObject({ value: false });
    expect(values.thermal?.[0].targetC).toMatchObject({ value: 215, receivedAtMs: 123 });
  });
  it('uses physical heater names and live fan commands with bounded values, without enabling circulation modes', () => {
    expect(u1DeviceCommand(snapshot, { type: 'thermal.setTarget', params: { heaterId: id('snapmaker-heater:extruder'), targetC: 220 } })).toBe('SET_HEATER_TEMPERATURE HEATER=extruder TARGET=220');
    expect(() => u1DeviceCommand(snapshot, { type: 'thermal.setTarget', params: { heaterId: id('snapmaker-heater:extruder'), targetC: 301 } })).toThrow();
    expect(u1DeviceCommand(snapshot, { type: 'fans.setSpeed', params: { fanId: id('snapmaker-fan:purifier:inner'), speedFraction: .5 } })).toBe('SET_PURIFIER FAN=inner SPEED=0.5');
    expect(() => u1DeviceCommand(snapshot, { type: 'fans.setSpeed', params: { fanId: id('snapmaker-fan:purifier:inner'), speedFraction: NaN } })).toThrow();
  });
  it('edits metadata without forcing official material overrides or changing print settings', () => {
    const params: D.CommandOf<'materials.writeMetadata'>['params'] = { slotId: id('snapmaker-slot:3'), patch: { materialType: 'PLA-Silk', manufacturer: 'Generic Brand', color: { kind: 'solid', rgba: '#FF00FF80' } } };
    expect(u1DeviceCommand(snapshot, { type: 'materials.writeMetadata', params })).toBe('SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=3 VENDOR="Generic Brand" FILAMENT_TYPE="PLA" FILAMENT_SUBTYPE="Silk" FILAMENT_COLOR_RGBA=FF00FF80');
    expect(() => u1DeviceCommand(snapshot, { type: 'materials.writeMetadata', params: { ...params, patch: { manufacturer: 'bad\nCANCEL_PRINT', materialType: 'PLA' } } })).toThrow();
    expect(() => u1DeviceCommand(snapshot, { type: 'materials.writeMetadata', params: { ...params, patch: { diameterMm: 2 } } })).toThrow();
  });
  it('preserves the device series when saving an unchanged normalized type', () => {
    const current = { ...snapshot, status: { ...snapshot.status, print_task_config: {
      filament_vendor: ['Snapmaker'], filament_type: ['PLA'], filament_sub_type: ['SnapSpeed'],
    } } };
    expect(u1DeviceCommand(current, { type: 'materials.writeMetadata', params: { slotId: id('snapmaker-slot:0'),
      patch: { manufacturer: 'Snapmaker', materialType: 'PLA HIGH SPEED' } } }))
      .toBe('SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=0 VENDOR="Snapmaker" FILAMENT_TYPE="PLA" FILAMENT_SUBTYPE="SnapSpeed"');
  });
});

it('discovers registered commands without help text from the gcode status object', async () => {
  const urls: string[] = [];
  const commands = { FEED_AUTO: {}, SET_PRINT_FILAMENT_CONFIG: {}, M106: {}, SET_PRINT_PREFERENCES: {} };
  const http = new MoonrakerHttp({ async request(request) {
    urls.push(request.url);
    expect(request.method).toBe('GET');
    if (request.url.endsWith('/objects/list')) return { status: 200, json: async () => ({ result: { objects: ['gcode', ...snapshot.objects] } }) };
    if (request.url.includes('/objects/query?gcode&')) return { status: 200, json: async () => ({ result: { status: { ...snapshot.status, gcode: { commands } } } }) };
    throw new Error('Unexpected request; help is not the registered-command catalogue');
  } });
  const printer = normalizePrinterConfigurationDocument({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' }] }).printers[0];
  const observed = await readU1Device(http, printer);
  expect(observed.commands).toEqual(Object.keys(commands));
  expect(u1DeviceCapabilities(observed)['materials.load']?.kind).toBe('supported');
  expect(u1DeviceCapabilities(observed)['materials.writeMetadata']?.kind).toBe('supported');
  expect(urls).toHaveLength(2);
});
