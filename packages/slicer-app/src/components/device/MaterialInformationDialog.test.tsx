// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { MaterialInformationDialog } from './MaterialInformationDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const target: D.TargetRequest = { printerId: 'physical' as never, routeId: 'route' as never, expectedConfigurationRevision: 'cfg' };
const slot: D.MaterialSlot = { id: 'opaque-slot' as never, unitId: 'holder' as never, name: 'External left' };
const presets: D.MaterialPresetConfiguration[] = [
  { key: 'saved-root', label: 'Generic PLA', materialType: 'PLA', manufacturer: 'Generic', catalogRefs: [{ namespace: 'material-library', value: 'pla' }], presetRef: null, nozzleTemperatureRangeC: { min: 190, max: 230 } },
  { key: 'saved-petg', label: 'Saved PETG', materialType: 'PETG', manufacturer: 'Generic', catalogRefs: [{ namespace: 'material-library', value: 'petg' }], presetRef: { namespace: 'saved-setting', value: 'petg' }, nozzleTemperatureRangeC: { min: 220, max: 260 } },
];
async function fixture({ rfid = false, restricted = false } = {}) {
  const query = vi.fn<PlatformCapabilities['runtime']['getDeviceMaterialCatalogue']>(async () => ({ ok: true, presets }));
  const evaluate = vi.fn(async () => ({ ok: true as const, value: { basis: {}, availability: { kind: 'available' } as D.Availability, warnings: [] as D.CommandWarning[] } }));
  const submit = vi.fn(async (_request: D.CommandRequest): Promise<D.Submission> => ({ kind: 'recorded', operation: { printerId: target.printerId, routeId: target.routeId, id: 'op' as never } }));
  const onClose = vi.fn(), onSubmitted = vi.fn(), openHttps = vi.fn();
  const service = { controls: { evaluate, submit } } as unknown as D.PrinterService;
  const platform = { runtime: { getDeviceMaterialCatalogue: query }, preferences: { load: async () => DEFAULT_USER_PREFERENCES }, externalLinks: { openHttps } } as unknown as PlatformCapabilities;
  const configuration: D.MaterialConfigurationTarget = { slotId: slot.id, informationWritable: !rfid, actions: restricted ? [] : ['confirm', 'reset'], restriction: restricted ? 'Processing mode is read-only.' : null,
    catalogue: { mainNozzleDiameterMm: .6, toolIndex: 1, nozzleFlowType: 'Standard', supportsUserPresets: true } };
  const props = { service, target, printer: { id: target.printerId, displayName: 'Workshop', manufacturer: 'Vendor', model: 'Physical Model', serialNumber: null, externalRefs: [{ namespace: 'model', value: 'physical' }] }, slot, slotLabel: 'External holder · External left · Left head',
    material: { materialType: 'PLA', manufacturer: 'Generic', color: { kind: 'solid', rgba: '#ABCDEF80' }, catalogRefs: presets[0].catalogRefs, diameterMm: null, presetRef: null, nozzleTemperatureRangeC: { min: 195, max: 225 } } as D.MaterialMetadata,
    configuration, capabilityRevision: 'cap', disabled: false, onClose, onSubmitted };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<PlatformProvider value={platform}><MaterialInformationDialog {...props} /></PlatformProvider>));
  const click = async (label: string) => act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
  return { query, evaluate, submit, props, onClose, onSubmitted, openHttps, click,
    select: () => document.querySelector<HTMLSelectElement>('[aria-label="Material preset"]')!,
    close: async () => { await act(async () => root.unmount()); element.remove(); } };
}
it('uses the physical-device native catalogue, derives temperature and preserves RGBA independently of material choice', async () => {
  const f = await fixture(); try {
    expect(f.query).toHaveBeenCalledExactlyOnceWith({ identity: { manufacturer: 'Vendor', model: 'Physical Model', externalRefs: [{ namespace: 'model', value: 'physical' }] }, ...f.props.configuration.catalogue });
    expect(f.select().value).toBe('saved-root');
    expect(document.querySelector('output')?.textContent).toBe('190–230 °C');
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await act(async () => { f.select().value = 'saved-petg'; f.select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(document.querySelector('output')?.textContent).toBe('220–260 °C');
    await f.click('Confirm');
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][0]).toMatchObject({ target, guard: { capabilityRevision: 'cap' }, command: { type: 'materials.configure', params: { slotId: slot.id, intent: 'confirm', preset: presets[1], colorRgba: '#ABCDEF80' } } });
    expect(f.onSubmitted).toHaveBeenCalledOnce(); expect(f.onClose).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it('keeps a local submission rejection in the dialog and prevents double submission', async () => {
  const f = await fixture(); try {
    f.submit.mockResolvedValue({ kind: 'rejected', error: { code: 'stale-context', message: 'Printer configuration changed.' } });
    await act(async () => { const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Confirm')!; confirm.click(); confirm.click(); });
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Printer configuration changed.');
  } finally { await f.close(); }
});
it('shows provider warnings and their help links before acknowledging precisely those warnings', async () => {
  const f = await fixture(); try {
    f.evaluate.mockResolvedValue({ ok: true, value: { basis: {}, availability: { kind: 'available' }, warnings: [{ id: 'warning-specific', message: 'Cold pull recommended.', helpUrl: 'https://wiki.bambulab.com/' }] } });
    await f.click('Confirm'); expect(f.submit).not.toHaveBeenCalled();
    await f.click('Learn more'); expect(f.openHttps).toHaveBeenCalledWith('https://wiki.bambulab.com/');
    await f.click('Continue'); expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { acknowledgedWarningIds: ['warning-specific'] } } });
    expect(f.onClose).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it('blocks a prohibited material without dispatching any command', async () => {
  const f = await fixture(); try {
    f.evaluate.mockResolvedValue({ ok: true, value: { basis: {}, availability: { kind: 'blocked', reasons: [{ code: 'precondition-failed', message: 'Material is prohibited in this feeder.' }] }, warnings: [] } });
    await f.click('Confirm'); expect(f.submit).not.toHaveBeenCalled(); expect(f.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Material is prohibited');
  } finally { await f.close(); }
});
it.each([false, true])('requires reset confirmation and explains RFID-only calibration effects: %s', async rfid => {
  const f = await fixture({ rfid }); try {
    expect(f.select().disabled).toBe(rfid);
    if (rfid) expect(document.body.textContent).toContain('cannot clear RFID material information');
    await f.click('Reset'); expect(f.submit).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Reset confirmation"]')?.textContent).toContain(rfid ? 'RFID material information will remain' : 'Clear this slot');
    await f.click('Confirm reset');
    expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { slotId: slot.id, intent: 'reset', acknowledgedWarningIds: [] } } });
  } finally { await f.close(); }
});
it('allows RFID Confirm without sending an editable material selection', async () => {
  const f = await fixture({ rfid: true }); try {
    await f.click('Confirm'); expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { preset: null, colorRgba: null, intent: 'confirm' } } });
  } finally { await f.close(); }
});
it('retains view-only information and disables actions in a processing restriction', async () => {
  const f = await fixture({ restricted: true }); try {
    expect(f.select().disabled).toBe(true); expect(document.body.textContent).toContain('Processing mode is read-only');
    for (const label of ['Confirm', 'Reset']) expect([...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled).toBe(true);
    expect(document.querySelector('output')?.textContent).toBe('195–225 °C');
  } finally { await f.close(); }
});
it('hands a submitted operation to its original Monitor even if the editor unmounts during submission', async () => {
  const f = await fixture();
  let finish!: (value: D.Submission) => void;
  f.submit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await f.click('Confirm'); await f.close();
  await act(async () => finish({ kind: 'recorded', operation: { ...target, id: 'old-operation' as never } }));
  expect(f.onSubmitted).toHaveBeenCalledOnce(); expect(f.onClose).not.toHaveBeenCalled();
});
