// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type * as D from '@orca/platform-contract';
import { MaterialInformationDialog } from './MaterialInformationDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
const target: D.TargetRequest = { printerId: 'physical' as never, routeId: 'route' as never, expectedConfigurationRevision: 'cfg' };
const slot: D.MaterialSlot = { id: 'opaque-slot' as never, unitId: 'holder' as never, name: 'External left' };
const presets: D.MaterialPresetConfiguration[] = [
  { key: 'saved-root', label: 'Generic PLA', materialType: 'PLA', manufacturer: 'Generic', catalogRefs: [{ namespace: 'material-library', value: 'pla' }], presetRef: null, nozzleTemperatureRangeC: { min: 190, max: 230 } },
  { key: 'saved-petg', label: 'Saved PETG', materialType: 'PETG', manufacturer: 'Generic', catalogRefs: [{ namespace: 'material-library', value: 'petg' }], presetRef: { namespace: 'saved-setting', value: 'petg' }, nozzleTemperatureRangeC: { min: 220, max: 260 } },
];
async function fixture({ rfid = false, restricted = false, maxGradientColors = null, color = { kind: 'solid', rgba: '#ABCDEF80' } }: {
  rfid?: boolean; restricted?: boolean; maxGradientColors?: number | null; color?: D.MaterialColor;
} = {}) {
  const query = vi.fn<PlatformCapabilities['runtime']['getDeviceMaterialCatalogue']>(async () => ({ ok: true, presets }));
  const evaluate = vi.fn(async () => ({ ok: true as const, value: { basis: {}, availability: { kind: 'available' } as D.Availability, warnings: [] as D.CommandWarning[] } }));
  const submit = vi.fn(async (_request: D.CommandRequest): Promise<D.Submission> => ({ kind: 'recorded', operation: { printerId: target.printerId, routeId: target.routeId, id: 'op' as never } }));
  const onClose = vi.fn(), onSubmitted = vi.fn(), openHttps = vi.fn();
  const service = { controls: { evaluate, submit } } as unknown as D.PrinterService;
  const platform = { runtime: { getDeviceMaterialCatalogue: query }, preferences: { load: async () => DEFAULT_USER_PREFERENCES }, externalLinks: { openHttps } } as unknown as PlatformCapabilities;
  const configuration: D.MaterialConfigurationTarget = { slotId: slot.id, informationWritable: !rfid, maxGradientColors, actions: restricted ? [] : ['confirm', 'reset'], restriction: restricted ? 'Processing mode is read-only.' : null,
    catalogue: { mainNozzleDiameterMm: .6, toolIndex: 1, nozzleFlowType: 'Standard', supportsUserPresets: true } };
  const props = { service, target, printer: { id: target.printerId, displayName: 'Workshop', manufacturer: 'Vendor', model: 'Physical Model', serialNumber: null, externalRefs: [{ namespace: 'model', value: 'physical' }] }, slot, slotLabel: 'External holder · External left · Left head',
    material: { materialType: 'PLA', manufacturer: 'Generic', color, catalogRefs: presets[0].catalogRefs, diameterMm: null, presetRef: null, nozzleTemperatureRangeC: { min: 195, max: 225 } } as D.MaterialMetadata,
    configuration, capabilityRevision: 'cap', disabled: false, onClose, onSubmitted };
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<PlatformProvider value={platform}><MaterialInformationDialog {...props} /></PlatformProvider>));
  const click = async (label: string) => act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
  return { query, evaluate, submit, props, onClose, onSubmitted, openHttps, click,
    select: () => document.querySelector<HTMLButtonElement>('[aria-label="Material preset"]')!,
    close: async () => { await act(async () => root.unmount()); element.remove(); } };
}
async function openPicker() {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Change material color"]')!.click());
  const picker = document.querySelector<HTMLElement>('[data-slot="color-picker"]')!;
  return {
    element: picker,
    click: async (label: string) => act(async () => [...picker.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click()),
    hex: async (value: string) => act(async () => {
      const input = picker.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
  };
}
it('edits solid alpha on solid-only firmware without offering gradient controls', async () => {
  const f = await fixture(); try {
    const picker = await openPicker();
    expect(picker.element.querySelector('[aria-label="Color mode"]')).toBeNull();
    await picker.hex('12345600'); await picker.click('Confirm');
    expect(document.querySelector('[aria-label="Change material color"]')?.textContent).toContain('#12345600');
    await f.click('Confirm');
    expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { color: { kind: 'solid', rgba: '#12345600' } } } });
  } finally { await f.close(); }
});
it('edits up to four ordered gradient colors with independent alpha and uses the full group for its swatch', async () => {
  const f = await fixture({ maxGradientColors: 4, color: { kind: 'multiple', rgba: ['#FF000000', '#00FF0080', '#FF000000'], representativeRgba: '#0000FFFF', appearance: 'gradient' } });
  try {
    const picker = await openPicker();
    await act(async () => picker.element.querySelector<HTMLButtonElement>('[aria-label="Gradient color 2"]')!.click());
    await picker.hex('ABCDEF01');
    await act(async () => picker.element.querySelector<HTMLButtonElement>('[aria-label="Add color"]')!.click());
    await picker.hex('12121200');
    expect(picker.element.querySelector<HTMLButtonElement>('[aria-label="Add color"]')!.disabled).toBe(true);
    await act(async () => picker.element.querySelector<HTMLButtonElement>('[aria-label="Gradient color 1"]')!.click());
    await picker.hex('123456FE'); await picker.click('Confirm');
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Change material color"]')!;
    expect(trigger.textContent).toBe('4 colors');
    expect(trigger.querySelector('span')!.getAttribute('style')).toContain('var(--color-swatch-checkerboard)');
    await f.click('Confirm');
    expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { color: { kind: 'gradient', rgba: ['#123456FE', '#ABCDEF01', '#12121200', '#FF000000'] } } } });
  } finally { await f.close(); }
});
it.each([
  { appearance: 'parallel' as const, count: 3, limit: 4 },
  { appearance: 'gradient' as const, count: 5, limit: 4 },
  { appearance: 'gradient' as const, count: 7, limit: 4 },
  { appearance: 'gradient' as const, count: 3, limit: null },
])('preserves $appearance/$count colors through Cancel and unchanged Confirm with limit $limit', async ({ appearance, count, limit }) => {
  const colors = ['#FF000000', '#00FF0080', '#FF000000', '#0000FFFF', '#FFFFFF01', '#12345678', '#ABCDEF80'].slice(0, count);
  const f = await fixture({ maxGradientColors: limit, color: { kind: 'multiple', rgba: colors, representativeRgba: '#FFFFFF80', appearance } });
  try {
    let picker = await openPicker();
    expect(picker.element.textContent).toContain('will be preserved unless you change');
    expect(picker.element.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!.value).toBe('FF000000');
    await picker.hex('ABCDEF00'); await picker.click('Cancel');
    picker = await openPicker();
    expect(picker.element.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!.value).toBe('FF000000');
    await picker.click('Confirm');
    expect(document.querySelector('[aria-label="Change material color"]')?.textContent).toBe(`${count} colors`);
    await f.click('Confirm');
    expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { color: null } } });
  } finally { await f.close(); }
});
it('uses the physical-device native catalogue, derives temperature and preserves RGBA independently of material choice', async () => {
  const f = await fixture(); try {
    expect(f.query).toHaveBeenCalledExactlyOnceWith({ identity: { manufacturer: 'Vendor', model: 'Physical Model', externalRefs: [{ namespace: 'model', value: 'physical' }] }, ...f.props.configuration.catalogue });
    expect(f.select().textContent).toBe('Generic PLA');
    expect(document.querySelector('output')?.textContent).toBe('190–230 °C');
    expect(document.querySelector('input[type="number"]')).toBeNull();
    await act(async () => f.select().click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === 'Saved PETG')!.click());
    expect(document.querySelector('output')?.textContent).toBe('220–260 °C');
    await f.click('Confirm');
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.submit.mock.calls[0][0]).toMatchObject({ target, guard: { capabilityRevision: 'cap' }, command: { type: 'materials.configure', params: { slotId: slot.id, intent: 'confirm', preset: presets[1], color: null } } });
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
    await f.click('Confirm'); expect(f.submit.mock.calls[0][0]).toMatchObject({ command: { params: { preset: null, color: null, intent: 'confirm' } } });
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


it('searches the native flat list, preserves selection while filtering and clears the search after dismissal', async () => {
  const f = await fixture();
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(item => item.textContent);
  const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search materials"]')!;
  const fill = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), value);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
  try {
    await act(async () => f.select().click());
    expect(options()).toEqual(['Generic PLA', 'Saved PETG']);
    await fill('petg'); expect(options()).toEqual(['Saved PETG']);
    expect(f.select().textContent).toBe('Generic PLA');
    await fill('not a material'); expect(options()).toEqual([]);
    expect(document.body.textContent).toContain('No matching materials');
    expect(f.submit).not.toHaveBeenCalled();
    await act(async () => search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => f.select().click());
    expect(search().value).toBe(''); expect(options()).toEqual(['Generic PLA', 'Saved PETG']);
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')][1].click());
    expect(f.select().textContent).toBe('Saved PETG');
    expect(document.querySelector('output')?.textContent).toBe('220–260 °C');
    expect(f.query).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
