import { describe, it, expect, vi } from 'vitest';
import type * as D from '@orca/platform-contract';
import { MoonrakerHttp } from '../moonraker-http';
import { normalizePrinterConfigurationDocument } from '../configuration';
import { u1MaterialInventory, u1FilamentType, matchU1Materials } from './observation';
import { readU1Device, u1DeviceCapabilities, u1DeviceCommand, u1DeviceValues, u1ActiveToolIds, type U1DeviceSnapshot } from './device';
const id = <K extends string>(s: string) => s as D.Id<K>;
const snapshot: U1DeviceSnapshot = { receivedAtMs: 123, objects: ['print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed', 'purifier', 'led cavity_led', 'filament_feed left', 'filament_feed right'],
  commands: ['SET_HEATER_TEMPERATURE', 'SET_PURIFIER', 'SET_LED', 'FEED_AUTO', 'SET_PRINT_FILAMENT_CONFIG'], status: {
    print_stats: { state: 'printing' }, print_task_config: { nozzle_diameter: [1], filament_exist: [true] },
    extruder: { temperature: 210, target: 215, nozzle_diameter: .6, nozzle_volume_type: 'high_flow' },
    configfile: { settings: { extruder: { max_temp: 300 } } }, purifier: { power_detected: false, mode: 2, inner_fan: { speed: .6 } },
    'filament_feed left': { extruder0: { channel_state: 'load_heating' }, extruder1: { channel_state: 'unload_fail' } },
  } };
describe('U1 physical Device controls', () => {
  function physical(active: unknown[] = ['extruder1', 0]): U1DeviceSnapshot {
    return { receivedAtMs: Date.now(), objects: ['extruder', 'extruder1', 'toolhead'], commands: ['T0', 'T1', 'PARK_EXTRUDER', 'PARK_EXTRUDER1', 'SAVE_GCODE_STATE', 'RESTORE_GCODE_STATE', 'M83', 'M220', 'M221', 'G1', 'M400'],
      status: { print_stats: { state: 'standby' }, machine_state_manager: { main_state: 0, action_code: 0 }, toolhead: { extruder: 'extruder1' },
        extruder: { real_extruder_stats: active, activating_move: false }, extruder1: { real_extruder_stats: active, activating_move: false, can_extrude: true },
        print_task_config: { extruder_map: [3, 2, 1, 0] }, configfile: { settings: { extruder1: { max_extrude_only_distance: 50 } } } } };
  }
  it('addresses physical tools independently of the retained print mapping', () => {
    const value = physical();
    expect(u1DeviceCommand(value, { type: 'tools.select', params: { toolId: id('snapmaker-tool:1') } })).toBe('T1 A0');
    expect(u1DeviceCommand(value, { type: 'tools.park', params: { toolId: id('snapmaker-tool:1') } })).toBe('PARK_EXTRUDER1');
    expect(() => u1DeviceCommand(value, { type: 'tools.park', params: { toolId: id('snapmaker-tool:0') } })).toThrow('currently mounted');
    expect(u1DeviceCapabilities(value)['tools.select']).toMatchObject({ constraints: { toolIds: ['snapmaker-tool:0', 'snapmaker-tool:1'] } });
    expect(() => u1DeviceCommand(value, { type: 'tools.select', params: { toolId: id('snapmaker-tool:3') } })).toThrow();
    value.status.machine_state_manager = { main_state: 0, action_code: 1 };
    expect(() => u1DeviceCommand(value, { type: 'tools.select', params: { toolId: id('snapmaker-tool:0') } })).toThrow('idle');
  });
  it('distinguishes a physically mounted head from parked, moving, conflicting and missing readings', () => {
    expect(u1ActiveToolIds(physical())).toEqual(['snapmaker-tool:1']);
    expect(u1ActiveToolIds(physical(['extruder1', 1]))).toEqual([]);
    expect(u1ActiveToolIds(physical(['unknown extruder', 2]))).toBeUndefined();
    const moving = physical();
    (moving.status.extruder1 as Record<string, unknown>).activating_move = true;
    expect(u1ActiveToolIds(moving)).toBeUndefined();
    const conflict = physical();
    (conflict.status.extruder1 as Record<string, unknown>).real_extruder_stats = ['extruder', 0];
    expect(u1ActiveToolIds(conflict)).toBeUndefined();
    delete (conflict.status.extruder1 as Record<string, unknown>).real_extruder_stats;
    expect(u1ActiveToolIds(conflict)).toBeUndefined();
  });
  it('extrudes only the current warm physical tool within its reported distance limit', () => {
    const value = physical(), command: D.PrinterCommand = { type: 'extrusion.move', params: { extruderId: id('snapmaker-extruder:1'), distanceMm: 10, speed: { kind: 'specified', mmPerSecond: 5 } } };
    expect(u1DeviceCommand(value, command)).toBe('M83\nM220 S100\nM221 S100\nG1 E10 F300\nM400');
    (value.status.extruder1 as Record<string, unknown>).can_extrude = false;
    expect(() => u1DeviceCommand(value, command)).toThrow('Heat');
    expect(() => u1DeviceCommand(physical(['extruder1', 1]), command)).toThrow('active tool changed');
  });
  function motion(): U1DeviceSnapshot {
    const value = physical();
    value.commands = [...value.commands, 'G28', 'G91'];
    value.status.toolhead = { extruder: 'extruder1', homed_axes: 'xyz', position: [50, 60, 20, 0], axis_minimum: [0, 0, 0, 0], axis_maximum: [271, 271, 270, 0], max_velocity: 500 };
    (value.status.configfile as { settings: Record<string, unknown> }).settings.printer = { max_z_velocity: 20 };
    return value;
  }
  it('publishes motion readings and discovers per-axis movement without assuming missing limits', () => {
    const value = motion();
    expect(u1DeviceCapabilities(value)['motion.home']).toMatchObject({ kind: 'supported', constraints: [{ axes: ['x', 'y', 'z'] }] });
    expect(u1DeviceCapabilities(value)['motion.jog']).toMatchObject({ kind: 'supported', constraints: [
      { axis: 'x', steps: [{ label: '10 mm' }, { label: '1 mm' }, { label: '0.1 mm' }] }, { axis: 'y' }, { axis: 'z' },
    ] });
    const descriptor = { identity: {}, topology: {} } as D.PrinterDescriptor;
    expect(u1DeviceValues(value, { printerId: id('p'), routeId: id('r') }, 'r', descriptor, undefined).motion)
      .toMatchObject([{ positionMm: { value: { x: 50, y: 60, z: 20 } }, homedAxes: { value: ['x', 'y', 'z'] } }]);
    delete (value.status.toolhead as Record<string, unknown>).axis_maximum;
    expect(u1DeviceCapabilities(value)['motion.jog']?.kind).toBe('unsupported');
    expect(u1DeviceCapabilities(value)['motion.home']?.kind).toBe('supported');
  });
  it.each([
    ['x', 'positive', '10', 'G91\nM220 S100\nG1 X10 F3600\nM400'],
    ['y', 'negative', '1', 'G91\nM220 S100\nG1 Y-1 F3600\nM400'],
    ['z', 'positive', '0.1', 'G91\nM220 S100\nG1 Z0.1 F1200\nM400'],
  ] as const)('moves %s %s using the selected bounded step', (axis, direction, stepId, script) => {
    expect(u1DeviceCommand(motion(), { type: 'motion.jog', params: { motionGroupId: id('snapmaker-motion'), axis, direction, stepId, kind: 'step' } })).toBe(script);
  });
  it('rejects unhomed, unknown-position, out-of-bounds, busy and arbitrary motion commands', () => {
    const value = motion(), command: D.PrinterCommand = { type: 'motion.jog', params: { motionGroupId: id('snapmaker-motion'), axis: 'x', direction: 'positive', stepId: '10', kind: 'step' } };
    (value.status.toolhead as Record<string, unknown>).homed_axes = '';
    expect(() => u1DeviceCommand(value, command)).toThrow('Home');
    (value.status.toolhead as Record<string, unknown>).homed_axes = 'xyz';
    (value.status.toolhead as Record<string, unknown>).position = [null, 0, 0];
    expect(() => u1DeviceCommand(value, command)).toThrow('unknown');
    (value.status.toolhead as Record<string, unknown>).position = [265, 0, 0];
    expect(() => u1DeviceCommand(value, command)).toThrow('travel');
    value.status.print_stats = { state: 'printing' };
    expect(() => u1DeviceCommand(value, command)).toThrow('idle');
    expect(() => u1DeviceCommand(motion(), { type: 'motion.jog', params: { motionGroupId: id('snapmaker-motion'), axis: 'x', kind: 'distance', distanceMm: 10, speedMmPerSecond: 500 } })).toThrow('reported motion step');
  });
  it('homes requested axes without substituting a move for an unhomed axis', () => {
    const value = motion();
    expect(u1DeviceCommand(value, { type: 'motion.home', params: { motionGroupId: id('snapmaker-motion'), axes: ['x', 'y', 'z'] } })).toBe('G28 X Y Z\nM400');
    (value.status.toolhead as Record<string, unknown>).homed_axes = '';
    expect(() => u1DeviceCommand(value, { type: 'motion.home', params: { motionGroupId: id('snapmaker-motion'), axes: ['z'] } })).toThrow('Home X and Y');
  });
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
    expect(materials[0]).toMatchObject({ materialType: 'PLA HIGH SPEED' });
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
  it('offers the existing material catalogue editor only with a manually configured model and physical tools', () => {
    expect(u1DeviceCapabilities(snapshot)['materials.configure']?.kind).toBe('unsupported');
    const configured = { ...snapshot, printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' } };
    const capability = u1DeviceCapabilities(configured)['materials.configure'];
    expect(capability).toMatchObject({ kind: 'supported', constraints: Array.from({ length: 4 }, (_, i) => ({
      slotId: `snapmaker-slot:${i}`, maxGradientColors: null, actions: ['confirm'],
      catalogue: { mainNozzleDiameterMm: i === 0 ? .6 : null, toolIndex: i, supportsUserPresets: true },
    })) });
    expect(u1DeviceCapabilities({ ...configured, commands: [] })['materials.configure']?.kind).toBe('unsupported');
    expect(u1DeviceCapabilities({ ...configured, objects: ['print_task_config'] })['materials.configure']?.kind).toBe('unsupported');
  });
  it.each([
    ['Snapmaker PLA SnapSpeed @U1', 'Snapmaker', 'PLA', 'PLA', 'SnapSpeed'],
    ['Generic PLA @U1', 'Generic', 'PLA', 'PLA', 'Basic'],
    ['Generic PA-CF @U1', 'Generic', 'PA-CF', 'PA', 'CF'],
  ])('writes the selected catalogue material %s without calibration, reset or a color override', (key, manufacturer, materialType, type, series) => {
    const configured = { ...snapshot, printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' } };
    const command: D.CommandOf<'materials.configure'> & { params: { intent: 'confirm' } } = { type: 'materials.configure', params: { slotId: id('snapmaker-slot:2'), intent: 'confirm',
      preset: { key, label: key, manufacturer, materialType, catalogRefs: [], presetRef: null, nozzleTemperatureRangeC: { min: 190, max: 240 } },
      color: null, acknowledgedWarningIds: [] } };
    expect(u1DeviceCommand(configured, command)).toBe(`SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=2 VENDOR="${manufacturer}" FILAMENT_TYPE="${type}" FILAMENT_SUBTYPE="${series}"`);
    expect(u1DeviceCommand(configured, { ...command, params: { ...command.params, color: { kind: 'solid', rgba: '#12345600' } } }))
      .toContain('FILAMENT_COLOR_RGBA=12345600');
    expect(() => u1DeviceCommand(configured, { ...command, params: { ...command.params, slotId: id('snapmaker-slot:4') } })).toThrow('Unknown physical toolhead');
    expect(() => u1DeviceCommand(configured, { ...command, params: { ...command.params, color: { kind: 'gradient', rgba: ['#FFFFFFFF', '#000000FF'] } } })).toThrow('solid color only');
    expect(() => u1DeviceCommand(configured, { type: 'materials.configure', params: { slotId: id('snapmaker-slot:2'), intent: 'reset', acknowledgedWarningIds: [] } })).toThrow('Select a material');
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
    if (request.url.endsWith('/objects/list')) return { status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => ({ result: { objects: ['gcode', ...snapshot.objects] } }) };
    if (request.url.includes('/objects/query?gcode&')) return { status: 200, bytes: async () => { throw new Error('Unexpected binary read'); }, json: async () => ({ result: { status: { ...snapshot.status, gcode: { commands } } } }) };
    throw new Error('Unexpected request; help is not the registered-command catalogue');
  } });
  const printer = normalizePrinterConfigurationDocument({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' }] }).printers[0];
  const observed = await readU1Device(http, printer);
  expect(observed.commands).toEqual(Object.keys(commands));
  expect(u1DeviceCapabilities(observed)['materials.load']?.kind).toBe('supported');
  expect(u1DeviceCapabilities(observed)['materials.writeMetadata']?.kind).toBe('supported');
  expect(urls).toHaveLength(2);
});
