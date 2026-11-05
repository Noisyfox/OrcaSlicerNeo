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
