// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ExportPrintResult, PrintManifest, SliceResultReceipt } from '@slicer/client';
import { PrintPreparationPanel } from './PrintPreparationPanel';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
const id = <T extends string>(s: string) => s as D.Id<T>;
const receipt: SliceResultReceipt = { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '1' };
const manifest: PrintManifest = { plateId: 'plate-1', printerModel: 'Fixture', printerModelId: 'fixture', nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'], filamentMap: [1], requiresDynamicMapping: false, bedType: 'High Temp Plate', durationSeconds: 60, weightGrams: 1, layerCount: 10, toolpathOutside: false, timelapseWarningCode: 0, warnings: [],
  materials: [{ key: 'filament-0', index: 0, type: 'PLA', color: '#FF0000', presetId: 'fixture', presetName: 'PLA', brand: 'Generic', toolIndex: 0, nozzleDiameter: .4, nozzleFlowType: 'Standard', chamberTemperature: 0, softeningTemperature: 55, requiredNozzleHardness: 3, usedGrams: 1, usedMeters: .3 }] };
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove(); vi.useRealTimers(); useDeviceSelectionStore.setState({ currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0 }); });
async function setup(allowAbnormalStorage = false, manifestValue = manifest, readStatus = async (): Promise<D.Result<null>> => ({ ok: true, value: null })) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  let configDocument = { allowAbnormalStorage, version: 1 as const, printers: [], printPreferences: { fixture: { timelapse: true, timelapseStorage: 'external' as const } } };
  let issues: D.PrintIssue[] = [], candidates: D.PrintMaterialSource[] = manifestValue.materials.map((material, index) => ({ materialKey: material.key, pathId: id<'path'>(index ? 'source-b' : 'source-a'), label: index ? 'AMS B1' : 'AMS A1', color: index ? '#00FFFF' : '#FF0000', materialType: material.type, unit: { id: id('unit-a'), name: 'AMS', kind: 'automatic-feeder', categoryLabel: 'AMS' }, slot: { id: id(index ? 'slot-b' : 'slot-a'), name: index ? 'B1' : 'A1' }, tool: { id: id('tool-a'), name: 'Nozzle' }, presence: 'present', remainingFraction: null, disabledReason: null }));
  let recordingSpace: D.PrintPreparation['recordingSpace'];
  let wake: (() => void) | undefined;
  const ref = { printerId: id<'printer'>('fixture'), routeId: id<'route'>('route'), id: id<'print-submission'>('submission') };
  let current: D.PrintSubmissionState = { ref, requestId: id('request'), phase: 'sending', route: 'lan', progress: .5, message: 'Sending print', canCancel: true };
  const submissions = {
    prepare: vi.fn(async (request: D.PrintPreparationRequest): Promise<D.Result<D.PrintPreparation>> => ({ ok: true, value: {
      configurationRevision: 'r1', route: 'lan', bindings: request.suggest ? candidates.map(({ materialKey, pathId }) => ({ materialKey, pathId })) : request.bindings,
      candidates, options: { ...request.options, timelapseStorage: 'internal' }, materialCatalogIds: [], recordingSpace: request.checkRecording ? recordingSpace : undefined,
      nozzleLabels: manifestValue.nozzleDiameters.map((_, index) => manifestValue.nozzleDiameters.length === 2 ? index ? 'Right Nozzle' : 'Left Nozzle' : 'Nozzle 1'), optionDescriptors: [{ key: 'timelapse', label: 'Timelapse', choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }], enabled: true }], issues,
    } })),
    submit: vi.fn(async () => ({ ok: true as const, value: ref })),
    watch: async function* (_ref: D.PrintSubmissionRef, options: { signal: AbortSignal }) { while (!options.signal.aborted) { yield { ...current }; if (['failed', 'sent', 'cancelled', 'unknown'].includes(current.phase)) return; await new Promise<void>(resolve => { wake = resolve; options.signal.addEventListener('abort', () => resolve(), { once: true }); }); } },
    cancel: vi.fn(async () => { current = { ...current, phase: 'cancelling', canCancel: false, message: 'Cancelling sending…' }; wake?.(); return { ok: true as const, value: current }; }),
  };
  const configuration = { load: vi.fn(async () => structuredClone(configDocument)), save: vi.fn(async next => { configDocument = next; }) };
  const runtime = { describePrintPlate: vi.fn(async () => ({ ok: true, receipt, manifest: manifestValue })), exportPrintPlate: vi.fn(async (): Promise<ExportPrintResult> => ({ ok: true, receipt, manifest: manifestValue, fileName: 'fixture.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]), plateIndex: 1, gcodePath: 'Metadata/plate_1.gcode' })) };
  const read = vi.fn(readStatus);
  const platform = { runtime, printers: { configuration, service: { submissions, observations: { read, watch: async function* (_request: unknown, options: { signal: AbortSignal }) { await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true })); } } } } } as unknown as PlatformCapabilities;
  const printer = { identity: { id: id('fixture'), displayName: 'Fixture' } } as D.SavedPrinter;
  const route = { id: id('route'), configurationRevision: 'r1' } as D.PrinterRoute;
  const close = vi.fn(), busy = vi.fn();
  await act(async () => { root!.render(<PrintPreparationPanel platform={platform} printer={printer} route={route} receipt={receipt} onClose={close} onBusyChange={busy} />); });
  const click = async (label: string) => { await act(async () => { const button = [...container.querySelectorAll('button')].find(b => b.textContent === label); if (!button) throw new Error(`No button ${label}`); button.click(); }); };
  return { recordingSpace: (value: D.PrintPreparation['recordingSpace']) => { recordingSpace = value; }, read, setSources: (value: D.PrintMaterialSource[]) => { candidates = value; }, close, busy, runtime, submissions, configuration, click, update: (phase: D.PrintSubmissionState['phase']) => { current = { ...current, phase, canCancel: false }; wake?.(); }, issues: (value: D.PrintIssue[]) => { issues = value; }, removeSources: () => { candidates = []; }, document: () => configDocument };
}
it('waits for printer information before validating or displaying initial diagnostics', async () => {
  vi.useFakeTimers(); let release!: () => void;
  const f = await setup(false, manifest, async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, value: null }; });
  f.issues([{ id: 'storage', severity: 'block', message: 'Storage unavailable' }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(container.textContent).toContain('Loading printer information');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(f.submissions.prepare).not.toHaveBeenCalled();
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());
  expect(container.textContent).not.toContain('Loading printer information');
  expect(container.textContent).toContain('Storage unavailable');
  expect(f.read).toHaveBeenCalledOnce();
});
it('hides intermediate diagnostics during explicit refresh without losing mappings or disabling a valid print', async () => {
  vi.useFakeTimers(); const f = await setup(); let release!: () => void;
  f.read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, value: null }; });
  await act(async () => (container.querySelector('[aria-label="Refresh printer status"]') as HTMLElement).click());
  expect(container.textContent).toContain('Loading printer information');
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(false);
  f.issues([{ id: 'mapping', severity: 'block', message: 'Source unavailable' }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());
  expect(container.textContent).toContain('Source unavailable');
  expect(container.querySelector('[aria-label="Material 1 source"]')?.getAttribute('data-source')).toBe('source-a');
});
it('shows a completed read failure and recovers through cached monitoring without another device read', async () => {
  vi.useFakeTimers();
  const f = await setup(false, manifest, async () => ({ ok: false, error: { code: 'offline', message: 'The printer did not return current status.' } }));
  expect(container.textContent).not.toContain('Loading printer information');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('did not return current status');
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(false);
  expect(f.read).toHaveBeenCalledOnce();
});
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
it('requires per-send warning confirmation, waits for send completion, then selects Device and closes', async () => {
  const f = await setup(); f.issues([{ id: 'warning', severity: 'warning', message: 'Review material' }]);
  await f.click('Send'); expect(f.submissions.submit).not.toHaveBeenCalled();
  await f.click('Confirm and print'); expect(f.submissions.submit).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  expect(f.submissions.prepare.mock.calls.filter(([request]) => request.checkRecording)).toHaveLength(1);
  expect((f.submissions.submit.mock.calls[0] as unknown as [D.PrintSubmissionRequest])[0].acknowledgedIssues).toEqual(['warning']);
  await act(async () => f.update('sent')); expect(f.close).toHaveBeenCalledOnce(); expect(useDeviceSelectionStore.getState().requestedPrinterId).toBe('fixture');
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
  f.runtime.exportPrintPlate.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, receipt, manifest, fileName: 'fixture.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]), plateIndex: 1, gcodePath: 'Metadata/plate_1.gcode' }; });
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
it('uses the shared light checkerboard and readable labels for transparent slice materials', async () => {
  await setup(false, { ...manifest, materials: [{ ...manifest.materials[0], color: '#00000000' }] });
  const swatch = container.querySelector<HTMLElement>('[data-testid="slice-material-0"]')!;
  expect(swatch.style.backgroundColor).toBe('var(--color-swatch-background)');
  expect(swatch.style.backgroundImage).toContain('var(--color-swatch-checkerboard)');
  expect(swatch.style.color).toBe('rgb(23, 23, 23)');
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
  f.runtime.exportPrintPlate.mockResolvedValueOnce({ ok: true, receipt, manifest, fileName: 'My print_PETG_1h35m.gcode.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]), plateIndex: 1, gcodePath: 'Metadata/plate_1.gcode' });
  await f.click('Send');
  expect(f.runtime.exportPrintPlate).toHaveBeenCalledWith(expect.objectContaining({ filenameBase: 'My print' }));
  expect(f.submissions.submit).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'My print' }), expect.arrayContaining([expect.objectContaining({ fileName: 'My print_PETG_1h35m.gcode.3mf' })]));
  expect((container.querySelector('[aria-label="Timelapse"] [aria-label="Off"]') as HTMLButtonElement).disabled).toBe(true);
});

it('uses agent-provided supply names throughout the picker for a non-Bambu feeder', async () => {
  const f = await setup();
  const result = await f.submissions.prepare.mock.results[0].value;
  if (!result.ok) throw new Error('Fixture preparation failed');
  const source = result.value.candidates[0];
  f.setSources([
    { ...source, label: 'Workshop MMU · Feed 5', unit: { ...source.unit, name: 'Workshop MMU', categoryLabel: 'MMU' }, slot: { ...source.slot, name: 'Feed 5' } },
    { ...source, pathId: id('reel'), label: 'Side reel stand · Reel 1', unit: { id: id('reel-unit'), name: 'Side reel stand', kind: 'manual-holder', categoryLabel: 'Reel holders' }, slot: { id: id('reel-slot'), name: 'Reel 1' } },
  ]);
  await act(async () => (container.querySelector('[aria-label="Refresh printer status"]') as HTMLElement).click());
  const trigger = () => container.querySelector('[aria-label="Material 1 source"]') as HTMLElement;
  expect(trigger().textContent).toContain('Feed 5');
  expect(trigger().title).toBe('Workshop MMU · Feed 5 · PLA');
  await act(async () => trigger().click());
  const popup = document.querySelector('[data-print-dialog-popover]')!;
  expect(popup.textContent).toContain('MMU Slots');
  expect(popup.textContent).toContain('Reel holders');
  expect(popup.querySelector('[role="group"][aria-label="Workshop MMU"]')).not.toBeNull();
  expect(popup.querySelector('[role="group"][aria-label="Side reel stand"]')).not.toBeNull();
  expect(popup.textContent).not.toMatch(/AMS|External/);
  await act(async () => (popup.querySelector('[aria-label="Side reel stand · Reel 1 · PLA"]') as HTMLElement).click());
  expect(trigger().textContent).toContain('Reel 1');
  expect(trigger().title).toBe('Side reel stand · Reel 1 · PLA');
  expect(trigger().getAttribute('data-source')).toBe('reel');
});

it('picks from grouped slots, exposes disabled reasons and resets only the current mapping', async () => {
  const f = await setup();
  const result = await f.submissions.prepare.mock.results[0].value;
  if (!result.ok) throw new Error('Fixture preparation failed');
  const source = result.value.candidates[0];
  f.setSources([source,
    { ...source, pathId: id('empty'), slot: { id: id('empty-slot'), name: 'A2' }, label: 'AMS A2', presence: 'empty', disabledReason: 'No filament loaded in this slot.' },
    { ...source, pathId: id('external'), unit: { id: id('external-unit'), name: 'External spool', kind: 'manual-holder', categoryLabel: 'External' }, slot: { id: id('external-slot'), name: 'Ext' }, label: 'External spool', materialType: 'PETG' },
  ]);
  await act(async () => (container.querySelector('[aria-label="Refresh printer status"]') as HTMLElement).click());
  await act(async () => (container.querySelector('[aria-label="Material 1 source"]') as HTMLElement).click());
  const empty = document.querySelector('[aria-label="AMS A2 · —"]') as HTMLButtonElement;
  expect(empty.disabled).toBe(true);
  expect(empty.title).toBe('No filament loaded in this slot.');
  expect(document.querySelector('[role="group"][aria-label="AMS"]')).not.toBeNull();
  expect(document.querySelector('[role="group"][aria-label="External spool"]')).not.toBeNull();
  await act(async () => (document.querySelector('[aria-label="External spool · PETG"]') as HTMLElement).click());
  expect(container.querySelector('[aria-label="Material 1 source"]')?.getAttribute('data-source')).toBe('external');
  await act(async () => (container.querySelector('[aria-label="Material 1 source"]') as HTMLElement).click());
  await act(async () => (document.querySelector('[aria-label="Reset current filament mapping"]') as HTMLElement).click());
  expect(container.querySelector('[aria-label="Material 1 source"]')?.getAttribute('data-source')).toBe('');
  expect(f.configuration.save).not.toHaveBeenCalled();
});

it('keeps preference-save failure visible while sending the current in-memory options', async () => {
  const f = await setup(); f.configuration.save.mockRejectedValueOnce(new Error('Fixture save failure'));
  await act(async () => (container.querySelector('[aria-label="Timelapse"] [aria-label="Off"]') as HTMLButtonElement).click());
  expect(container.textContent).toContain('You can still print with the current options');
  expect((container.querySelector('[data-testid="print-submit"]') as HTMLButtonElement).disabled).toBe(false);
  await f.click('Send');
  expect(f.submissions.submit).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ timelapse: false }) }), expect.anything());
});
it('does not wait for an outstanding preference save before sending', async () => {
  const f = await setup(); let finish!: () => void;
  f.configuration.save.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => (container.querySelector('[aria-label="Timelapse"] [aria-label="Off"]') as HTMLButtonElement).click());
  expect(f.configuration.save).toHaveBeenCalledOnce();
  await f.click('Send'); expect(f.submissions.submit).toHaveBeenCalledOnce();
  await act(async () => finish());
});
it.each(['disable-timelapse', 'clean-oldest'] as const)('retains the capacity decision through %s confirmation without querying again', async action => {
  const f = await setup(); f.recordingSpace({ status: 'insufficient', canClean: true });
  await f.click('Send'); expect(f.submissions.submit).not.toHaveBeenCalled();
  f.recordingSpace({ status: 'enough', canClean: false });
  await act(async () => {
    const select = container.querySelector('[aria-label="Recording space action"]') as HTMLSelectElement;
    select.value = action; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await f.click('Confirm and print');
  expect(f.submissions.submit).toHaveBeenCalledWith(expect.objectContaining({ recordingSpaceAction: action }), expect.anything());
  expect(f.submissions.prepare.mock.calls.filter(([request]) => request.checkRecording)).toHaveLength(1);
  expect(f.configuration.save).not.toHaveBeenCalled();
});
it('allows sending when optional recording capacity is unknown', async () => {
  const f = await setup(); f.recordingSpace({ status: 'unknown', canClean: false });
  await f.click('Send'); expect(f.submissions.submit).toHaveBeenCalledOnce();
  expect(container.querySelector('[aria-label="Confirm print warnings"]')).toBeNull();
});
it('accepts an exported manifest with equivalent fields in a different order', async () => {
  const f = await setup();
  f.runtime.exportPrintPlate.mockResolvedValueOnce({ ok: true, receipt, manifest: Object.fromEntries(Object.entries(manifest).reverse()) as PrintManifest,
    fileName: 'fixture.3mf', bytes: new Uint8Array([1]), configBytes: new Uint8Array([2]), plateIndex: 1, gcodePath: 'Metadata/plate_1.gcode' });
  await f.click('Send'); expect(f.submissions.submit).toHaveBeenCalledOnce();
});
it('still refuses a stale receipt rejected by the runtime export', async () => {
  const f = await setup(); f.runtime.exportPrintPlate.mockResolvedValueOnce({ ok: false, status: 'stale', error: 'Stale receipt' });
  await f.click('Send');
  expect(f.runtime.exportPrintPlate).toHaveBeenCalledWith(expect.objectContaining({ receipt }));
  expect(f.submissions.submit).not.toHaveBeenCalled();
});
