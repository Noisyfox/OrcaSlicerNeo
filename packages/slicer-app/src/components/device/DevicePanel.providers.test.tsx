// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService, createPrinterService } from '@orca/printer-control';
import type { Id, PrinterService, Result, SavedPrinter } from '@orca/printer-control/domain';
import { DevicePanel } from './DevicePanel';
import { usePrinterCatalogue } from './usePrinterCatalogue';
import { sendRoute } from '../send/printerSend';

let roots: Root[] = [];
afterEach(async () => { await act(async () => { roots.forEach(root => root.unmount()); }); roots = []; document.body.innerHTML = ''; });
function root() {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div'); document.body.append(element);
  const renderer = createRoot(element); roots.push(renderer); return { element, renderer };
}
async function seed() {
  const moonraker = createMoonrakerService({
    host: { id: 'test' as Id<'agent-host'>, name: 'Test', execution: 'desktop' },
    configuration: { load: async () => ({ version: 1, printers: [{ id: 'bambu-device', driverId: 'moonraker', displayName: 'Bambu', apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    transport: { request: async () => { throw new Error('No network expected'); } },
  });
  const saved = await moonraker.listSaved(); if (!saved.ok) throw new Error('Fixture failed');
  const printer = structuredClone(saved.value[0]);
  const route = printer.routes[0];
  route.providerId = 'bambu' as Id<'provider'>;
  route.label = 'Bambu Lab'; route.configuration.channel = 'automatic';
  route.management = { rename: false, configure: false, forget: false };
  const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'Discovery only' } as const;
  route.capabilities.observations = Object.fromEntries(Object.keys(route.capabilities.observations).map(topic => [topic, unsupported])) as typeof route.capabilities.observations;
  route.capabilities.webInterface = unsupported;
  route.capabilities.files.upload = unsupported;
  route.capabilities.commands = Object.fromEntries(Object.keys(route.capabilities.commands).map(name => [name, unsupported])) as typeof route.capabilities.commands;
  return { printer, moonraker };
}

it('publishes Bambu to two Device views, hides unsupported actions and forgets remembered LAN access while retaining the device endpoint', async () => {
  const { printer, moonraker } = await seed();
  let saved = [printer];
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const forget = vi.fn<PrinterService['forget']>(async target => {
    saved = saved.map(p => ({ ...p, routes: p.routes.map(route => route.id === target.routeId ? { ...route, management: { ...route.management, forget: false }, configuration: { ...route.configuration, credentialRef: null } } : route) }));
    publish(); return { ok: true, value: null };
  });
  const service = createPrinterService([{ id: 'bambu' as Id<'provider'>, name: 'Bambu', printers: {
    ...moonraker, listSaved: async () => ({ ok: true, value: structuredClone(saved) }), forget,
    onSavedChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } }]);
  const mount = vi.fn(() => { throw new Error('Discovery-only device cannot open a console'); });
  const platform = { printers: { service }, preferences: { load: async () => ({ ui: {} }) }, webview: { mount } } as unknown as PlatformCapabilities;
  const first = root(); const second = root();
  await act(async () => { for (const view of [first, second]) view.renderer.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>); });
  for (const view of [first, second]) {
    expect(view.element.querySelector('[data-testid="device-printer-select"]')).not.toBeNull();
    expect(view.element.querySelector('[data-testid="device-edit-bambu-device"]')).toBeNull();
    expect(view.element.querySelector('[data-testid="device-delete-bambu-device"]')).toBeNull();
  }
  expect(sendRoute(printer)).toBeUndefined();
  expect(sendRoute(printer, true)).toBeUndefined();
  await act(async () => { first.element.querySelector<HTMLButtonElement>('[data-testid="device-printer-select"]')!.click(); });
  await act(async () => { document.querySelector<HTMLElement>('[data-testid="device-select-bambu-device"]')!.click(); });
  expect(first.element.querySelector('[data-testid="device-details"]')?.textContent).toContain('does not provide a console');
  expect(mount).not.toHaveBeenCalled();
  const agent = printer.routes[0];
  const remembered = { ...agent, management: { ...agent.management, forget: true }, configuration: { ...agent.configuration, credentialRef: 'remembered' as Id<'credential'> } };
  await act(async () => { saved = [{ ...printer, identity: { ...printer.identity, displayName: 'Renamed' }, routes: [remembered] }]; publish(); });
  expect(first.element.querySelector('[data-testid="device-printer-select"]')?.textContent).toContain('Renamed');
  await act(async () => { first.element.querySelector<HTMLButtonElement>('[data-testid="device-delete-bambu-device"]')!.click(); });
  await act(async () => { first.element.querySelector<HTMLButtonElement>('[data-testid="device-confirm-delete"]')!.click(); });
  expect(forget).toHaveBeenCalledWith({ printerId: printer.identity.id, routeId: remembered.id, expectedConfigurationRevision: remembered.configurationRevision });
  for (const view of [first, second]) {
    expect(view.element.querySelector('[data-testid="device-delete-bambu-device"]')).toBeNull();
    expect(view.element.querySelector('[data-testid="device-printer-select"]')).not.toBeNull();
  }
  await act(async () => { saved = []; publish(); });
  expect(first.element.querySelector('[data-testid="device-console-empty"]')).not.toBeNull();
  expect(second.element.querySelector('[data-testid="device-empty-list"]')).not.toBeNull();
  await act(async () => { first.renderer.unmount(); second.renderer.unmount(); }); roots = [];
  expect(listeners.size).toBe(0);
});

it('ignores stale reads and retains the current catalogue on failure', async () => {
  const { printer } = await seed();
  const pending: ((result: Result<readonly SavedPrinter[]>) => void)[] = [];
  let invalidate = () => {};
  const stop = vi.fn();
  const service = {
    listSaved: () => new Promise<Result<readonly SavedPrinter[]>>(resolve => pending.push(resolve)),
    onSavedChanged: (listener: () => void) => { invalidate = listener; return stop; },
  } as unknown as PrinterService;
  function Catalogue() { const value = usePrinterCatalogue(service); return <p>{JSON.stringify({ names: value.printers.map(p => p.identity.displayName), failed: value.failed })}</p>; }
  const view = root();
  await act(async () => { view.renderer.render(<Catalogue />); });
  await act(async () => { invalidate(); });
  await act(async () => { pending[1]({ ok: true, value: [printer] }); });
  await act(async () => { pending[0]({ ok: true, value: [] }); });
  expect(view.element.textContent).toContain('Bambu');
  await act(async () => { invalidate(); });
  await act(async () => { pending[2]({ ok: false, error: { code: 'transport', message: 'Unavailable' } }); });
  expect(view.element.textContent).toContain('Bambu');
  expect(view.element.textContent).toContain('"failed":true');
  await act(async () => { invalidate(); view.renderer.unmount(); }); roots = [];
  await act(async () => { pending[3]({ ok: true, value: [] }); });
  expect(stop).toHaveBeenCalledOnce();
});

it.each(['bambu', 'moonraker'])('restores the saved %s Device identity only after a successful catalogue load', async providerId => {
  const { printer, moonraker } = await seed(); printer.routes[0].providerId = providerId as Id<'provider'>;
  let succeed = false; let notify = () => {};
  const service = { ...moonraker, listSaved: async () => succeed ? { ok: true, value: [printer] } : { ok: false, error: { code: 'transport', message: 'Unavailable' } },
    onSavedChanged: (listener: () => void) => { notify = listener; return () => {}; } } as PrinterService;
  const save = vi.fn();
  const platform = { printers: { service }, preferences: { load: async () => ({ ui: { lastDevicePrinterId: printer.identity.id } }), save }, webview: { mount: vi.fn() } } as unknown as PlatformCapabilities;
  const view = root(); await act(async () => { view.renderer.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>); });
  expect(view.element.querySelector('[data-testid="device-details"]')).toBeNull();
  await act(async () => { succeed = true; notify(); });
  expect(view.element.querySelector('[data-testid="device-details"]')).not.toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it('does not replace a missing remembered printer with the first available device', async () => {
  const { printer, moonraker } = await seed();
  const platform = { printers: { service: { ...moonraker, listSaved: async () => ({ ok: true, value: [printer] }) } }, preferences: { load: async () => ({ ui: { lastDevicePrinterId: 'removed' } }) }, webview: { mount: vi.fn() } } as unknown as PlatformCapabilities;
  const view = root(); await act(async () => { view.renderer.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>); });
  expect(view.element.querySelector('[data-testid="device-details"]')).toBeNull();
  expect(view.element.querySelector('[data-testid="device-console-empty"]')).not.toBeNull();
});
