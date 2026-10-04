// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider, TOOLTIP_DELAY_MS } from '@/components/ui/tooltip';
import { ScopedConfigurationPanel, ScopedField } from './ScopedConfigurationPanel';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { Selection } from '../viewport/Selection';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import type { ScopedConfigurationField } from './scopedConfigurationProjection';

let root: Root | undefined;
let container: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function renderField(overrides: Partial<ScopedConfigurationField> = {},
  onCommit = vi.fn(async (_field: ScopedConfigurationField, value: string) => value),
  onReset = vi.fn(async (_field: ScopedConfigurationField) => {}), focusInput = true) {
  let field: ScopedConfigurationField = { key: 'layer_height', label: 'Layer height', category: 'Quality',
    meta: { type: 'float' } as ScopedConfigurationField['meta'], value: '0.2', mixed: false,
    source: 'object', local: true, resettable: true, ...overrides };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = async () => act(async () => root!.render(<TooltipProvider><ScopedField field={field}
    targets={[{ scope: 'object', id: '42', label: 'Object' }]}
    onCommit={onCommit} onReset={onReset} /></TooltipProvider>));
  await render();
  const input = container.querySelector('input')!;
  if (focusInput) await act(async () => input.focus());
  const rerender = async (next: Partial<ScopedConfigurationField>) => {
    field = { ...field, ...next };
    await render();
  };
  const change = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = async (value: string) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
  const getLabel = () => container.querySelector<HTMLElement>('[data-testid="config-option-label-layer_height"]')!;
  return { container, input, change, key, onCommit, onReset, rerender, getLabel };
}

describe('scoped field drafts', () => {
  it.each(['success', 'failure'] as const)('re-enables numeric steppers after commit %s', async (outcome) => {
    let resolve!: (value: string) => void;
    let reject!: (reason: Error) => void;
    const onCommit = vi.fn(() => new Promise<string>((yes, no) => { resolve = yes; reject = no; }));
    const view = await renderField({}, onCommit, undefined, false);
    const increase = view.container.querySelector<HTMLButtonElement>('[aria-label="Increase Layer height"]')!;
    const decrease = view.container.querySelector<HTMLButtonElement>('[aria-label="Decrease Layer height"]')!;
    await act(async () => increase.click());
    expect(increase.disabled).toBe(true);
    expect(decrease.disabled).toBe(true);
    await act(async () => {
      if (outcome === 'success') resolve('0.3');
      else reject(new Error('native rejection'));
    });
    expect(increase.disabled).toBe(false);
    expect(decrease.disabled).toBe(false);
    await act(async () => decrease.click());
    expect(onCommit).toHaveBeenCalledTimes(2);
    await act(async () => resolve('0.2'));
  });
  it('retains the native enum label after selection closes and the field remounts', async () => {
    const field = { key: 'fuzzy_skin', label: 'Fuzzy skin', value: 'none', meta: {
      type: 'enum' as const, enum_values: ['none', 'allwalls'], enum_labels: ['Painted only', 'All walls'],
    } };
    const { onCommit, rerender } = await renderField(field, undefined, undefined, false);
    const selectedText = () => container.querySelector('[data-slot="select-value"]')?.textContent;
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="config-input-fuzzy_skin"]')!;
    expect(selectedText()).toBe('Painted only');
    await act(async () => trigger().click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((element) => element.textContent?.includes('All walls'));
    expect(option).toBeDefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'allwalls');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(selectedText()).toBe('All walls');
    await rerender({ value: 'allwalls' });
    await act(async () => root!.render(null));
    await rerender({ value: 'allwalls' });
    expect(selectedText()).toBe('All walls');
  });

  it('highlights modified pages and groups across search, and resets only applicable native categories', async () => {
    const metadata = {
      layer_height: { type: 'float' as const, label: 'Layer height', category: 'Quality', scopes: ['project', 'object'] as const },
      initial_layer_print_height: { type: 'float' as const, label: 'First layer height', category: 'Quality', scopes: ['project', 'object'] as const },
      travel_speed: { type: 'float' as const, label: 'Travel speed', category: 'Speed', scopes: ['project', 'object'] as const },
      wall_loops: { type: 'int' as const, label: 'Wall loops', category: 'Strength', scopes: ['object'] as const },
      machine_gcode: { type: 'string' as const, label: 'Machine G-code', category: 'Machine', scopes: ['object'] as const },
    };
    useSettingsStore.setState({ configurationMode: 'project', metadata,
      baseValues: { layer_height: '0.2', initial_layer_print_height: '0.2', wall_loops: '2' },
      nativeScopedConfig: { project: { layer_height: '0.2' }, plates: {}, parts: {}, objects: { '42': { wall_loops: '3' } } } });
    const selection = new Selection();
    selection.replaceIds(['42']);
    const controller = { selection, computeSelectionKind: () => 'object',
      selectedVolumes: () => [...selection.ids].map((id) => ({ buffer: { objectId: Number(id), volumeId: 100 } })),
    } as unknown as SceneInteractionController;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<PlatformProvider value={{} as PlatformCapabilities}><TooltipProvider>
      <ScopedConfigurationPanel sceneInteraction={controller} />
    </TooltipProvider></PlatformProvider>));
    const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
    const resetDisabled = async (group: string, nativeCategory: string) => {
      await act(async () => button(`config-category-toggle-${group}`).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }),
      ));
      const item = document.querySelector(`[data-testid="config-reset-category-${nativeCategory}"]`)!;
      expect(item).not.toBeNull();
      const disabled = item.hasAttribute('data-disabled');
      await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      return disabled;
    };
    const quality = () => button('config-page-Quality');
    expect(button('config-mode-project').hasAttribute('data-local-override-highlight')).toBe(false);
    expect(button('config-mode-scoped').hasAttribute('data-local-override-highlight')).toBe(false);
    expect(quality().classList.contains('config-override-label')).toBe(true);
    expect(button('config-category-toggle-Layer height').getAttribute('data-local-override-highlight')).toBe('true');
    expect(await resetDisabled('Layer height', 'Quality')).toBe(false);
    expect(button('config-reset-all').disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Search settings"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="scoped-config-search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'First layer height');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="config-option-label-layer_height"]')).toBeNull();
    expect(button('config-category-toggle-Quality / Layer height').getAttribute('data-local-override-highlight')).toBe('true');
    expect(await resetDisabled('Quality / Layer height', 'Quality')).toBe(false);
    await act(async () => useSettingsStore.setState({ nativeScopedConfig: {
      project: {}, plates: {}, parts: {}, objects: { '42': { wall_loops: '3' } },
    } }));
    expect(button('config-category-toggle-Quality / Layer height').getAttribute('data-local-override-highlight')).toBe('false');
    expect(await resetDisabled('Quality / Layer height', 'Quality')).toBe(true);
    expect(button('config-reset-all').disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      button('config-mode-scoped').click();
    });
    expect(quality().classList.contains('config-override-label')).toBe(false);
    expect(button('config-page-Strength').classList.contains('config-override-label')).toBe(true);
    await act(async () => button('config-page-Strength').click());
    const walls = button('config-category-toggle-Walls');
    expect(walls.getAttribute('data-local-override-highlight')).toBe('true');
    expect(await resetDisabled('Walls', 'Strength')).toBe(false);
    expect(button('config-reset-all').disabled).toBe(false);
    await act(async () => useSettingsStore.setState({ nativeScopedConfig: {
      project: {}, plates: {}, parts: {}, objects: { '42': { machine_gcode: 'G28' } },
    } }));
    expect(walls.getAttribute('data-local-override-highlight')).toBe('false');
    expect(button('config-page-Strength').classList.contains('config-override-label')).toBe(false);
    expect(await resetDisabled('Walls', 'Strength')).toBe(true);
    expect(button('config-reset-all').disabled).toBe(true);
  });

  it('does not scan hidden Scoped overrides or render Project settings on selection changes', async () => {
    const hiddenScopedReads = vi.fn();
    const scopedObjects = new Proxy({ '42': { layer_height: '0.3' }, '43': { layer_height: '0.4' } }, {
      ownKeys(target) { hiddenScopedReads(); return Reflect.ownKeys(target); },
      get(target, key, receiver) { hiddenScopedReads(); return Reflect.get(target, key, receiver); },
    });
    useSettingsStore.setState({ configurationMode: 'project', metadata: {
      layer_height: { type: 'float', label: 'Layer height', scopes: ['project', 'object'] },
    }, baseValues: { layer_height: '0.2' }, nativeScopedConfig: {
      project: {}, plates: {}, parts: {}, objects: scopedObjects,
    } });
    const selection = new Selection();
    const controller = { selection, computeSelectionKind: () => 'object',
      selectedVolumes: () => [...selection.ids].map((id) => ({ buffer: { objectId: Number(id), volumeId: 100 } })),
    } as unknown as SceneInteractionController;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onRender = vi.fn();
    await act(async () => root!.render(<PlatformProvider value={{} as PlatformCapabilities}><TooltipProvider>
      <Profiler id="settings" onRender={onRender}><ScopedConfigurationPanel sceneInteraction={controller} /></Profiler>
    </TooltipProvider></PlatformProvider>));
    expect(hiddenScopedReads).not.toHaveBeenCalled();
    onRender.mockClear();
    await act(async () => { selection.replaceIds(['42']); });
    await act(async () => { selection.replaceIds(['43']); usePlateSessionStore.getState().reset(); });
    expect(onRender).not.toHaveBeenCalled();
    expect(hiddenScopedReads).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('[data-testid="config-input-layer_height"]')!.value).toBe('0.2');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="config-mode-scoped"]')!.click());
    expect(container.querySelector<HTMLInputElement>('[data-testid="config-input-layer_height"]')!.value).toBe('0.4');
    expect(hiddenScopedReads).toHaveBeenCalled();
    await act(async () => { selection.replaceIds(['42']); });
    expect(container.querySelector<HTMLInputElement>('[data-testid="config-input-layer_height"]')!.value).toBe('0.3');
  });

  it('retains a complete mixed-value draft until blur commits it', async () => {
    const { input, change, onCommit } = await renderField({ mixed: true, value: null, source: 'mixed' });
    for (const value of ['0', '0.2', '0.25']) {
      await change(value);
      expect(input.value).toBe(value);
    }
    await act(async () => input.blur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.anything(), '0.25');
  });

  it.each(['percent', 'float_or_percent'])('keeps native %s units visible and editable', async (type) => {
    const { input, change, key, onCommit } = await renderField({
      meta: { type } as ScopedConfigurationField['meta'], value: '100%',
    });
    expect(input.type).toBe('text');
    expect(input.value).toBe('100%');
    await change('125%');
    await key('Enter');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.anything(), '125%');
  });

  it('discards Escape without committing the draft from blur', async () => {
    const { input, change, key, onCommit } = await renderField();
    await change('0.4');
    await key('Escape');
    expect(input.value).toBe('0.2');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reconciles a normalized no-op value and suppresses unchanged Enter', async () => {
    const onCommit = vi.fn(async () => '0.2');
    const { input, change, key } = await renderField({}, onCommit);
    await change('0.200');
    await key('Enter');
    expect(input.value).toBe('0.2');
    await key('Enter');
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('highlights a local override label and removes the highlight after Reset updates the projection', async () => {
    const { container, getLabel, onReset, rerender } = await renderField();
    const label = getLabel();
    expect(label.getAttribute('data-local-override-highlight')).toBe('true');
    expect(label.classList.contains('config-override-label')).toBe(true);
    expect(container.querySelector('[data-testid="config-input-layer_height"]')!.classList.contains('config-override-label')).toBe(false);
    expect(container.querySelector('[data-testid="config-source-layer_height"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[data-testid="config-input-layer_height"]')!.hasAttribute('title')).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="config-reset-layer_height"]')!.click());
    expect(onReset).toHaveBeenCalledOnce();
    await rerender({ local: false, source: 'project' });

    expect(label.getAttribute('data-local-override-highlight')).toBe('false');
    expect(label.classList.contains('config-override-label')).toBe(false);
    expect(container.querySelector('[data-testid="config-reset-layer_height"]')).toBeNull();
  });

  it('waits for a sustained hover before showing the value-source tooltip', async () => {
    const { input } = await renderField({}, undefined, undefined, false);
    expect(input.hasAttribute('title')).toBe(false);

    await act(async () => {
      input.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: 10, clientY: 10 }));
      input.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
      await new Promise((resolve) => setTimeout(resolve, TOOLTIP_DELAY_MS - 100));
    });
    expect(document.body.querySelector('[data-slot="tooltip-content"]')).toBeNull();

    await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));

    expect(input.getAttribute('data-slot')).toBe('input');
    expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Effective value source: Object.');
  });

  it('does not highlight inherited values, mixed placeholders, or non-editable local fields', async () => {
    const inherited = await renderField({ local: false, source: 'project' });
    expect(inherited.getLabel().getAttribute('data-local-override-highlight')).toBe('false');
    expect(inherited.getLabel().classList.contains('config-override-label')).toBe(false);
    expect(inherited.input.classList.contains('config-override-label')).toBe(false);
    expect(container.querySelector('[data-testid="config-source-layer_height"]')).toBeNull();
    expect(inherited.input.hasAttribute('title')).toBe(false);

    await afterEachCleanupRender();
    const mixed = await renderField({ mixed: true, value: null, source: 'mixed' });
    expect(mixed.getLabel().getAttribute('data-local-override-highlight')).toBe('true');
    expect(mixed.getLabel().classList.contains('config-override-label')).toBe(true);
    expect(mixed.input.placeholder).toBe('Mixed');
    expect(mixed.input.classList.contains('config-override-label')).toBe(false);

    await afterEachCleanupRender();
    const nonEditable = await renderField({ local: true, resettable: false });
    expect(nonEditable.getLabel().getAttribute('data-local-override-highlight')).toBe('false');
    expect(nonEditable.getLabel().classList.contains('config-override-label')).toBe(false);
    expect(container.querySelector('[data-testid="config-reset-layer_height"]')).toBeNull();
  });
});

async function afterEachCleanupRender() {
  await act(async () => root?.unmount());
  container?.remove();
}
