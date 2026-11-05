// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConfiguredPrinterModel } from '@orca/printer-control/domain';
import type { PresetInfo } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { PrinterModelSelector } from './PrinterModelSelector';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  document.body.replaceChildren();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  vi.restoreAllMocks();
});
function preset(model: string, variant: string, overrides: Partial<PresetInfo> = {}): PresetInfo {
  return { name: `${model} ${variant} nozzle`, label: 'Preset display name', model, variant, vendor_id: 'Vendor', vendor: '',
    is_visible: true, is_default: false, is_project_embedded: false, is_user: false, selected: false, ...overrides };
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
}
it('offers only enabled models once per vendor/model and supports selection and clearing', async () => {
  useSettingsStore.setState({ printers: [preset('Alpha', '0.4'), preset('Alpha', '0.6'), preset('Beta', '0.4'),
    preset('Hidden', '0.4', { is_visible: false }), preset('Default', '0.4', { is_default: true }), preset('', '0.4')] });
  const fetch = vi.spyOn(globalThis, 'fetch');
  const onChange = vi.fn();
  function Fixture() {
    const [model, setModel] = useState<ConfiguredPrinterModel>();
    return <PrinterModelSelector value={model} onChange={next => { onChange(next); setModel(next); }} />;
  }
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<Fixture />));
  const trigger = container.querySelector('[data-testid="device-printer-model"]');
  expect(trigger?.textContent).toContain('Not specified');
  await click(trigger);
  const options = () => [...document.querySelectorAll('[role="option"]')];
  expect(options().map(option => option.textContent)).toEqual(['Not specified', 'Vendor · Alpha', 'Vendor · Beta']);
  await click(options().find(option => option.textContent === 'Vendor · Alpha')!);
  expect(onChange).toHaveBeenLastCalledWith({ vendorId: 'Vendor', model: 'Alpha' });
  expect(trigger?.textContent).toContain('Vendor · Alpha');
  await click(trigger);
  await click(options().find(option => option.textContent === 'Not specified')!);
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  expect(trigger?.textContent).toContain('Not specified');
  expect(fetch).not.toHaveBeenCalled();
});

it.each([false, true])('folds a vendorless H2D preset into its enabled model (user first: %s)', async userFirst => {
  const user = preset('Bambu Lab H2D', '0.4', { vendor_id: '', is_user: true });
  const system = preset('Bambu Lab H2D', '0.4', { vendor_id: 'BBL' });
  useSettingsStore.setState({ printers: [
    ...(userFirst ? [user, system] : [system, user]),
    preset('Bambu Lab H2D', '0.6', { vendor_id: 'BBL' }),
    preset('Bambu Lab H2D', '0.8', { vendor_id: '', is_project_embedded: true }),
    preset('Homebuilt', '0.4', { vendor_id: '', is_user: true }),
    preset('Homebuilt', '0.4', { vendor_id: 'Hidden vendor', is_visible: false }),
  ] });
  const fetch = vi.spyOn(globalThis, 'fetch');
  const onChange = vi.fn();
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<PrinterModelSelector value={{ vendorId: '', model: 'Bambu Lab H2D' }} onChange={onChange} />));
  const trigger = container.querySelector('[data-testid="device-printer-model"]');
  expect(trigger?.textContent).toContain('BBL · Bambu Lab H2D');
  await click(trigger);
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map(option => option.textContent)).toEqual(['Not specified', 'BBL · Bambu Lab H2D', 'Homebuilt']);
  expect(options[1].getAttribute('aria-selected')).toBe('true');
  expect(onChange).not.toHaveBeenCalled();
  await click(options[1]);
  expect(onChange).toHaveBeenLastCalledWith({ vendorId: 'BBL', model: 'Bambu Lab H2D' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps distinct vendors separate instead of guessing an ambiguous vendorless association', async () => {
  useSettingsStore.setState({ printers: [preset('Shared model', '0.4', { vendor_id: 'Vendor A' }),
    preset('Shared model', '0.4', { vendor_id: 'Vendor B' }), preset('Shared model', '0.4', { vendor_id: '', is_user: true })] });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<PrinterModelSelector value={undefined} onChange={() => undefined} />));
  await click(container.querySelector('[data-testid="device-printer-model"]'));
  expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent))
    .toEqual(['Not specified', 'Vendor A · Shared model', 'Vendor B · Shared model', 'Shared model']);
});
