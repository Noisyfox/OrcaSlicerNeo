// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { BambuMonitor } from './BambuMonitor';
import { TemperatureInput } from './PrinterControlCards';
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
async function fixture() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const base = createMoonrakerService({ host: { id: 'desktop' as never, name: 'Desktop', execution: 'desktop' }, configuration: { load: async () => ({ version: 1, printers: [{ id: 'p', displayName: 'Workshop', driverId: 'moonraker', apiBaseUrl: 'http://printer/', consoleUrl: '', apiKey: '' }] }), save: async () => {} }, transport: { request: async () => { throw new Error('No network'); } } });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('Fixture');
  const printer = saved.value[0], route = printer.routes[0]; route.providerId = 'bambu' as never; route.label = 'Bambu Cloud';
  const target = { printerId: printer.identity.id, routeId: route.id };
  const known = <T,>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: route.id, observedAtMs: null, receivedAtMs: 100 });
  const topology: D.PrinterTopology = { revision: 'topology', completeness: 'partial', tools: [], motionGroups: [], extruders: [], nozzles: [], heaters: [{ id: 'nozzle:3' as never, name: 'Nozzle 3', role: 'nozzle', temperatureSensorId: 'temperature' as never }], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } };
  const material: D.MaterialInventory = { topologyRevision: 'topology', topology: { units: [0, 4, 128].map(index => ({ id: `unit:${index}` as never, name: `AMS ${index}`, kind: 'automatic-feeder', sensorIds: [] })), slots: [], paths: [], dryers: [] }, toolIds: [], state: { inventoryRevision: 'inventory', slots: [], tools: [], dryers: [] } };
  const status: D.PrinterObservationMap['status'] = { operationalState: known('busy'), activeToolIds: unknown, actions: known([]), printStatus: { phase: known('printing'), taskId: known('task-1' as D.Id<'device-task'>), name: known('External task'), progressFraction: known(0.42), remainingSeconds: known(1200), currentLayer: known(4), totalLayers: known(10), stage: known({ code: '0', label: 'Printing' }), speedModeId: known('2') } };
  let snapshot: D.PrinterSnapshot = { target, configurationRevision: route.configurationRevision, values: { descriptor: known({ revision: 'topology', identity: printer.identity, technology: 'fdm', buildVolume: null, topology, firmware: unknown }), status: known(status), materials: known(material), thermal: known([{ heaterId: 'nozzle:3' as never, targetC: known(220) }]), sensors: known({ definitionRevision: 'topology', definitions: [], readings: [] }), alerts: known([]) } };
  const caps = structuredClone(route.capabilities); caps.revision = 'cap'; caps.commands['thermal.setTarget'] = { kind: 'supported', constraints: [{ heaterId: 'nozzle:3' as never, targetC: { min: 0, max: 350, step: 1 } }] };
  let broken = false;
  let wake: (() => void) | undefined;
  const watch = vi.fn(async function* (_request, options) {
    const onAbort = () => wake?.(); options?.signal?.addEventListener('abort', onAbort);
    try { while (!options?.signal?.aborted) { if (broken) throw new Error('Disconnected'); yield { type: 'snapshot', cursor: 'cursor', snapshot }; await new Promise<void>(resolve => { wake = resolve; if (options?.signal?.aborted) resolve(); }); } }
    finally { options?.signal?.removeEventListener('abort', onAbort); }
  });
  const submit = vi.fn(async () => ({ kind: 'recorded', operation: { ...target, id: 'op' } }));
  const service = { ...base, describe: async () => ({ ok: true, value: { target, configurationRevision: route.configurationRevision, capabilities: caps, descriptor: snapshot.values.descriptor } }), observations: { ...base.observations, watch }, controls: { evaluate: async () => ({ ok: true, value: { availability: { kind: 'available' }, basis: {} } }), submit }, operations: { ...base.operations, watch: async function* () { yield { phase: { kind: 'completed' } }; } } } as unknown as D.PrinterService;
  const platform = { printers: { service } } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const render = async (visible = true) => act(async () => { root.render(<PlatformProvider value={platform}><BambuMonitor printer={printer} route={route} visible={visible} /></PlatformProvider>); });
  const update = async (name: string, task = 'task-1', freshness: 'fresh' | 'stale' = 'fresh') => act(async () => {
    const reading = known({ ...status, printStatus: { ...status.printStatus, name: known(name), taskId: known(task as D.Id<'device-task'>) } });
    if (reading.kind === 'known') reading.freshness = freshness;
    snapshot = { ...snapshot, values: { ...snapshot.values, status: reading } }; wake?.(); await Promise.resolve();
  });
  const click = async (label: string) => act(async () => { [...element.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
  return { element, render, update, click, watch, submit, caps, topology, fail: async () => act(async () => { broken = true; wake?.(); await Promise.resolve(); }), close: async () => { await act(async () => root.unmount()); element.remove(); } };
}
it('automatically monitors, lays out reported material units and retains the subscription while hidden', async () => {
  const f = await fixture(); try {
    await f.render(); expect(f.watch).toHaveBeenCalledOnce(); expect(f.element.textContent).toContain('External task');
    for (const name of ['AMS 0', 'AMS 4', 'AMS 128']) expect(f.element.textContent).toContain(name);
    expect(f.element.textContent).not.toMatch(/HMS|Browse files|Start monitoring|Connect printer/);
    await f.render(false); await f.update('Hidden update'); expect(f.element.textContent).toContain('External task');
    await f.render(true); expect(f.element.textContent).toContain('Hidden update'); expect(f.watch).toHaveBeenCalledOnce();
    await f.update('Stale task', 'task-1', 'stale'); expect([...f.element.querySelectorAll('button')].find(button => button.textContent === 'Pause')?.disabled).toBe(true);
  } finally { await f.close(); }
});
it('pauses directly but binds cancellation confirmation to the original task', async () => {
  const f = await fixture(); try {
    await f.render(); await f.click('Pause'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.element.querySelector('[role="alertdialog"]')).toBeNull();
    await f.click('Cancel print'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.element.querySelector('[role="alertdialog"]')?.textContent).toContain('External task');
    await f.update('Another task', 'task-2'); await f.click('Confirm cancellation'); expect(f.submit).toHaveBeenCalledOnce(); expect(f.element.textContent).toContain('active task changed');
    await f.click('Cancel print'); await f.click('Confirm cancellation'); expect(f.submit).toHaveBeenCalledTimes(2);
    expect((f.submit.mock.calls[1] as unknown[])[0]).toMatchObject({ command: { type: 'jobs.cancel' }, guard: { expectedTaskId: 'task-2' } });
  } finally { await f.close(); }
});
it('submits a temperature edit once for Enter followed by blur', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element), submit = vi.fn();
  try {
    await act(async () => root.render(<TemperatureInput label="Nozzle" limits={{ min: 0, max: 350, step: 1 }} disabled={false} submit={submit} />));
    const input = element.querySelector('input')!;
    await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '220'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })); input.blur(); });
    expect(submit).toHaveBeenCalledExactlyOnceWith(220);
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it('retains a hidden stream failure and disables controls when the page returns', async () => {
  const f = await fixture(); try {
    await f.render(); await f.render(false); await f.fail();
    expect(f.element.textContent).not.toContain('Printer monitoring is unavailable.');
    await f.render(true);
    expect(f.element.textContent).toContain('Printer monitoring is unavailable.');
    expect([...f.element.querySelectorAll('button')].find(button => button.textContent === 'Pause')?.disabled).toBe(true);
  } finally { await f.close(); }
});

it('keeps directional movement and extrusion bound to the reported group and tool after layout changes', async () => {
  const f = await fixture(); try {
    const group = 'gantry-7' as D.Id<'motion'>, tool = 'tool:7' as D.Id<'tool'>, extruder = 'extruder:7' as D.Id<'extruder'>;
    f.topology.motionGroups = [{ id: group, name: 'Gantry', axes: ['x', 'y', 'z'] }];
    f.topology.tools = [{ id: tool, name: 'Tool 7', extruderId: extruder, nozzleId: 'nozzle:7' as D.Id<'nozzle'>, motionGroupId: group }];
    f.caps.commands['motion.jog'] = { kind: 'supported', constraints: [{ motionGroupId: group, axis: 'x', kind: 'step', steps: [{ id: 'small', label: 'Small step' }] }] };
    f.caps.commands['extrusion.move'] = { kind: 'supported', constraints: [{ extruderId: extruder, distanceMm: { min: -10, max: 10, step: 10 }, speed: { kind: 'device-controlled' } }] };
    await f.render();
    await act(async () => { f.element.querySelector<HTMLButtonElement>('[aria-label="Move X negative"]')!.click(); });
    expect((f.submit.mock.calls[0] as unknown[])[0]).toMatchObject({ command: { type: 'motion.jog', params: { motionGroupId: group, axis: 'x', direction: 'negative', stepId: 'small' } } });
    expect(f.element.querySelector('[aria-label="Move Y positive"]')).toBeNull();
    await act(async () => { f.element.querySelector<HTMLButtonElement>('[aria-label="Extrude 10 mm with Tool 7"]')!.click(); });
    expect((f.submit.mock.calls[1] as unknown[])[0]).toMatchObject({ command: { type: 'extrusion.move', params: { extruderId: extruder, distanceMm: 10 } } });
    await f.update('Stale', 'task-1', 'stale');
    expect(f.element.querySelector<HTMLButtonElement>('[aria-label="Move X negative"]')!.disabled).toBe(true);
    expect(f.element.querySelector<HTMLButtonElement>('[aria-label="Extrude 10 mm with Tool 7"]')!.disabled).toBe(true);
  } finally { await f.close(); }
});
