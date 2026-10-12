// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PresetCombobox } from './PresetCombobox';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; });

it.each(['combobox', 'select', 'vendor'] as const)('keeps project/user/system sections and native identities while searching %s', async mode => {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onValue = vi.fn();
  await act(async () => root.render(<PresetCombobox mode={mode === 'select' ? 'select' : 'combobox'}
    items={[{ id: 'sys', name: 'System canonical', label: 'System PLA', isProjectEmbedded: false, isUser: false },
      { id: 'user', name: 'User canonical', label: 'User PLA', isProjectEmbedded: false, isUser: true },
      { id: 'embedded', name: 'Embedded canonical', label: 'Project PLA', isProjectEmbedded: true, isUser: true }]}
    value="sys" onValue={onValue} disabled={false} modified={false} ariaLabel="Preset"
    searchPlaceholder="Search presets" emptyText="No presets"
    groupBy={mode === 'vendor' ? () => 'Generic' : undefined}
    sectionBy={mode === 'select' ? () => 'Compatible' : undefined} />));
  await act(async () => { (document.querySelector('[aria-label="Preset"]') as HTMLElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const headings = () => [...document.querySelectorAll('[data-slot$="label"]')]
    .map(node => node.textContent).filter(text => text === 'Project-inside presets' || text === 'User presets' || text === 'System presets');
  expect(headings()).toEqual(['Project-inside presets', 'User presets', 'System presets']);
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search presets"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'User PLA');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(headings()).toEqual(['User presets']);
  if (mode === 'vendor') {
    await act(async () => { (document.querySelector('[data-slot="dropdown-menu-sub-trigger"]') as HTMLElement).click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  const option = document.querySelector('[role="option"], [role="menuitemradio"]') as HTMLElement;
  expect(option.textContent).toContain('User PLA');
  await act(async () => {
    if (mode === 'select') {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    } else option.click();
  });
  expect(onValue.mock.calls[0]?.[0]).toBe('user');
});
