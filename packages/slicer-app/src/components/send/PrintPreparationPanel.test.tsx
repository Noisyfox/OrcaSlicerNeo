// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { PrintManifest, SliceResultReceipt } from '@slicer/client';
import { PrintPreparationPanel } from './PrintPreparationPanel';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
const id = <T extends string>(s: string) => s as D.Id<T>;
const receipt: SliceResultReceipt = { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' };
const manifest: PrintManifest = { plateId: 'plate-1', printerModel: 'Fixture', printerModelId: 'fixture', nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'], filamentMap: [1], requiresDynamicMapping: false, bedType: 'High Temp Plate', durationSeconds: 60, weightGrams: 1, layerCount: 10, toolpathOutside: false, timelapseWarningCode: 0, warnings: [],
  materials: [{ key: 'filament-0', index: 0, type: 'PLA', color: '#FF0000', presetId: 'fixture', presetName: 'PLA', brand: 'Generic', toolIndex: 0, nozzleDiameter: .4, nozzleFlowType: 'Standard', chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 3, usedGrams: 1, usedMeters: .3 }] };
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); vi.useRealTimers(); useDeviceSelectionStore.setState({ currentPrinterId: null, requestedPrinterId: null, requestVersion: 0 }); });
async function setup(allowAbnormalStorage = false, manifestValue = manifest) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  let configDocument = { allowAbnormalStorage, version: 1 as const, printers: [], printPreferences: { fixture: { timelapse: true, timelapseStorage: 'external' as const } } };
  let issues: D.PrintIssue[] = [], candidates = manifestValue.materials.map((material, index) => ({ materialKey: material.key, pathId: id<'path'>(index ? 'source-b' : 'source-a'), label: index ? 'AMS B1' : 'AMS A1', color: index ? '#00FFFF' : '#FF0000', materialType: material.type }));
  let wake: (() => void) | undefined;
  const ref = { printerId: id<'printer'>('fixture'), routeId: id<'route'>('route'), id: id<'print-submission'>('submission') };
  let current: D.PrintSubmissionState = { ref, requestId: id('request'), phase: 'sending', route: 'lan', progress: .5, message: 'Sending print', canCancel: true };
  const submissions = {
    prepare: vi.fn(async (request: D.PrintPreparationRequest): Promise<D.Result<D.PrintPreparation>> => ({ ok: true, value: {
      configurationRevision: 'r1', route: 'lan', bindings: request.suggest ? candidates.map(({ materialKey, pathId }) => ({ materialKey, pathId })) : request.bindings,
      candidates, options: { ...request.options, timelapseStorage: 'internal' }, materialCatalogIds: [],
      nozzleLabels: manifestValue.nozzleDiameters.map((_, index) => manifestValue.nozzleDiameters.length === 2 ? index ? 'Right Nozzle' : 'Left Nozzle' : 'Nozzle 1'), optionDescriptors: [{ key: 'timelapse', label: 'Timelapse', choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }], enabled: true }], issues,
    } })),
    submit: vi.fn(async () => ({ ok: true as const, value: ref })),
    watch: async function* (_ref: D.PrintSubmissionRef, options: { signal: AbortSignal }) { while (!options.signal.aborted) { yield { ...current }; if (['failed', 'started', 'cancelled', 'unknown'].includes(current.phase)) return; await new Promise<void>(resolve => { wake = resolve; options.signal.addEventListener('abort', () => resolve(), { once: true }); }); } },
    cancel: vi.fn(async () => { current = { ...current, phase: 'cancelling', canCancel: false, message: 'Cancelling sending…' }; wake?.(); return { ok: true as const, value: current }; }),
  };
  const configuration = { load: vi.fn(async () => structuredClone(configDocument)), save: vi.fn(async next => { configDocument = next; }) };
  const runtime = { describePrintPlate: vi.fn(async () => ({ ok: true, receipt, manifest: manifestValue })), exportPrintPlate: vi.fn(async () => ({ ok: true, receipt, manifest: manifestValue, fileName: 'fixture.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]) })) };
  const platform = { runtime, printers: { configuration, service: { submissions, observations: { watch: async function* (_request: unknown, options: { signal: AbortSignal }) { await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true })); } } } } } as unknown as PlatformCapabilities;
  const printer = { identity: { id: id('fixture'), displayName: 'Fixture' } } as D.SavedPrinter;
  const route = { id: id('route'), configurationRevision: 'r1' } as D.PrinterRoute;
  const close = vi.fn(), busy = vi.fn();
  await act(async () => { root!.render(<PrintPreparationPanel platform={platform} printer={printer} route={route} receipt={receipt} onClose={close} onBusyChange={busy} />); });
  const click = async (label: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === label); if (!button) throw new Error(`No button ${label}`); button.click(); }); };
  return { close, busy, runtime, submissions, configuration, click, update: (phase: D.PrintSubmissionState['phase']) => { current = { ...current, phase, canCancel: false }; wake?.(); }, issues: (value: D.PrintIssue[]) => { issues = value; }, removeSources: () => { candidates = []; }, document: () => configDocument };
}
it('keeps storage fallback out of persistence, but saves explicit changes even when cancelled', async () => {
  const f = await setup();
  expect((container.querySelector('[aria-label="Material 1 source"]') as HTMLElement).getAttribute('data-source')).toBe('source-a');
  expect(f.configuration.save).not.toHaveBeenCalled();
  await act(async () => { (container.querySelector('[aria-label="Timelapse"] [aria-label="Off"]') as HTMLElement).click(); });
  await f.click('Close'); expect(f.close).toHaveBeenCalledOnce();
  expect(f.document().printPreferences.fixture).toEqual({ timelapse: false, timelapseStorage: 'external' });
});
it('retains a removed source and blocks printing on refreshed invalidation', async () => {
  vi.useFakeTimers(); const f = await setup(); f.removeSources(); f.issues([{ id: 'mapping', severity: 'block', message: 'Source unavailable' }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect((container.querySelector('[aria-label="Material 1 source"]') as HTMLElement).getAttribute('data-source')).toBe('source-a');
  expect(container.textContent).toContain('Unavailable'); expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(true);
});
it('requires per-send warning confirmation, waits for observed start, then selects Device and closes', async () => {
  const f = await setup(); f.issues([{ id: 'warning', severity: 'warning', message: 'Review material' }]);
  await f.click('Send'); expect(f.submissions.submit).not.toHaveBeenCalled();
  await f.click('Confirm and print'); expect(f.submissions.submit).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  expect((f.submissions.submit.mock.calls[0] as unknown as [D.PrintSubmissionRequest])[0].acknowledgedIssues).toEqual(['warning']);
  await act(async () => f.update('confirming')); expect(f.close).not.toHaveBeenCalled();
  await act(async () => f.update('started')); expect(f.close).toHaveBeenCalledOnce(); expect(useDeviceSelectionStore.getState().requestedPrinterId).toBe('fixture');
});
it('cancel sending leaves the modal locked until cancellation is confirmed', async () => {
  const f = await setup(); await f.click('Send'); await f.click('Cancel sending');
  expect(f.submissions.cancel).toHaveBeenCalledOnce();
  const close = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Close')!;
  expect(close().disabled).toBe(true);
  await act(async () => f.update('cancelled')); expect(close().disabled).toBe(false);
});
it('unknown outcomes allow closing but never offer retry', async () => {
  const f = await setup(); await f.click('Send'); await act(async () => f.update('unknown'));
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(true);
  await f.click('Close'); expect(f.close).toHaveBeenCalledOnce();
});
it('does not admit a job if the dialog disappears while native packaging is pending', async () => {
  const f = await setup(); let release!: () => void;
  f.runtime.exportPrintPlate.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, receipt, manifest, fileName: 'fixture.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]) }; });
  await f.click('Send'); expect(f.runtime.exportPrintPlate).toHaveBeenCalledOnce();
  await act(async () => root!.unmount()); root = undefined;
  await act(async () => release()); expect(f.submissions.submit).not.toHaveBeenCalled();
});

it('reads the saved global storage policy without exposing an override in print preparation', async () => {
  const f = await setup(true);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(container.textContent).not.toMatch(/abnormal storage/i);
  expect(f.submissions.prepare.mock.calls.at(-1)?.[0].allowAbnormalStorage).toBe(true);
  expect(f.configuration.save).not.toHaveBeenCalled();
});

it('groups sparse materials by slice nozzle and shows the actual source colour independently', async () => {
  const dual: PrintManifest = { ...manifest, nozzleDiameters: [.4, .4], materials: [
    { ...manifest.materials[0], index: 2, toolIndex: 1 },
    { ...manifest.materials[0], key: 'filament-4', index: 4, toolIndex: 0, type: 'PETG', color: '#333333' },
  ] };
  await setup(false, dual);
  const left = container.querySelector('section[aria-label="Left Nozzle"]')!;
  const right = container.querySelector('section[aria-label="Right Nozzle"]')!;
  expect(left.querySelector('[aria-label="Material 5 source"]')).not.toBeNull();
  expect(left.querySelector('[aria-label="Material 3 source"]')).toBeNull();
  expect(right.querySelector('[aria-label="Material 3 source"]')).not.toBeNull();
  expect((left.querySelector('[data-source]') as HTMLElement).style.backgroundColor).toBe('rgb(0, 255, 255)');
  expect((left.querySelector('[data-testid="slice-material-4"]') as HTMLElement).style.backgroundColor).toBe('rgb(51, 51, 51)');
});
it('renames only the submitted artifact and locks segmented options during sending', async () => {
  const f = await setup();
  await act(async () => (container.querySelector('[aria-label="Rename print job"]') as HTMLElement).click());
  const input = container.querySelector('[aria-label="Print job name"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My print');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await f.click('Send');
  expect(f.runtime.exportPrintPlate).toHaveBeenCalledWith(expect.objectContaining({ filenameBase: 'My print' }));
  expect((container.querySelector('[aria-label="Timelapse"] [aria-label="Off"]') as HTMLButtonElement).disabled).toBe(true);
});
