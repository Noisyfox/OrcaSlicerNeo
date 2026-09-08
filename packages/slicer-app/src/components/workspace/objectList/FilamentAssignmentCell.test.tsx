// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FilamentAssignmentCell } from './FilamentAssignmentCell';
import type { FilamentSessionSnapshot } from '@slicer/client';

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
  afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; });
  it('shows inherited parts and permits Default, while object assignment does not expose Default', () => {
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    act(() => { root?.render(<><FilamentAssignmentCell snapshot={base} kind="part" id={20} allowDefault /><FilamentAssignmentCell snapshot={base} kind="object" id={10} /></>); });
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[];
    expect(selects[0].className).toContain('italic');
    expect(selects[0].value).toBe('1');
    expect([...selects[0].options].some((option) => option.value === '0')).toBe(true);
    expect([...selects[1].options].some((option) => option.value === '0')).toBe(false);
  });
});
