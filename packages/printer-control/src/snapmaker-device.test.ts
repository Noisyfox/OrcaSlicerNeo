import { describe, it, expect } from 'vitest';
import type * as D from './domain';
import { MoonrakerHttp } from './moonraker-http';
import { normalizePrinterConfigurationDocument } from './configuration';
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
