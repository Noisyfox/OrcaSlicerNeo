// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { PrinterMonitor } from './PrinterMonitor';
import { TemperatureInput } from './PrinterControlCards';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
async function fixture() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const base = createMoonrakerService({ host: { id: 'desktop' as never, name: 'Desktop', execution: 'desktop' }, configuration: { load: async () => ({ version: 1, printers: [{ id: 'p', displayName: 'Workshop', driverId: 'moonraker', apiBaseUrl: 'http://printer/', consoleUrl: '', apiKey: '' }] }), save: async () => {} }, transport: { request: async () => { throw new Error('No network'); } } });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('Fixture');
  const printer = saved.value[0], route = printer.routes[0]; route.providerId = 'fixture-printer' as never; route.label = 'Test printer';
  const target = { printerId: printer.identity.id, routeId: route.id };
  const known = <T,>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: route.id, observedAtMs: null, receivedAtMs: 100 });
  const topology: D.PrinterTopology = { revision: 'topology', completeness: 'partial', tools: [], motionGroups: [], extruders: [], nozzles: [], heaters: [{ id: 'nozzle:3' as never, name: 'Nozzle 3', role: 'nozzle', temperatureSensorId: 'temperature' as never }], fans: [], lights: [], cameras: [], sensors: [], materials: { units: [], slots: [], paths: [], dryers: [] } };
  const material: D.MaterialInventory = { topologyRevision: 'topology', topology: { units: [0, 4, 128].map(index => ({ id: `unit:${index}` as never, name: `AMS ${index}`, kind: 'automatic-feeder', sensorIds: [] })), slots: [], paths: [], dryers: [] }, toolIds: [], state: { inventoryRevision: 'inventory', slots: [], tools: [], dryers: [] } };
  const status: D.PrinterObservationMap['status'] = { operationalState: known('busy'), activeToolIds: unknown, actions: known([]), printStatus: { phase: known('printing'), taskId: known('task-1' as D.Id<'device-task'>), name: known('External task'), progressFraction: known(0.42), remainingSeconds: known(1200), currentLayer: known(4), totalLayers: known(10), stage: known({ code: '0', label: 'Printing' }), speedModeId: known('2') } };
  let snapshot: D.PrinterSnapshot = { target, configurationRevision: route.configurationRevision, values: { descriptor: known({ revision: 'topology', identity: printer.identity, technology: 'fdm', buildVolume: null, topology, firmware: unknown }), status: known(status), materials: known(material), thermal: known([{ heaterId: 'nozzle:3' as never, targetC: known(220) }]), sensors: known({ definitionRevision: 'topology', definitions: [], readings: [] }), alerts: known([]) } };
  const caps = structuredClone(route.capabilities); caps.revision = 'cap'; caps.commands['thermal.setTarget'] = { kind: 'supported', constraints: [{ heaterId: 'nozzle:3' as never, targetC: { min: 0, max: 350, step: 1 } }] };
  for (const topic of ['descriptor', 'status', 'thermal', 'motion', 'actuators', 'materials', 'sensors', 'alerts'] as const) caps.observations[topic] = { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } };
  route.capabilities = caps;
  let broken = false;
  let wake: (() => void) | undefined;
  const watch = vi.fn(async function* (_request, options) {
    const onAbort = () => wake?.(); options?.signal?.addEventListener('abort', onAbort);
    try { while (!options?.signal?.aborted) { if (broken) throw new Error('Disconnected'); yield { type: 'snapshot', cursor: 'cursor', snapshot: { ...snapshot, values: Object.fromEntries(Object.entries(snapshot.values).filter(([topic]) => _request.topics.includes(topic))) } }; await new Promise<void>(resolve => { wake = resolve; if (options?.signal?.aborted) resolve(); }); } }
    finally { options?.signal?.removeEventListener('abort', onAbort); }
  });
  const submit = vi.fn(async () => ({ kind: 'recorded', operation: { ...target, id: 'op' } }));
  const service = { ...base, describe: async () => ({ ok: true, value: { target, configurationRevision: route.configurationRevision, capabilities: caps, descriptor: snapshot.values.descriptor } }), observations: { ...base.observations, watch }, controls: { evaluate: async () => ({ ok: true, value: { availability: { kind: 'available' }, basis: {} } }), submit }, operations: { ...base.operations, watch: async function* () { yield { phase: { kind: 'completed' } }; } } } as unknown as D.PrinterService;
  const platform = { printers: { service } } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const render = async (visible = true, observeWhileHidden = false) => act(async () => { root.render(<PlatformProvider value={platform}><PrinterMonitor printer={printer} route={route} visible={visible} observeWhileHidden={observeWhileHidden} /></PlatformProvider>); });
  const update = async (name: string, task = 'task-1', freshness: 'fresh' | 'stale' = 'fresh', phase: 'printing' | 'paused' | 'idle' = 'printing') => act(async () => {
    const reading = known({ ...status, printStatus: { ...status.printStatus, phase: known(phase), name: known(name), taskId: known(task as D.Id<'device-task'>) } });
    if (reading.kind === 'known') reading.freshness = freshness;
    snapshot = { ...snapshot, values: { ...snapshot.values, status: reading } }; wake?.(); await Promise.resolve();
  });
  const click = async (label: string) => act(async () => { [...element.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent) === label)!.click(); });
  return { service, printer, route, snapshot, known, material, element, render, update, click, watch, submit, caps, topology, fail: async () => act(async () => { broken = true; wake?.(); await Promise.resolve(); }), close: async () => { await act(async () => root.unmount()); element.remove(); } };
}
it('shares one icon-only pause/resume control beside progress and respects state and capabilities', async () => {
  const f = await fixture(); try {
    await f.render();
    const pause = f.element.querySelector<HTMLButtonElement>('[aria-label="Pause"]')!;
    const actions = pause.closest('.printer-print-progress-row')!;
    expect(actions.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(actions.querySelectorAll('button')).toHaveLength(2);
    expect(pause.textContent).toBe('');
    expect(actions.querySelector('[aria-label="Cancel print"]')?.textContent).toBe('');
    expect(f.element.querySelector('[aria-label="Resume"]')).toBeNull();
    await f.click('Pause');
    expect((f.submit.mock.calls[0] as unknown[])[0]).toMatchObject({ command: { type: 'jobs.pause' } });
    // A command acknowledgement alone does not optimistically change the device state.
    expect(f.element.querySelector('[aria-label="Resume"]')).toBeNull();
    await f.update('External task', 'task-1', 'fresh', 'paused');
    const resume = f.element.querySelector<HTMLButtonElement>('[aria-label="Resume"]')!;
    expect(resume).toBe(pause);
    expect(f.element.querySelector('[aria-label="Pause"]')).toBeNull();
    await f.click('Resume');
    expect((f.submit.mock.calls[1] as unknown[])[0]).toMatchObject({ command: { type: 'jobs.resume' } });
    f.caps.commands['jobs.resume'] = { kind: 'unsupported', layer: 'adapter', reason: 'Not supported' };
    await f.render();
    expect(resume.disabled).toBe(true);
    await f.update('No active print', 'task-1', 'fresh', 'idle');
    expect(pause.disabled).toBe(true);
    expect(actions.querySelector<HTMLButtonElement>('[aria-label="Cancel print"]')?.disabled).toBe(true);
  } finally { await f.close(); }
});

it('collapses lights independently and places speed below fans and lighting', async () => {
  const f = await fixture(); try {
    const lightId = 'chamber-light' as D.Id<'light'>;
    f.topology.lights = [{ id: lightId, name: 'Chamber light' }];
    f.topology.fans = [{ id: 'part-fan' as D.Id<'fan'>, name: 'Part fan', role: 'part' }];
    f.caps.commands['lights.set'] = { kind: 'supported', constraints: { lightIds: [lightId] } };
    f.caps.commands['jobs.setSpeed'] = { kind: 'supported', constraints: { modes: [{ id: '2', label: 'Standard' }] } };
    await f.render();
    const summary = [...f.element.querySelectorAll('summary')].find(item => item.textContent === 'Lights · 1')!;
    const disclosure = summary.closest('details')!;
    expect(disclosure.open).toBe(false);
    await act(async () => summary.click());
    expect(disclosure.open).toBe(true);
    expect([...f.element.querySelectorAll('summary')].find(item => item.textContent === 'Fans · 1')?.closest('details')?.open).toBe(false);
    const light = f.element.querySelector<HTMLInputElement>('[aria-label="Chamber light"]')!;
    await act(async () => light.click());
    expect((f.submit.mock.calls[0] as unknown[])[0]).toMatchObject({ command: { type: 'lights.set', params: { lightId, on: true } } });
    const speed = f.element.querySelector<HTMLSelectElement>('[aria-label="Print speed"]')!;
    const lightingCard = disclosure.closest('.printer-control-card')!;
    expect(lightingCard.compareDocumentPosition(speed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(speed.closest('.printer-environment-controls')).not.toBeNull();
    expect(f.element.querySelector('.printer-print-column [aria-label="Print speed"]')).toBeNull();
    await f.update('External task');
    expect(disclosure.open).toBe(true);
  } finally { await f.close(); }
});

it('automatically monitors, lays out reported material units and retains the subscription while hidden', async () => {
  const f = await fixture(); try {
    await f.render(); expect(f.watch).toHaveBeenCalledOnce(); expect(f.element.textContent).toContain('External task');
    expect(f.watch.mock.calls[0][0].target).toEqual(f.snapshot.target);
    for (const name of ['AMS 0', 'AMS 4', 'AMS 128']) expect(f.element.textContent).toContain(name);
    expect(f.element.textContent).not.toMatch(/HMS|Browse files|Start monitoring|Connect printer/);
    await f.render(false); await f.update('Hidden update'); expect(f.element.textContent).toContain('External task');
    await f.render(true); expect(f.element.textContent).toContain('Hidden update'); expect(f.watch).toHaveBeenCalledOnce();
    await f.update('Stale task', 'task-1', 'stale'); expect([...f.element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Pause')?.disabled).toBe(true);
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
    expect([...f.element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Pause')?.disabled).toBe(true);
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

it('combines streamed hardware with manual status without adding a status preflight', async () => {
  const f = await fixture(); try {
    f.caps.observations.status = { kind: 'supported', constraints: { delivery: ['on-demand'] } };
    const read = vi.fn(async () => ({ ok: true as const, value: { ...f.snapshot, values: { status: f.snapshot.values.status } } }));
    f.service.observations.read = read as D.PrinterService['observations']['read'];
    await f.render();
    expect(f.watch.mock.calls[0][0].topics).not.toContain('status');
    expect(f.watch.mock.calls[0][0].topics).not.toContain('firmware');
    expect(read).not.toHaveBeenCalled();
    await f.click('Pause'); expect(f.submit).toHaveBeenCalledOnce();
    await f.click('Refresh');
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ topics: ['status'] }), expect.anything());
    expect(f.element.textContent).toContain('External task');
    expect(f.element.textContent).toContain('AMS 128');
    expect(f.watch).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('keeps stream and manual refresh errors independent across updates and hidden views', async () => {
  const f = await fixture(); try {
    f.caps.observations.sensors = { kind: 'supported', constraints: { delivery: ['on-demand'] } };
    const read = vi.fn<D.PrinterService['observations']['read']>().mockRejectedValue(new Error('Disconnected'));
    f.service.observations.read = read as D.PrinterService['observations']['read'];
    await f.render(); await f.click('Refresh');
    await f.update('New task'); await f.render(false); await f.render(true);
    expect(f.element.textContent).toContain('Unable to refresh');
    await f.fail();
    read.mockResolvedValue({ ok: true, value: { ...f.snapshot, values: { sensors: f.snapshot.values.sensors! } } });
    await f.click('Refresh');
    expect(f.element.textContent).toContain('Printer monitoring is unavailable.');
    expect([...f.element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Pause')?.disabled).toBe(true);
    expect(f.watch).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it('withdraws advisory candidates after explicit material pull failure and recovers on successful acquisition', async () => {
  const f = await fixture(); try {
    f.caps.observations.materials = { kind: 'supported', constraints: { delivery: ['on-demand'] } };
    const state = useDeviceSelectionStore.getState(); state.selectGroupingSource(f.printer, f.route);
    const read = vi.fn<D.PrinterService['observations']['read']>().mockResolvedValue({ ok: true, value: f.snapshot });
    f.service.observations.read = read as D.PrinterService['observations']['read'];
    await f.render(); expect(read).not.toHaveBeenCalled();
    await f.click('Refresh');
    expect(useDeviceSelectionStore.getState().groupingReading).not.toBeNull();
    read.mockRejectedValueOnce(new Error('Disconnected'));
    await f.click('Refresh');
    expect(useDeviceSelectionStore.getState().groupingPullFailed).toBe(true);
    await f.update('Unrelated stream update');
    expect(useDeviceSelectionStore.getState().groupingPullFailed).toBe(true);
    await f.click('Refresh');
    expect(useDeviceSelectionStore.getState().groupingPullFailed).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  } finally { await f.close(); useDeviceSelectionStore.getState().selectGroupingSource(null, null); }
});

it('uses reported tool names while keeping material and nozzle IDs opaque', async () => {
  const f = await fixture(); try {
    const tool = 'opaque-head' as D.Id<'tool'>, nozzle = 'opaque-tip' as D.Id<'nozzle'>, slot = 'opaque-slot' as D.Id<'slot'>, path = 'opaque-path' as D.Id<'path'>;
    f.topology.tools = [{ id: tool, name: 'Left head', extruderId: 'opaque-drive' as D.Id<'extruder'>, nozzleId: nozzle, motionGroupId: 'opaque-gantry' as D.Id<'motion'> }];
    f.topology.nozzles = [{ id: nozzle, heaterId: 'opaque-heater' as D.Id<'heater'>, diameterMm: 0.4, constructionMaterial: 'hardened steel', flowType: null, flowReporting: 'unknown', type: null }];
    f.material.topology.slots = [{ id: slot, unitId: f.material.topology.units[0].id, name: 'Spool A' }];
    f.material.topology.paths = [{ id: path, slotId: slot, toolId: tool, loading: 'automatic' }];
    f.caps.commands['materials.load'] = { kind: 'supported', constraints: { pathIds: [path] } };
    f.caps.commands['materials.unload'] = { kind: 'supported', constraints: { toolIds: [tool] } };
    await f.render();
    expect(f.element.textContent).toContain('Left head · Nozzle');
    expect(f.element.textContent).not.toMatch(/opaque-head|opaque-tip/);
    await act(async () => f.element.querySelector<HTMLButtonElement>('[aria-label="Load to Left head"]')!.click());
    expect((f.submit.mock.calls[0] as unknown[])[0]).toMatchObject({ command: { type: 'materials.load', params: { pathId: path } } });
    await f.click('Unload Left head');
    expect((f.submit.mock.calls[1] as unknown[])[0]).toMatchObject({ command: { type: 'materials.unload', params: { toolId: tool } } });
  } finally { await f.close(); }
});

it.each(['solid', 'parallel', 'gradient'] as const)('uses the shared translucent material swatch for %s device colours', async appearance => {
  const f = await fixture(); try {
    const slot = 'spool' as D.Id<'slot'>;
    f.material.topology.slots = [{ id: slot, unitId: f.material.topology.units[0].id, name: 'Spool' }];
    f.material.state.slots = [{ slotId: slot, presence: f.known('present'), spoolIdentity: unknown, remaining: unknown,
      material: f.known({ materialType: 'PLA', manufacturer: null, diameterMm: null, catalogRefs: [],
        color: appearance === 'solid' ? { kind: 'solid', rgba: '#ffffff00' }
          : { kind: 'multiple', rgba: ['#ffffff00', '#ff0000'], representativeRgba: '#ffffff00', appearance } }),
    }];
    await f.render();
    const swatch = f.element.querySelector<HTMLElement>('[aria-label="Material color"]')!;
    expect(swatch.style.backgroundColor).toBe('var(--color-swatch-background)');
    expect(swatch.style.backgroundImage).toContain('var(--color-swatch-checkerboard)');
    if (appearance === 'parallel') expect(swatch.style.backgroundImage).toContain('#ffffff00 0%, #ffffff00 50%, #ff0000 50%, #ff0000 100%');
  } finally { await f.close(); }
});

it.each([
  [{ min: -4, max: 6, step: 2 }, [-4, 6]],
  [{ min: 2, max: 4, step: 1 }, [4]],
  [{ min: -3, max: 3, step: 0.5 }, [-3, 3]],
  [{ min: null, max: 10, step: 1 }, []],
  [{ min: -10, max: 10, step: null }, []],
] satisfies [D.Range, number[]][])('constrains extrusion presets to reported range %j', async (range, expected) => {
  const f = await fixture(); try {
    const extruder = 'opaque-drive' as D.Id<'extruder'>;
    f.topology.tools = [{ id: 'opaque-head' as D.Id<'tool'>, name: 'Side head', extruderId: extruder, nozzleId: 'opaque-tip' as D.Id<'nozzle'>, motionGroupId: 'opaque-gantry' as D.Id<'motion'> }];
    f.caps.commands['extrusion.move'] = { kind: 'supported', constraints: [{ extruderId: extruder, distanceMm: range, speed: { kind: 'device-controlled' } }] };
    await f.render();
    const buttons = [...f.element.querySelectorAll<HTMLButtonElement>('[aria-label$="with Side head"]')];
    expect(buttons).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) {
      expect(buttons[index].ariaLabel).toContain(`${Math.abs(expected[index])} mm`);
      await act(async () => buttons[index].click());
      expect((f.submit.mock.calls[index] as unknown[])[0]).toMatchObject({ command: { type: 'extrusion.move', params: { extruderId: extruder, distanceMm: expected[index] } } });
    }
  } finally { await f.close(); }
});

it('never substitutes a different movement step for an axis that lacks the selected step', async () => {
  const f = await fixture(); try {
    const group = 'opaque-motion' as D.Id<'motion'>;
    f.topology.motionGroups = [{ id: group, name: 'Gantry', axes: ['x', 'y'] }];
    f.caps.commands['motion.jog'] = { kind: 'supported', constraints: [
      { motionGroupId: group, axis: 'x', kind: 'step', steps: [{ id: 'fine-x', label: 'Fine X' }] },
      { motionGroupId: group, axis: 'y', kind: 'step', steps: [{ id: 'fine-y', label: 'Fine Y' }] },
    ] };
    await f.render();
    const x = f.element.querySelector<HTMLButtonElement>('[aria-label="Move X positive"]')!, y = f.element.querySelector<HTMLButtonElement>('[aria-label="Move Y positive"]')!;
    expect(x.disabled).toBe(false); expect(y.disabled).toBe(true);
    const select = f.element.querySelector<HTMLSelectElement>('[aria-label="Movement step"]')!;
    expect(select.value).toBe('fine-x');
    await act(async () => { select.value = 'fine-y'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(x.disabled).toBe(true); expect(y.disabled).toBe(false);
    await act(async () => y.click());
    expect((f.submit.mock.calls[0] as unknown[])[0]).toMatchObject({ command: { type: 'motion.jog', params: { motionGroupId: group, axis: 'y', stepId: 'fine-y' } } });
  } finally { await f.close(); }
});

it('reports an interrupted operation as unknown and never duplicates a pending command', async () => {
  const f = await fixture(); try {
    f.service.operations.watch = async function* () {};
    await f.render();
    const pause = [...f.element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Pause')!;
    await act(async () => { pause.click(); pause.click(); });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.element.textContent).toContain('Command outcome unknown');
    await f.render(false); await f.update('Still printing'); await f.render(true);
    expect(f.submit).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(['accepted', 'completed'] as const)('silently releases controls on %s and keeps pending commands disabled without status messages', async kind => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let closed = 0;
  let phase: D.CommandOperation['phase'] = kind === 'accepted' ? { kind } : { kind, result: null, confirmation: 'observed-state' };
  f.service.operations.watch = async function* (ref) {
    try {
      yield { kind: 'command', commandType: 'motion.jog', ref, requestId: 'request' as D.Id<'request'>, configurationRevision: 'r1', revision: 1, updatedAtMs: 0, phase };
      await new Promise<void>(resolve => { release = resolve; });
    } finally { closed++; }
  };
  try {
    const group = 'gantry' as D.Id<'motion'>;
    f.topology.motionGroups = [{ id: group, name: 'Gantry', axes: ['x'] }];
    f.caps.commands['motion.jog'] = { kind: 'supported', constraints: [{ motionGroupId: group, axis: 'x', kind: 'step', steps: [{ id: 'small', label: 'Small step' }] }] };
    await f.render();
    const jog = f.element.querySelector<HTMLButtonElement>('[aria-label="Move X positive"]')!;
    await act(async () => { jog.click(); });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.element.textContent).not.toMatch(/Printer accepted|Command sent|Waiting for completion|Command completed|outcome unknown|Dismiss/);
    expect(jog.disabled).toBe(false); expect(closed).toBe(1);
    phase = { kind: 'acknowledged' };
    await act(async () => { jog.click(); });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.element.textContent).not.toMatch(/Command sent|Printer acknowledged|Waiting for completion|Dismiss/);
    expect(jog.disabled).toBe(true); expect(closed).toBe(1);
  } finally { await act(async () => { release?.(); }); await f.close(); }
});

it('discards a late task preview and releases object URLs on hide', async () => {
  const f = await fixture();
  const create = vi.fn(() => 'blob:fixture-preview'), revoke = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const pending: { resolve(value: D.Result<D.CurrentPrintPreview>): void; signal?: AbortSignal }[] = [];
  f.caps.currentPrintPreview = { kind: 'supported', constraints: { mimeTypes: ['image/png'] } };
  f.service.media.readCurrentPrintPreview = vi.fn<D.PrinterService['media']['readCurrentPrintPreview']>((_target, options) => new Promise(resolve => pending.push({ resolve, signal: options?.signal })));
  const result = (task: string): D.Result<D.CurrentPrintPreview> => ({ ok: true, value: { ...f.snapshot.target, configurationRevision: f.snapshot.configurationRevision, taskId: task as D.Id<'device-task'>, mimeType: 'image/png', bytes: new Uint8Array([1]) } });
  try {
    await f.render(); expect(pending).toHaveLength(1);
    await f.update('Next task', 'task-2');
    expect(pending[0].signal?.aborted).toBe(true); expect(pending).toHaveLength(2);
    await act(async () => pending[0].resolve(result('task-1')));
    expect(create).not.toHaveBeenCalled();
    await act(async () => pending[1].resolve(result('task-2')));
    expect(create).toHaveBeenCalledOnce();
    expect(f.element.querySelector('img')?.src).toBe('blob:fixture-preview');
    await f.render(false);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:fixture-preview');
    expect(f.element.querySelector('img')).toBeNull();
    expect(f.service.media.readCurrentPrintPreview).toHaveBeenCalledTimes(2);
  } finally { await f.close(); vi.unstubAllGlobals(); }
});

it('starts an explicitly selected device while hidden and retains the same observation when shown', async () => {
  const f = await fixture();
  try {
    await f.render(false); expect(f.watch).not.toHaveBeenCalled();
    await f.render(false, true); expect(f.watch).toHaveBeenCalledOnce();
    await f.render(false, true); expect(f.watch).toHaveBeenCalledOnce();
    await f.render(true); expect(f.watch).toHaveBeenCalledOnce();
    expect(f.element.textContent).toContain('External task');
  } finally { await f.close(); }
});
