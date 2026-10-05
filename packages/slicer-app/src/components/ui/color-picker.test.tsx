// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ColorValue } from '@orca/platform-contract';
import { ColorPicker } from './color-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ''; });
async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(element));
  return container;
}
async function fill(container: HTMLElement, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

it('synchronizes RGB/HEX and keyboard spectrum editing without coupling instances', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'solid', color: '#0000FF' });
    return <ColorPicker value={value} onChange={next => { setValue(next); changed(next); }} />;
  }
  const first = await mount(<Picker />), second = await mount(<Picker />);
  await fill(first, 'R value', '128');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#8000FF' });
  expect(second.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('#0000FF');
  const spectrum = first.querySelector('[aria-label="Color spectrum"]')!;
  await act(async () => spectrum.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#8305FF' });
  await fill(first, 'HEX color', 'invalid');
  expect(first.querySelector('input[aria-label="HEX color"]')!.getAttribute('aria-invalid')).toBe('true');
});

it('adds only valid unsaved favorites, exposes removal and never evicts at capacity', async () => {
  const add = vi.fn(), remove = vi.fn();
  const favorite: ColorValue = { kind: 'solid', color: '#112233' };
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#0000FF' }} onChange={() => undefined}
    favorites={[favorite]} onFavoriteAdd={add} onFavoriteRemove={remove} />);
  await act(async () => button(container, 'Add favorite color').click());
  expect(add).toHaveBeenCalledWith({ kind: 'solid', color: '#0000FF' });
  await act(async () => button(container, 'Remove favorite #112233').click());
  expect(remove).toHaveBeenCalledWith(favorite);
  const full = await mount(<ColorPicker value={{ kind: 'solid', color: '#FFFFFF' }} onChange={() => undefined}
    favorites={Array.from({ length: 24 }, (_, i) => ({ kind: 'solid', color: '#' + i.toString(16).padStart(6, '0') }))} onFavoriteAdd={add} />);
  expect(button(full, 'Add favorite color').disabled).toBe(true);
  expect(full.textContent).toContain('Remove a favorite');
});

it('uses pointer capture, clamps dragging outside the spectrum and stops on cancellation', async () => {
  const changed = vi.fn();
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#FF0000' }} onChange={changed} />);
  const spectrum = container.querySelector<HTMLElement>('[aria-label="Color spectrum"]')!;
  spectrum.getBoundingClientRect = () => ({ left: 0, top: 0, width: 360, height: 100 } as DOMRect);
  spectrum.setPointerCapture = vi.fn(); spectrum.releasePointerCapture = vi.fn();
  const dispatch = async (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    await act(async () => spectrum.dispatchEvent(event));
  };
  await dispatch('pointerdown', 240, 50);
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#0000FF' });
  await dispatch('pointermove', 500, 200);
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#000000' });
  await dispatch('pointercancel', 500, 200);
  changed.mockClear(); await dispatch('pointermove', 0, 50);
  expect(changed).not.toHaveBeenCalled();
});
