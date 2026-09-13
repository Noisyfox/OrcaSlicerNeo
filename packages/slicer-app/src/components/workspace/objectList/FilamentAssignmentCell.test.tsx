// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilamentAssignmentCell } from './FilamentAssignmentCell';
import type { FilamentSessionSnapshot } from '@slicer/client';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  ok: true, version: 1,
  slots: [{ slot: 1, preset: { id: 'a', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' } }, { slot: 2, preset: { id: 'b', name: 'PETG' }, colour: { effective: '#445566', provenance: 'preset' } }],
  mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
  flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
  capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
  assignments: { objects: [{ target: 'object', id: 10, objectId: 10, explicitSlot: 1, effectiveSlot: 1, inherited: false }], parts: [{ target: 'model-part', id: 20, objectId: 10, explicitSlot: 0, effectiveSlot: 1, inherited: true }], modifiers: [] },
  revisions: { session: 1, project: 1, result: 0, plates: {} }, status: { state: 'ready', error: null },
} as unknown as FilamentSessionSnapshot;

describe('FilamentAssignmentCell semantics', () => {
  let root: Root | undefined;
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    document.body.innerHTML = '';
  });

  async function render(element: React.ReactNode) {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(element); });
    return container;
  }

  async function choose(trigger: HTMLElement, label: string) {
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const item = [...document.body.querySelectorAll('[data-slot="select-item"]')]
      .find((candidate) => candidate.textContent === label) as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('uses the shadcn Select structure and shows an inherited effective slot', async () => {
    const container = await render(<FilamentAssignmentCell snapshot={base} kind="part" id={20} allowDefault />);
    const trigger = container.querySelector('[data-testid="filament-cell-part-20"]') as HTMLElement;

    expect(container.querySelector('select')).toBeNull();
    expect(trigger.getAttribute('data-slot')).toBe('select-trigger');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.className).toContain('italic');
    expect(trigger.textContent).toContain('Slot 1 · inherited');

    await act(async () => { trigger.click(); });
    expect(document.body.querySelector('[data-slot="select-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="select-group"] [data-slot="select-item"]')).not.toBeNull();
    expect([...document.body.querySelectorAll('[data-slot="select-item"]')].map((item) => item.textContent)).toEqual([
      'Default',
      'Slot 1 · inherited',
      'Slot 2',
    ]);
  });

  it('assigns numeric slots and exposes Default only for parts', async () => {
    const onPartAssign = vi.fn();
    const onObjectAssign = vi.fn();
    const container = await render(<>
      <FilamentAssignmentCell snapshot={base} kind="part" id={20} allowDefault onAssign={onPartAssign} />
      <FilamentAssignmentCell snapshot={base} kind="object" id={10} onAssign={onObjectAssign} />
    </>);
    const partTrigger = container.querySelector('[data-testid="filament-cell-part-20"]') as HTMLElement;
    const objectTrigger = container.querySelector('[data-testid="filament-cell-object-10"]') as HTMLElement;

    await choose(partTrigger, 'Default');
    expect(onPartAssign).toHaveBeenCalledWith(0);
    await act(async () => { objectTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const objectContent = document.getElementById(objectTrigger.getAttribute('aria-controls') ?? '') as HTMLElement;
    const objectItems = [...objectContent.querySelectorAll('[data-slot="select-item"]')];
    expect(objectItems.some((item) => item.textContent === 'Default')).toBe(false);
    const slot2 = objectItems.find((item) => item.textContent === 'Slot 2') as HTMLElement;
    await act(async () => {
      slot2.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      slot2.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onObjectAssign).toHaveBeenCalledWith(2);
  });

  it('disables assignment while pending and keeps unavailable rows inert', async () => {
    const onAssign = vi.fn();
    const container = await render(<>
      <FilamentAssignmentCell snapshot={base} kind="object" id={10} pending onAssign={onAssign} />
      <FilamentAssignmentCell snapshot={base} kind="part" id={20} assignable={false} />
      <FilamentAssignmentCell snapshot={null} kind="object" id={10} />
    </>);
    const trigger = container.querySelector('[data-testid="filament-cell-object-10"]') as HTMLButtonElement;

    expect(trigger.disabled).toBe(true);
    await act(async () => { trigger.click(); });
    expect(onAssign).not.toHaveBeenCalled();
    expect(container.querySelectorAll('span[data-testid^="filament-cell-"]')).toHaveLength(2);
  });

  it('does not bubble trigger or portal item events into an ObjectList row', async () => {
    const onAssign = vi.fn();
    const onRowClick = vi.fn();
    const onRowContextMenu = vi.fn();
    const onRowPointerDown = vi.fn();
    const container = await render(
      <div onClick={onRowClick} onContextMenu={onRowContextMenu} onPointerDown={onRowPointerDown}>
        <FilamentAssignmentCell snapshot={base} kind="object" id={10} onAssign={onAssign} />
      </div>,
    );
    const trigger = container.querySelector('[data-testid="filament-cell-object-10"]') as HTMLElement;

    await act(async () => { trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    await choose(trigger, 'Slot 2');
    expect(onAssign).toHaveBeenCalledWith(2);
    expect(onRowContextMenu).not.toHaveBeenCalled();
    expect(onRowPointerDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
