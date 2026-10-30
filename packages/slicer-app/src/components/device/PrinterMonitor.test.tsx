// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type { Id, PrinterService, Reading } from '@orca/printer-control/domain';
import { DevicePanel } from './DevicePanel';
import { supportsMonitor } from './PrinterMonitor';

it('shows route capabilities, reads only on Refresh, retains the console and never retries unknown commands', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const base = createMoonrakerService({
    host: { id: 'test' as Id<'agent-host'>, name: 'Test', execution: 'browser' },
    configuration: { load: async () => ({ version: 1, printers: [{ id: 'p1', displayName: 'Workshop', driverId: 'moonraker', apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    transport: { request: async () => { throw new Error('Unexpected network request'); } },
  });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('Fixture');
  const printer = saved.value[0];
  const known = <T,>(value: T): Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: printer.routes[0].id, observedAtMs: 1, receivedAtMs: 1 });
  const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
  const read = vi.fn(async (..._args: unknown[]) => ({ ok: true, value: { target: { printerId: printer.identity.id, routeId: printer.routes[0].id }, configurationRevision: printer.routes[0].configurationRevision, values: { status: known({ operationalState: known('busy'), activeToolIds: unknown, actions: unknown, printStatus: { phase: known('printing'), name: known('cube.gcode'), progressFraction: known(0.42), remainingSeconds: unknown } }) } } }));
  const readPreview = vi.fn();
  const submit = vi.fn(async (..._args: unknown[]) => ({ kind: 'outcome-unknown' }));
  const service = { ...base, media: { ...base.media, readCurrentPrintPreview: readPreview }, observations: { ...base.observations, read }, controls: { ...base.controls, submit } } as unknown as PrinterService;
  const dispose = vi.fn();
  const mount = vi.fn(() => ({ state: { status: 'idle', url: null, error: null }, load: vi.fn(), dispose }));
  const platform = { printers: { service, configuration: { load: async () => ({ printers: [] }) } }, preferences: { load: async () => ({ ui: {} }) }, webview: { mount } } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const click = async (selector: string) => act(async () => { element.querySelector<HTMLElement>(selector)!.click(); });
  try {
    await act(async () => { root.render(<PlatformProvider value={platform}><DevicePanel initialSelection="p1" /></PlatformProvider>); });
    expect(element.querySelectorAll('[role="tab"]')).toHaveLength(2);
    await click('#device-tab-monitor');
    expect(read).not.toHaveBeenCalled();
    expect(readPreview).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Printing progress');
    expect(element.querySelector('[aria-label="Print speed"]')).toBeNull();
    expect(element.querySelector('input[type="number"]')).toBeNull();
    expect(element.textContent).not.toMatch(/Home axes|Material system|Nozzle hardware/);
    expect(element.textContent).toContain('Not reported');
    const refresh = [...element.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!;
    await act(async () => { refresh.click(); });
    expect(read.mock.calls[0][0]).toMatchObject({ target: { printerId: 'p1', routeId: printer.routes[0].id }, source: 'device', topics: ['status'] });
    expect(element.textContent).toContain('cube.gcode');
    expect(element.textContent).toContain('42%');
    await click('#device-tab-web');
    await click('#device-tab-monitor');
    expect(read).toHaveBeenCalledOnce();
    expect(readPreview).not.toHaveBeenCalled();
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    const pause = [...element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Pause')!;
    await act(async () => { pause.click(); });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0][0]).toMatchObject({ target: { printerId: 'p1', routeId: printer.routes[0].id, expectedConfigurationRevision: printer.routes[0].configurationRevision }, command: { type: 'jobs.pause', params: {} } });
    expect(element.textContent).toContain('Command outcome unknown');
    const capabilities = structuredClone(printer.routes[0].capabilities);
    const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'Unavailable' } as const;
    capabilities.observations.status = unsupported;
    capabilities.commands = Object.fromEntries(Object.keys(capabilities.commands).map(name => [name, unsupported])) as typeof capabilities.commands;
    expect(supportsMonitor(capabilities)).toBe(false); // Web, metadata and firmware alone are insufficient.
    capabilities.observations.sensors = { kind: 'supported', constraints: { delivery: ['on-demand'] } };
    expect(supportsMonitor(capabilities)).toBe(true);
  } finally { await act(async () => { root.unmount(); }); element.remove(); }
});
