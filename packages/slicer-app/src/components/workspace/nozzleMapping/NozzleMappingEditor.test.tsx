// @vitest-environment jsdom
import { NozzleMappingConfirmation } from './NozzleMappingConfirmation';
import { mappingConfirmation } from './mappingConfirmation';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { NozzleMappingSnapshot } from '@slicer/client';
import { NozzleMappingEditor } from './NozzleMappingEditor';
import { publishNozzleRepairNotice } from './nozzleMappingNotices';
import { useProjectStore } from '@/stores/useProjectStore';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
const snapshot = (): NozzleMappingSnapshot => ({
  ok: true, plateId: 'A', revision: 1, eligible: true,
  nozzles: [1, 2, 3].map(id => ({ id, diameter: 0.4, capacity: 1 })), usedFilaments: [1, 3],
  modes: [0, 1, 2, 3].map(mode => ({ mode: mode as 0 | 1 | 2 | 3, available: mode !== 1, reason: mode === 1 ? 'Synchronization unavailable' : '' })),
  saved: { mode: 3, filamentMap: [1, 2, 1], volumeMap: null, nozzleMap: null },
  effective: { mode: 3, filamentMap: [1, 2, 1], volumeMap: [0, 0, 0], nozzleMap: [0, 0, 0] }, diagnostics: [],
});
let root: Root;
async function render(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(element));
}
async function choose(testId: string, name: string) {
  await act(async () => (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(o => o.textContent === name);
  expect(option).toBeDefined();
  await act(async () => { option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); option!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; useProjectStore.getState().reset(); });

it('edits only native-used rows, preserves hidden mappings and presents Nozzle Manual as Manual', async () => {
  const onMapping = vi.fn(); const onMode = vi.fn();
  await render(<NozzleMappingEditor snapshot={snapshot()} onMode={onMode} onMapping={onMapping} />);
  expect(document.querySelector('[data-testid="mapping-mode"]')?.textContent).toContain('Manual');
  expect(document.querySelector('[data-testid="mapping-filament-2"]')).toBeNull();
  expect(document.body.textContent).toContain('You can still slice');
  await choose('mapping-filament-3', 'Nozzle 3');
  expect(onMapping).toHaveBeenCalledWith([1, 2, 3]);
  expect(onMode).not.toHaveBeenCalled();
});

it('supports a temporary controlled draft and mode-first rendering', async () => {
  function Draft() {
    const [value, setValue] = useState(snapshot());
    return <NozzleMappingEditor snapshot={value} onMode={mode => setValue({ ...value, effective: { ...value.effective, mode } })}
      onMapping={filamentMap => setValue({ ...value, effective: { ...value.effective, filamentMap } })} />;
  }
  await render(<Draft />);
  await choose('mapping-filament-1', 'Nozzle 2');
  expect(document.querySelector('[data-testid="mapping-filament-1"]')?.textContent).toContain('Nozzle 2');
  await choose('mapping-mode', 'Auto For Flush');
  expect(document.querySelector('[data-testid="mapping-materials"]')).toBeNull();
  await choose('mapping-mode', 'Manual');
  expect(document.querySelector('[data-testid="mapping-filament-1"]')?.textContent).toContain('Nozzle 2');
});

it('shows an imported unavailable mode and hides the entire editor outside native eligibility', async () => {
  const base = snapshot(); const value = { ...base, effective: { ...base.effective, mode: 1 as const } };
  await render(<NozzleMappingEditor snapshot={value} onMode={vi.fn()} onMapping={vi.fn()} />);
  expect(document.body.textContent).toContain('Synchronization unavailable');
  expect(document.querySelector('[data-testid="mapping-materials"]')).toBeNull();
  await act(async () => root.render(<NozzleMappingEditor snapshot={{ ...value, eligible: false }} onMapping={vi.fn()} />));
  expect(document.body.textContent).toBe('');
});

it('reports only native-confirmed removed-nozzle repairs across Plates', () => {
  const base = { project: {}, objects: {}, parts: {}, plates: { A: { filament_map: '3,2' }, B: { filament_map: '2,1' } } };
  publishNozzleRepairNotice(base, { ...base, plates: { A: { filament_map: '1,2' }, B: { filament_map: '2,1' } } }, 2);
  expect(useProjectStore.getState().notices[0].message).toContain('1 filament mapping entries');
});


it('confirmation discards its temporary edits on cancel and permits a warning-only no-op confirmation', async () => {
  await render(<NozzleMappingConfirmation />);
  const native = snapshot(); let answer!: Promise<readonly number[] | null>;
  await act(async () => { answer = mappingConfirmation.request(native, 42); });
  await choose('mapping-filament-3', 'Nozzle 3');
  expect(native.effective.filamentMap).toEqual([1, 2, 1]);
  await act(async () => (document.querySelector('[data-testid="mapping-cancel"]') as HTMLElement).click());
  expect(await answer).toBeNull();
  await act(async () => { answer = mappingConfirmation.request(native, 42); });
  expect(document.body.textContent).toContain('You can still slice');
  const confirm = document.querySelector('[data-testid="mapping-confirm"]') as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => confirm.click());
  expect(await answer).toEqual([1, 2, 1]);
  expect(native.saved.mode).toBe(3);
});
