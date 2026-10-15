// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ColorValue } from '@orca/platform-contract';
import { ColorPicker } from './color-picker';
import { ColorPickerPopover } from './color-picker-popover';
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
async function blurHex(container: HTMLElement) {
  await act(async () => container.querySelector('input[aria-label="HEX color"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

it('previews HEX edits immediately without rewriting text until blur, and preserves the last valid color', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'solid', color: '#123456' });
    return <ColorPicker value={value} onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  await fill(container, 'HEX color', '#aBc');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('#aBc');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="R value"]')!.value).toBe('170');
  expect(changed).toHaveBeenCalledExactlyOnceWith({ kind: 'solid', color: '#AABBCC' });
  await blurHex(container);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('AABBCC');
  expect(changed).toHaveBeenCalledTimes(1);
  await fill(container, 'HEX color', 'invalid');
  await blurHex(container);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLInputElement>('input[aria-label="R value"]')!.value).toBe('170');
});

it('synchronizes RGB/HEX and keyboard spectrum editing without coupling instances', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'solid', color: '#0000FF' });
    return <ColorPicker value={value} onChange={next => { setValue(next); changed(next); }} />;
  }
  const first = await mount(<Picker />), second = await mount(<Picker />);
  await fill(first, 'R value', '128');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#8000FF' });
  expect(second.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('0000FF');
  const spectrum = first.querySelector('[aria-label="Color spectrum"]')!;
  await act(async () => spectrum.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#8305FF' });
  await fill(first, 'HEX color', 'invalid');
  expect(first.querySelector('input[aria-label="HEX color"]')!.getAttribute('aria-invalid')).toBe('true');
});

it('adds valid favorites and permits both new saves and promotions at sixteen-slot capacity', async () => {
  const add = vi.fn(), remove = vi.fn();
  const favorite: ColorValue = { kind: 'solid', color: '#112233' };
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#0000FF' }} onChange={() => undefined}
    favorites={[favorite]} onFavoriteAdd={add} onFavoriteRemove={remove} />);
  await act(async () => button(container, 'Add favorite color').click());
  expect(add).toHaveBeenCalledWith({ kind: 'solid', color: '#0000FF' });
  expect(container.querySelector('button[aria-label^="Remove favorite"]')).toBeNull();
  await act(async () => button(container, 'Favorite #112233').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })));
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Remove favorite')!.click());
  expect(remove).toHaveBeenCalledWith(favorite);
  const full = await mount(<ColorPicker value={{ kind: 'solid', color: '#FFFFFF' }} onChange={() => undefined}
    favorites={Array.from({ length: 16 }, (_, i) => ({ kind: 'solid', color: '#' + i.toString(16).padStart(6, '0') }))} onFavoriteAdd={add} />);
  expect(button(full, 'Add favorite color').disabled).toBe(false);
  await act(async () => button(full, 'Add favorite color').click());
  expect(add).toHaveBeenLastCalledWith({ kind: 'solid', color: '#FFFFFF' });
  expect(full.querySelector('[aria-label="Favorite colors"]')!.children).toHaveLength(16);
  const promote = await mount(<ColorPicker value={{ kind: 'solid', color: '#000007' }} onChange={() => undefined}
    favorites={Array.from({ length: 16 }, (_, i) => ({ kind: 'solid', color: '#' + i.toString(16).padStart(6, '0') }))} onFavoriteAdd={add} />);
  expect(button(promote, 'Add favorite color').disabled).toBe(false);
  await act(async () => button(promote, 'Add favorite color').click());
  expect(add).toHaveBeenLastCalledWith({ kind: 'solid', color: '#000007' });
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
    const [value, setValue] = useState<ColorValue>({ kind: 'linear-gradient', colors: ['#FF0000FF', '#0000FFFF'] });
    return <ColorPicker value={value} enableAlpha enableGradient onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  await fill(container, 'Alpha value', '0');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#FF000000', '#0000FFFF'] });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.getAttribute('aria-label') === 'Gradient color 2')!.click());
  await fill(container, 'Alpha value', '50');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#FF000000', '#0000FF80'] });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.getAttribute('aria-label') === 'Gradient color 1')!.click());
  await fill(container, 'Alpha value', '100');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#FF0000FF', '#0000FF80'] });
});

it('hides unsupported gradients, shows stored alpha swatches and rejects transparent HEX when alpha is disabled', async () => {
  const favorites: ColorValue[] = [{ kind: 'solid', color: '#11223380' }, { kind: 'linear-gradient', colors: ['#000000', '#FFFFFF'] }];
  const changed = vi.fn(), remove = vi.fn();
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#FFFFFF' }} onChange={changed} favorites={favorites} onFavoriteRemove={remove} />);
  expect(container.querySelectorAll('button[aria-label^="Favorite "]')).toHaveLength(1);
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
    return <ColorPickerPopover value={{ kind: 'solid', color: '#123456' }} open={open} onOpenChange={setOpen}
      onConfirm={confirm} onFavoriteAdd={favorite} trigger={<Button>Open picker</Button>} />;
  }
  const container = await mount(<Picker />);
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Open picker')!;
  await act(async () => trigger.click());
  await fill(document.body, 'HEX color', '#654321');
  await blurHex(document.body);
  await act(async () => button(document.body, 'Add favorite color').click());
  expect(favorite).toHaveBeenCalledWith({ kind: 'solid', color: '#654321' });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel')!.click());
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => trigger.click());
  expect(document.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('123456');
  await fill(document.body, 'HEX color', '#ABCDEF');
  await blurHex(document.body);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Confirm')!.click());
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ kind: 'solid', color: '#ABCDEF' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(document.activeElement).toBe(trigger);
});

it('keeps hue 360 at the right edge when the caller canonicalizes HEX case', async () => {
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'solid', color: '#0000ff' });
    return <ColorPicker value={value} onChange={next => next.kind === 'solid' && setValue({ ...next, color: next.color.toLowerCase() })} />;
  }
  const container = await mount(<Picker />);
  await fill(container, 'H value', '360');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="H value"]')!.value).toBe('360');
  expect(container.querySelector<HTMLElement>('.color-spectrum-pointer')!.style.left).toBe('100%');
});

it('blocks confirmation for invalid HEX and discards the draft on Escape', async () => {
  const confirm = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(false);
    return <ColorPickerPopover value={{ kind: 'solid', color: '#123456' }} open={open} onOpenChange={setOpen}
      onConfirm={confirm} enableAlpha trigger={<Button>Open picker</Button>} />;
  }
  const container = await mount(<Picker />);
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open picker')!;
  await act(async () => trigger.click());
  await fill(document.body, 'HEX color', 'invalid');
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!.disabled).toBe(true);
  await act(async () => document.querySelector('input[aria-label="HEX color"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('input[aria-label="HEX color"]')).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
});

it('applies changed capabilities when confirming an already open dialog', async () => {
  const confirm = vi.fn();
  let disable: () => void;
  function Picker() {
    const [enabled, setEnabled] = useState(true);
    disable = () => setEnabled(false);
    return <ColorPickerPopover value={{ kind: 'linear-gradient', colors: ['#12345680', '#ABCDEFFF'] }}
      open trigger={<Button>Open picker</Button>} onOpenChange={() => undefined} onConfirm={confirm} enableAlpha={enabled} enableGradient={enabled} />;
  }
  await mount(<Picker />);
  await act(async () => disable());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!.click());
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ kind: 'solid', color: '#123456' });
});

it('adds up to seven ordered gradient colors, edits alpha independently, removes the active stop and restores the original', async () => {
  const changed = vi.fn(), favorite = vi.fn();
  const initial: ColorValue = { kind: 'solid', color: '#FF000080' };
  function Picker() {
    const [value, setValue] = useState(initial);
    return <ColorPicker value={value} enableGradient enableAlpha onFavoriteAdd={favorite}
      onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Gradient')!.click());
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#FF000080', '#BFFF0080'] });
  for (let i = 0; i < 5; ++i) await act(async () => button(container, 'Add color').click());
  expect(container.querySelectorAll('[role="tab"][aria-label^="Gradient color"]')).toHaveLength(7);
  expect(button(container, 'Add color').disabled).toBe(true);
  const count = changed.mock.calls.length;
  await act(async () => button(container, 'Add color').click());
  expect(changed).toHaveBeenCalledTimes(count);
  await fill(container, 'Alpha value', '0');
  const gradient = changed.mock.calls.at(-1)![0];
  expect(gradient.colors).toHaveLength(7);
  expect(gradient.colors[0]).toBe('#FF000080');
  expect(gradient.colors[5].slice(-2)).toBe('00');
  await act(async () => button(container, 'Add favorite color').click());
  expect(favorite).toHaveBeenLastCalledWith(gradient);
  await act(async () => button(container, 'Remove color').click());
  expect(changed.mock.calls.at(-1)![0].colors).toEqual(gradient.colors.filter((_: string, index: number) => index !== 5));
  await act(async () => button(container, 'Original color').click());
  expect(changed).toHaveBeenLastCalledWith(initial);
  expect(container.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!.value).toBe('FF000080');
});

it('preserves exact alpha bytes on stop switches and six-digit HEX edits, and restores each mode independently', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'linear-gradient', colors: ['#11223301', '#445566FE', '#77889980'] });
    return <ColorPicker value={value} enableGradient enableAlpha onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  const stop = (index: number) => container.querySelector<HTMLButtonElement>(`[aria-label="Gradient color ${index}"]`)!;
  await act(async () => stop(3).click());
  await fill(container, 'HEX color', 'abcdef');
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#11223301', '#445566FE', '#ABCDEF80'] });
  await act(async () => stop(1).click());
  expect(container.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!.value).toBe('11223301');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Solid')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Gradient')!.click());
  expect(changed).toHaveBeenLastCalledWith({ kind: 'linear-gradient', colors: ['#11223301', '#445566FE', '#ABCDEF80'] });
});

it('filters palette colors by name and HEX, clears on Escape and keeps the popover open', async () => {
  const confirm = vi.fn(), ui = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(true);
    return <ColorPickerPopover value={{ kind: 'solid', color: '#123456' }} open={open} onOpenChange={setOpen}
      onConfirm={confirm} onUiStateChange={ui} trigger={<Button>Open picker</Button>} />;
  }
  await mount(<Picker />);
  await act(async () => button(document.body, 'Palettes').click());
  expect(ui).toHaveBeenLastCalledWith({ sidebarOpen: true, paletteId: 'basic' });
  await act(async () => button(document.body, 'Search colors').click());
  await fill(document.body, 'Filter colors', 'ff8000');
  const presets = document.querySelector('[aria-label="Preset colors"]')!;
  expect(presets.textContent).toBe('Orange');
  await fill(document.body, 'Filter colors', 'no-such-color');
  expect(presets.textContent).toContain('No matching colors');
  await act(async () => document.querySelector('[aria-label="Filter colors"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[aria-label="HEX color"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Filter colors"]')).toBeNull();
  expect(document.querySelector('[aria-label="Preset colors"]')!.textContent).toContain('Orange');
  expect(confirm).not.toHaveBeenCalled();
});

it('clamps out-of-range channels, blocks empty edits and recovers every editor after a spectrum pick', async () => {
  const confirm = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(true);
    return <ColorPickerPopover value={{ kind: 'solid', color: '#123456' }} open={open} onOpenChange={setOpen}
      onConfirm={confirm} trigger={<Button>Open picker</Button>} />;
  }
  await mount(<Picker />);
  await fill(document.body, 'R value', '256');
  const confirmButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!;
  expect(confirmButton.disabled).toBe(false);
  expect(document.querySelector<HTMLInputElement>('[aria-label="R value"]')!.value).toBe('255');
  await fill(document.body, 'R value', '');
  expect(confirmButton.disabled).toBe(true);
  await fill(document.body, 'HEX color', 'invalid');
  await act(async () => document.querySelector('[aria-label="Color spectrum"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(confirmButton.disabled).toBe(false);
  expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
});

it('steps numeric fields and saturation with the mouse wheel without losing alpha', async () => {
  const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<ColorValue>({ kind: 'solid', color: '#11223301' });
    return <ColorPicker value={value} enableAlpha onChange={next => { setValue(next); changed(next); }} />;
  }
  const container = await mount(<Picker />);
  const red = container.querySelector('[aria-label="R value"]')!;
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
  await act(async () => red.dispatchEvent(wheel));
  expect(wheel.defaultPrevented).toBe(true);
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#12223301' });
  const saturation = container.querySelector('[data-slot="slider"][aria-label="Saturation"]')!;
  const before = Number(container.querySelector<HTMLInputElement>('[aria-label="S value"]')!.value);
  await act(async () => saturation.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })));
  expect(Number(container.querySelector<HTMLInputElement>('[aria-label="S value"]')!.value)).toBe(before - 5);
  expect(changed.mock.calls.at(-1)![0].color.slice(-2)).toBe('01');
});

it('normalizes a translucent favorite immediately when the opaque caller already has the same RGB', async () => {
  const changed = vi.fn();
  const container = await mount(<ColorPicker value={{ kind: 'solid', color: '#112233' }} onChange={changed}
    favorites={[{ kind: 'solid', color: '#11223380' }]} />);
  await act(async () => button(container, 'Favorite #11223380').click());
  expect(changed).toHaveBeenLastCalledWith({ kind: 'solid', color: '#112233' });
  expect(container.querySelector<HTMLInputElement>('[aria-label="HEX color"]')!.value).toBe('112233');
  expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
});
