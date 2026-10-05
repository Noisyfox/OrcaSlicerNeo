// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ColorValue } from '@orca/platform-contract';
import { ColorPicker } from './color-picker';
import { ColorPickerDialog } from './color-picker-dialog';
import { Button } from './button';

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

it('preserves RGB at zero alpha and independently edits gradient endpoints', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'linear-gradient', start: '#FF0000FF', end: '#0000FFFF' });
    return <ColorPicker value={value} enableAlpha enableGradient onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  await fill(container, 'Alpha value', '0');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', start: '#FF000000', end: '#0000FFFF' });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'End')!.click());
  await fill(container, 'Alpha value', '50');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', start: '#FF000000', end: '#0000FF80' });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Start')!.click());
  await fill(container, 'Alpha value', '100');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', start: '#FF0000FF', end: '#0000FF80' });
});

it('hides unsupported favorites without deleting them and rejects transparent HEX when alpha is disabled', async () => {
  const favorites: ColorValue[] = [{ kind: 'solid', color: '#11223380' }, { kind: 'linear-gradient', start: '#000000', end: '#FFFFFF' }];
  const changed = vi.fn(), remove = vi.fn();
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#FFFFFF' }} onChange={changed} favorites={favorites} onFavoriteRemove={remove} />);
  expect(container.querySelectorAll('button[aria-label^="Favorite "]')).toHaveLength(0);
  expect(container.querySelector('input[aria-label="Alpha value"]')).toBeNull();
  await fill(container, 'HEX color', '#11223380');
  expect(changed).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(favorites).toHaveLength(2);
});

it('dialog commits once, cancels drafts, retains explicit favorites and restores focus', async () => {
  const confirm = vi.fn(), favorite = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(false);
    return <ColorPickerDialog value={{ kind: 'solid', color: '#123456' }} open={open} onOpenChange={setOpen}
      onConfirm={confirm} onFavoriteAdd={favorite} trigger={<Button>Open picker</Button>} />;
  }
  const container = await mount(<Picker />);
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Open picker')!;
  await act(async () => trigger.click());
  await fill(document.body, 'HEX color', '#654321');
  await act(async () => button(document.body, 'Add favorite color').click());
  expect(favorite).toHaveBeenCalledWith({ kind: 'solid', color: '#654321' });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel')!.click());
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  expect(document.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('#123456');
  await fill(document.body, 'HEX color', '#ABCDEF');
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Confirm')!.click());
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ kind: 'solid', color: '#ABCDEF' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(document.activeElement).toBe(trigger);
});
