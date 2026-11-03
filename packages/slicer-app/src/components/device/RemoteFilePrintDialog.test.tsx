// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { RemoteFilePrintDialog } from './RemoteFilePrintDialog';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';

const id = <T extends string>(s: string) => s as D.Id<T>;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; useDeviceSelectionStore.setState({ requestedPrinterId: null }); });
async function fixture(unknown = false, delayed = false) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const config = { version: 1 as const, printers: [{ id: 'p', driverId: 'moonraker' as const, displayName: 'Fixture', apiBaseUrl: 'http://printer.local', consoleUrl: '', apiKey: '' }] };
  const configuration = { load: async () => config, save: vi.fn(async () => {}) };
  const service = createMoonrakerService({ configuration, host: { id: id('host'), name: 'Host', execution: 'desktop' }, transport: { request: async () => { throw new Error('No network'); } } });
  const saved = await service.listSaved(); if (!saved.ok) throw new Error('fixture'); const printer = saved.value[0], route = printer.routes[0];
  const file: D.RemoteFile = { ref: { printerId: printer.identity.id, routeId: route.id, configurationRevision: route.configurationRevision, storageId: id('storage'), fileId: id('file') },
    name: 'agent-owned-format.custom', directoryId: null, mimeType: null, sizeBytes: 100, createdAtMs: null, modifiedAtMs: null, metadata: { kind: 'other' } };
  const requirements: D.PrintRequirements = { contentId: 'remote', plateId: 'remote-one', printerModel: 'Fixture', printerModelId: 'fixture', nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'], filamentMap: [1], requiresDynamicMapping: false, bedType: '', durationSeconds: 60, weightGrams: 1, layerCount: 0, toolpathOutside: false, timelapseWarningCode: 0, warnings: [], materials: [] };
  const inspection: D.RemotePrintInspection = { ref: { file: file.ref, id: id('inspection') }, expiresAtMs: Date.now() + 100_000,
    targets: [1, 2].map(n => ({ id: id(`target-${n}`), label: `Plate ${n}`, availability: { kind: 'available' }, requirements: { ...requirements, plateId: `remote-${n}`, durationSeconds: n * 60 } })) };
  let resolve!: (r: D.Result<D.RemotePrintInspection>) => void;
  const inspect = vi.fn<D.PrinterRemotePrints['inspect']>(async () => delayed ? new Promise(r => { resolve = r; }) : ({ ok: true, value: inspection }));
  const prepare = vi.fn<D.PrinterRemotePrints['prepare']>(async request => ({ ok: true, value: { configurationRevision: route.configurationRevision, route: 'lan', bindings: [], candidates: [], options: request.options,
    nozzleLabels: ['Nozzle'], materialCatalogIds: [], optionDescriptors: [], issues: [{ id: 'remote-warning', severity: 'warning', message: 'Review device file conditions.' }] } }));
  const release = vi.fn<D.PrinterRemotePrints['release']>(async () => ({ ok: true, value: null }));
  Object.assign(service.remotePrints, { inspect, prepare, release });
  service.observations.read = vi.fn(async () => ({ ok: true, value: {} })) as unknown as D.PrinterObservations['read'];
  service.observations.watch = async function* () {};
  const operation = { printerId: printer.identity.id, routeId: route.id, id: id<'operation'>('operation') };
  const submit = vi.fn<D.PrinterControls['submit']>(async () => unknown ? { kind: 'outcome-unknown', lookup: { ...operation, requestId: id('request') } } : { kind: 'recorded', operation });
  service.controls.submit = submit;
  service.operations.watch = async function* () { yield { kind: 'command', commandType: 'jobs.start', ref: operation, requestId: id('request'), configurationRevision: route.configurationRevision, revision: 2, updatedAtMs: Date.now(), steps: [], phase: { kind: 'submitted' } }; };
  const runtime = { describePrintPlate: vi.fn(), exportPrintPlate: vi.fn(), getPlateSessionSnapshot: vi.fn() };
  const platform = { printers: { service, configuration }, runtime } as unknown as PlatformCapabilities;
  const element = document.createElement('div'); document.body.append(element); root = createRoot(element); const close = vi.fn();
  await act(async () => root!.render(<PlatformProvider value={platform}><RemoteFilePrintDialog printer={printer} file={file} onClose={close} /></PlatformProvider>));
  const click = async (text: string) => { await act(async () => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeDefined(); button!.click(); }); };
  return { inspect, prepare, release, inspection, submit, runtime, close, click, resolve: () => resolve({ ok: true, value: inspection }) };
}
it('prepares the selected agent target without reading or exporting the current project', async () => {
  const f = await fixture();
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Print target"]')!.click());
  await act(async () => { const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === f.inspection.targets[1].label)!; option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); option.click(); });
  expect(f.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: 'target-2' }), expect.anything());
  expect(document.querySelector('[aria-label="Rename print job"]')).toBeNull();
  await f.click('Send'); expect(f.submit).not.toHaveBeenCalled();
  await f.click('Confirm and print');
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: { type: 'jobs.start', params: expect.objectContaining({ inspection: { id: 'inspection', targetId: 'target-2' }, acknowledgedIssues: ['remote-warning'] }) } }));
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.runtime.describePrintPlate).not.toHaveBeenCalled(); expect(f.runtime.exportPrintPlate).not.toHaveBeenCalled(); expect(f.runtime.getPlateSessionSnapshot).not.toHaveBeenCalled();
});
it('keeps an uncertain start visible and prevents a second send', async () => {
  const f = await fixture(true); await f.click('Send'); await f.click('Confirm and print');
  expect(document.body.textContent).toContain('Print start is unconfirmed');
  const send = document.querySelector('[data-testid="print-submit"]') as HTMLButtonElement;
  expect(send.disabled).toBe(true); expect(f.close).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledOnce();
});
it('aborts a closed inspection and releases a late context without opening preparation', async () => {
  const f = await fixture(false, true);
  await act(async () => { root!.unmount(); root = undefined; f.resolve(); });
  expect(f.inspect.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(f.release).toHaveBeenCalledWith(f.inspection.ref); expect(f.prepare).not.toHaveBeenCalled();
});
