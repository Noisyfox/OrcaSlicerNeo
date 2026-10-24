/** Renderer/preload/main IPC fixture. Utility protocol behavior is covered separately by provider tests. */
import type { ElectronApplication } from '@playwright/test';
import type * as D from '@orca/printer-control/domain';
import { BambuTelemetry } from '../src/utility/bambu/telemetry';
import { commandCapabilities } from '../src/utility/bambu/commands';
import { savedBambuPrinter } from '../src/shared/bambuPrinters';
import type { BambuDevice } from '../src/shared/bambuDevices';
import { Ipc } from '../src/shared/ipc';
const devices: BambuDevice[] = ['a', 'b'].map(deviceId => ({ deviceId, name: `Workshop ${deviceId.toUpperCase()}`, model: 'H2D', routes: [{ channel: 'cloud', revision: 'r1' }] }));
export function controlSnapshot(device: string, task = 'External task', fresh = true) {
  const printer = savedBambuPrinter(devices.find(value => value.deviceId === device)!);
  const target = { printerId: printer.identity.id, routeId: printer.routes[0].id }, telemetry = new BambuTelemetry();
  telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'RUNNING', subtask_id: task, subtask_name: task, stg_cur: 0, home_flag: 7, fun: ((1n << 32n) | (1n << 38n)).toString(16), spd_lvl: 2, mc_percent: 42, mc_remaining_time: 15, layer_num: 42, total_layer_num: 100,
    device: { airduct: { modeCur: 0, parts: [1, 2, 3, 6].map(index => ({ id: index << 4, state: index === 1 ? 50 : 0, range: 100 << 16 })) }, extruder: { state: 2, info: [{ id: 0, temp: (220 << 16) | 215 }, { id: 1, temp: 25 }] }, bed_temp: (60 << 16) | 60 },
    ams: { ams: [0, 4, 128].map(id => ({ id, info: '3', tray: [0, 1, 2, 3].map(slot => ({ id: slot, tray_type: ['PETG-CF', 'PETG', 'PC', 'PLA'][slot], tray_color: ['333333FF', '33AAFFFF', 'EEEEEEFF', '33AA66FF'][slot] })) })) }, lights_report: [{ node: 'chamber_light', mode: 'on' }], cooling_fan_speed: 8,
    vir_slot: [{ id: '254', tray_type: 'PETG' }, { id: '255', tray_type: 'PLA' }],
  } }));
  if (!fresh) telemetry.invalidate();
  const snapshot = telemetry.snapshot(target, printer.identity, printer.routes[0].configurationRevision, ['descriptor', 'status', 'thermal', 'motion', 'actuators', 'materials', 'sensors', 'alerts', 'firmware']);
  const capabilities = commandCapabilities({ ...telemetry.project(target, printer.identity), target, configurationRevision: printer.routes[0].configurationRevision, model: 'H2D' });
  return { snapshot, description: { target, configurationRevision: printer.routes[0].configurationRevision, descriptor: snapshot.values.descriptor, capabilities } };
}
interface FixtureState { requests: unknown[]; data: Record<string, ReturnType<typeof controlSnapshot>>; commands: D.CommandRequest[]; tokens: string[]; operations: Record<string, D.CommandOperation> }
declare global { var bambuControlFixture: FixtureState; }
export async function installControlFixture(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, BrowserWindow }, { channels, devices, data }) => {
    globalThis.bambuControlFixture = { data, requests: [], commands: [], tokens: [], operations: {} };
    ipcMain.removeHandler(channels.bambuRead);
    ipcMain.handle(channels.bambuRead, (_event, kind) => kind === 'printers.saved' ? { ok: true, value: devices }
      : kind === 'account.state' ? { status: 'signed-out', error: null } : { ok: true, value: [] });
    ipcMain.removeHandler(channels.bambuControl);
    ipcMain.handle(channels.bambuControl, (_event, request) => {
      const fixture = globalThis.bambuControlFixture, { method, input } = request;
      fixture.requests.push(request);
      const target = input.target ?? input;
      const current = fixture.data[target.printerId];
      if (method === 'describe') return { ok: true, value: current.description };
      if (method === 'read') return { ok: true, value: current.snapshot };
      if (method === 'observe') { fixture.tokens.push(input.token); return { ok: true, value: null }; }
      if (method === 'release') { fixture.tokens = fixture.tokens.filter(token => token !== input.token); return { ok: true, value: null }; }
      if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No fixture image.' } };
      if (method === 'evaluate') return { ok: true, value: { basis: { capabilityRevision: current.description.capabilities.revision }, availability: { kind: 'available' } } };
      if (method === 'submit') {
        fixture.commands.push(input);
        const ref = { printerId: target.printerId, routeId: target.routeId, id: `operation-${fixture.commands.length}` };
        fixture.operations[ref.id] = { kind: 'command', ref: ref as D.OperationRef, commandType: input.command.type, requestId: input.requestId, configurationRevision: current.description.configurationRevision, revision: 1, updatedAtMs: Date.now(), phase: input.command.type === 'motion.jog' ? { kind: 'accepted' } : { kind: 'completed', result: null, confirmation: 'observed-state' } };
        return { kind: 'recorded', operation: ref };
      }
      if (method === 'operation') return { ok: true, value: { kind: 'found', operation: fixture.operations[input.id] } };
      throw new Error('Unexpected fixture call');
    });
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.bambuChanged, 'printers');
  }, { channels: Ipc, devices, data: { 'bambu:a': controlSnapshot('a'), 'bambu:b': controlSnapshot('b', 'Second task') } });
}
export async function publishControlSnapshot(app: ElectronApplication, device: string, task: string, fresh = true) {
  await app.evaluate(({ BrowserWindow }, { id, data, channel }) => {
    globalThis.bambuControlFixture.data[id] = data;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, 'control');
  }, { id: `bambu:${device}`, data: controlSnapshot(device, task, fresh), channel: Ipc.bambuChanged });
}
