// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/platform-contract';
import { SendGcodeDialog } from './SendGcodeDialog';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
  useSlicerStore.setState(useSlicerStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

async function setup() {
  const receipt = { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' };
  useSlicerStore.setState({ status: 'done', activeSliceTarget: null,
    plateResults: { 'plate-1': { receipt, target: { plateId: 'plate-1', inputRevision: 1 }, warnings: [], summary: {} } } });
  useSettingsStore.setState({ selectedPrinter: 'Bambu Lab H2D 0.4 nozzle' });
  const configuration = { load: vi.fn(async () => ({ version: 1 as const, printers: [
    { id: 'h2d', displayName: 'H2D', driverId: 'moonraker' as const, apiBaseUrl: 'http://fixture/', consoleUrl: '', apiKey: '' },
  ] })), save: vi.fn(async () => undefined) };
  const service = { ...createMoonrakerService({ configuration, transport: {} as never,
    host: { id: 'fixture' as never, name: 'Fixture', execution: 'browser' } }) };
  const catalogue = await service.listSaved(); if (!catalogue.ok) throw new Error('No fixture catalogue');
  let printers = catalogue.value;
  printers[0].identity = { ...printers[0].identity, manufacturer: 'Bambu Lab', model: 'H2D', externalRefs: [{ namespace: 'orca-printer-model', value: 'O1D' }] };
  printers[0].routes[0].capabilities.submission = { kind: 'supported', constraints: { formats: ['print-3mf'] } };
  let changed = () => {};
  service.listSaved = vi.fn(async () => ({ ok: true as const, value: structuredClone(printers) }));
  service.onSavedChanged = listener => { changed = listener; return () => {}; };
  let unavailable = false;
  const candidates = ['a', 'b'].map(slot => ({ materialKey: 'filament-0', pathId: slot, label: `AMS ${slot.toUpperCase()}1`,
    color: '#FF0000', materialType: 'PLA', unit: { id: 'ams', name: 'AMS', kind: 'automatic-feeder', categoryLabel: 'AMS' },
    slot: { id: slot, name: `${slot.toUpperCase()}1` }, tool: { id: 'tool-0', name: 'Nozzle' },
    presence: 'present', remainingFraction: null, disabledReason: null }));
  const read = vi.fn(async () => ({ ok: true, value: null }));
  service.observations = { read, watch: async function* (_request: unknown, { signal }: { signal: AbortSignal }) {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } } as unknown as D.PrinterService['observations'];
  const prepare = vi.fn(async (request: D.PrintPreparationRequest) => ({ ok: true, value: {
    configurationRevision: 'r1', route: 'lan',
    bindings: request.suggest ? [{ materialKey: 'filament-0', pathId: 'a' }] : request.bindings,
    candidates: unavailable ? candidates.slice(0, 1) : candidates, options: {}, materialCatalogIds: [], nozzleLabels: ['Nozzle'], optionDescriptors: [],
    issues: unavailable ? [{ id: 'mapping', severity: 'block', message: 'Selected source is unavailable' }] : [],
  } }));
  service.submissions = { prepare } as unknown as D.PrinterService['submissions'];
  const runtime = {
    getPrinterDeviceMatch: vi.fn<PlatformCapabilities['runtime']['getPrinterDeviceMatch']>(async identity => ({ ok: true,
      printer: 'Bambu Lab H2D 0.4 nozzle', matches: identity.model === 'H2D' })),
    describePrintPlate: vi.fn(async () => ({ ok: true, receipt, manifest: {
      plateId: 'plate-1', printerModel: 'Bambu Lab H2D', printerModelId: 'O1D', nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'],
      filamentMap: [1], requiresDynamicMapping: false, bedType: 'High Temp Plate', durationSeconds: 60, weightGrams: 1,
      layerCount: 10, toolpathOutside: false, timelapseWarningCode: 0, warnings: [], materials: [{
        key: 'filament-0', index: 0, type: 'PLA', color: '#FF0000', presetId: 'fixture', presetName: 'PLA', brand: 'Generic',
        toolIndex: 0, nozzleDiameter: .4, nozzleFlowType: 'Standard', nozzleTemperature: null, initialLayerNozzleTemperature: null, chamberTemperature: 0, softeningTemperature: 55,
        requiredNozzleHardness: 3, usedGrams: 1, usedMeters: .3,
      }],
    } })),
  };
  const platform = { runtime, printers: { service, configuration }, preferences: {
    load: async () => ({ version: 1, selectedProfiles: {}, ui: {} }), save: async () => {},
  } } as unknown as PlatformCapabilities;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const show = async (open: boolean) => act(async () => root!.render(<PlatformProvider value={platform}><SendGcodeDialog open={open} action="send-and-print" initialSelection="h2d" targetReceipt={receipt} onClose={() => {}} /></PlatformProvider>));
  await show(true);
  const source = () => container.querySelector('[aria-label="Material 1 source"]')?.getAttribute('data-source');
  const chooseB = async () => {
    await act(async () => (container.querySelector('[aria-label="Material 1 source"]') as HTMLElement).click());
    await act(async () => (document.querySelector('[aria-label="AMS B1 · PLA"]') as HTMLElement).click());
    expect(source()).toBe('b');
  };
  return { container, source, chooseB, show, runtime, read, prepare, printers,
    refresh: async (next = printers) => act(async () => { printers = next; changed(); }),
    invalidateSource: () => { unavailable = true; },
  };
}

it('retains manual slot mapping and the mounted panel across repeated identical catalogue notifications', async () => {
  vi.useFakeTimers();
  const f = await setup(); await f.chooseB();
  const panel = f.container.querySelector('[data-testid="print-preparation"]');
  for (let i = 0; i < 4; i++) {
    await f.refresh();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(f.source()).toBe('b');
    expect(f.container.querySelector('[data-testid="print-preparation"]')).toBe(panel);
  }
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledOnce();
  expect(f.runtime.describePrintPlate).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
});

it('ignores non-model metadata and exact-reference ordering while keeping the current mapping', async () => {
  const f = await setup(); await f.chooseB();
  const printer = structuredClone(f.printers[0]);
  printer.identity.displayName = 'Renamed H2D';
  printer.identity.externalRefs = [{ namespace: 'serial', value: 'changed' },
    { namespace: 'orca-printer-model', value: 'O1D' }, { namespace: 'orca-printer-model', value: 'O1D' }];
  await f.refresh([printer]);
  expect(f.source()).toBe('b');
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
});

it('keeps the selected device usable while another device is checked, renamed, reordered and removed', async () => {
  const f = await setup(); await f.chooseB();
  const panel = f.container.querySelector('[data-testid="print-preparation"]');
  const other = structuredClone(f.printers[0]); other.identity.id = 'other' as D.Id<'printer'>;
  let complete!: (result: Awaited<ReturnType<PlatformCapabilities['runtime']['getPrinterDeviceMatch']>>) => void;
  f.runtime.getPrinterDeviceMatch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await f.refresh([other, ...f.printers]);
  other.identity.displayName = 'Renamed';
  await f.refresh([...f.printers, other]);
  expect(f.source()).toBe('b');
  expect(f.container.querySelector('[data-testid="print-preparation"]')).toBe(panel);
  expect(f.container.textContent).not.toContain('Checking printer models');
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="send-printer-select"]')!.disabled).toBe(false);
  await f.refresh(f.printers);
  await act(async () => complete({ ok: true, printer: 'Bambu Lab H2D 0.4 nozzle', matches: true }));
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledTimes(2);
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.source()).toBe('b');
});

it('ignores a late matching reply after closing and reopening the modal', async () => {
  const f = await setup(); await f.chooseB();
  let complete!: (result: Awaited<ReturnType<PlatformCapabilities['runtime']['getPrinterDeviceMatch']>>) => void;
  f.runtime.getPrinterDeviceMatch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const printer = structuredClone(f.printers[0]); printer.identity.model = 'U1';
  await f.refresh([printer]);
  await f.show(false); await f.show(true);
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledTimes(3);
  await act(async () => complete({ ok: true, printer: 'Bambu Lab H2D 0.4 nozzle', matches: true }));
  expect(f.container.querySelector('[data-testid="print-preparation"]')).toBeNull();
  expect(f.container.textContent).toContain('No printer model matches');
});

it('keeps an unavailable chosen slot and blocks printing instead of replacing it with the suggested slot', async () => {
  vi.useFakeTimers();
  const f = await setup(); await f.chooseB();
  f.invalidateSource(); await f.refresh();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(f.source()).toBe('b');
  expect(f.container.textContent).toContain('Selected source is unavailable');
  expect(f.container.querySelector<HTMLButtonElement>('[data-testid="print-submit"]')!.disabled).toBe(true);
  expect(f.read).toHaveBeenCalledOnce();
});

it('invalidates a changed device model and starts a fresh matching session after the modal closes', async () => {
  const f = await setup(); await f.chooseB();
  const changed = structuredClone(f.printers[0]); changed.identity.model = 'U1'; changed.identity.externalRefs = [];
  await f.refresh([changed]);
  expect(f.container.querySelector('[data-testid="print-preparation"]')).toBeNull();
  expect(f.container.querySelector('[data-testid="send-printer-select"]')?.textContent).not.toContain('H2D');
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledTimes(2);
  await f.show(false); await f.refresh(f.printers); await f.show(true);
  expect(f.runtime.getPrinterDeviceMatch).toHaveBeenCalledTimes(3);
  expect(f.source()).toBe('a');
});
