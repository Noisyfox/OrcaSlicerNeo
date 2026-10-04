// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from './combobox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('clears popup search and restores results and focus without changing the selected preset', async () => {
  const onValueChange = vi.fn();
  function Picker() {
    const [search, setSearch] = useState('');
    return <Combobox value="Selected" onValueChange={onValueChange} inputValue={search}
      onInputValueChange={setSearch} items={['Selected', 'Other']}>
      <ComboboxTrigger><ComboboxValue /></ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput placeholder="Search presets" showTrigger={false} searchValue={search} onClearSearch={() => setSearch('')} />
        <ComboboxList>{(name: string) => <ComboboxItem key={name} value={name}>{name}</ComboboxItem>}</ComboboxList>
      </ComboboxContent>
    </Combobox>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Picker />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="combobox-trigger"]')!.click());
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Search presets"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Other');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click());
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="combobox-trigger"]')!.textContent).toBe('Selected');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Clear search"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
