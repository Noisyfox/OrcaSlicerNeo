// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { FilamentRack } from './FilamentRack';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import type { FilamentSessionSnapshot, HistoryStatus } from '@slicer/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(overrides: Partial<FilamentSessionSnapshot> = {}): FilamentSessionSnapshot {
  return {
    ok: true, version: 1,
    slots: [
      { logicalId: 'filament-1', slot: 1, preset: { id: 'pla', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' } },
      { logicalId: 'filament-2', slot: 2, preset: { id: 'petg', name: 'PETG' }, colour: { effective: '#445566', provenance: 'user' } },
    ],
    mappings: { filament: [1, 2], volume: [0, 0], nozzle: [1, 2], filament2: [1, 2], physicalExtruder: [0] },
    flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
    capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
    assignments: {
      objects: [{ target: 'object', id: 10, objectId: 10, explicitSlot: 2, effectiveSlot: 2, inherited: false }],
      parts: [], modifiers: [],
    },
    revisions: { session: 4, project: 4, result: 0, plates: {} },
    status: { state: 'ready', error: null },
    ...overrides,
  } as FilamentSessionSnapshot;
}

function historyStatus(revision: number): HistoryStatus {
  return {
    editingSession: null, navigationFloor: null,
    canUndo: true, canRedo: false, undoLabel: 'Edit Filament', undoEntries: [{ id: 'entry-1', label: 'Edit Filament', category: 'project' as const }], redoEntries: [], cursor: revision,
    savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true, bytesUsed: 1,
    byteBudget: 10, evictedEntryCount: 0,
    lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
    disabled: false, activeTransactionId: null, revision,
  };
}

function mutation(snapshot: FilamentSessionSnapshot, kind: 'add' | 'delete' | 'set-colour' = 'add') {
  return { ok: true as const, version: 1 as const, result: {
    snapshot,
    mutation: {
      kind, historyEntryDelta: 1 as const, revisionBefore: snapshot.revisions.session - 1,
      revisionAfter: snapshot.revisions.session, dirty: true as const,
      allPlateResultsInvalidated: true,
    },
    historyStatus: historyStatus(snapshot.revisions.session),
  } };
}

function renderRack(runtime: Record<string, unknown>, onEditPreset?: (canonicalName: string) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const platform = { runtime, preferences: { load: vi.fn(async () => structuredClone(DEFAULT_USER_PREFERENCES)), save: vi.fn(async () => {}) } } as unknown as PlatformCapabilities;
  act(() => { root.render(<PlatformProvider value={platform}><FilamentRack onEditPreset={onEditPreset} /></PlatformProvider>); });
  return { container, root, platform };
}

async function openSlotAction(container: HTMLElement, slot: number, action: 'edit' | 'delete' | 'merge') {
  await act(async () => {
    container.querySelector(`[data-testid="filament-slot-${slot}"]`)!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }),
    );
    await Promise.resolve();
  });
  return document.querySelector(`[data-testid="filament-${action}-${slot}"]`) as HTMLElement | null;
}

async function editColor(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}
async function confirmColor() {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!.click());
}

describe('FilamentRack runtime interaction', () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = '';
    useFilamentSessionStore.getState().reset();
    useProjectStore.getState().reset();
  });

  it('dispatches Add and renders the complete returned snapshot, not an optimistic slot', async () => {
    const initial = makeSnapshot();
    const returned = makeSnapshot({
      slots: [...initial.slots, { logicalId: 'filament-3', slot: 3, preset: { id: 'abs', name: 'ABS' }, colour: { effective: '#778899', provenance: 'preset' } }],
      revisions: { ...initial.revisions, session: 5 },
    });
    const add = vi.fn(async () => mutation(returned));
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), addFilamentSlot: add };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const addButton = rendered.container.querySelector('[data-testid="filament-add"]') as HTMLButtonElement;
    await act(async () => { addButton.click(); await Promise.resolve(); });
    expect(add).toHaveBeenCalledWith({ version: 1, revision: 4 });
    expect(rendered.container.querySelector('[data-testid="filament-slot-3"]')).not.toBeNull();
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(5);
  });

  it('routes each slot action-menu Edit to that slot preset canonical name', async () => {
    const initial = makeSnapshot();
    useFilamentSessionStore.setState({ snapshot: initial });
    const onEditPreset = vi.fn();
    const rendered = renderRack({ getFilamentSessionSnapshot: vi.fn(async () => initial) }, onEditPreset);
    root = rendered.root;

    await act(async () => { await Promise.resolve(); });
    await act(async () => { (await openSlotAction(rendered.container, 2, 'edit'))?.click(); });

    expect(onEditPreset).toHaveBeenCalledOnce();
    expect(onEditPreset).toHaveBeenCalledWith('PETG');
  });

  it('keeps dialog color drafts local and commits one confirmed mutation', async () => {
    const initial = makeSnapshot();
    const returned = makeSnapshot({
      slots: initial.slots.map((slot) => slot.slot === 1 ? { ...slot, colour: { effective: '#445566', provenance: 'user' as const } } : slot),
      revisions: { ...initial.revisions, session: 5, project: 5 },
    });
    const setColour = vi.fn(async () => mutation(returned, 'set-colour'));
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), setFilamentSlotColour: setColour };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const trigger = rendered.container.querySelector('[data-testid="filament-colour-1"]') as HTMLButtonElement;
    await act(async () => trigger.click());
    await editColor('#223344');
    await editColor('#334455');
    expect(setColour).not.toHaveBeenCalled();
    expect(trigger.value).toBe('#112233');
    await editColor('#445566');
    await confirmColor();
    expect(setColour).toHaveBeenCalledTimes(1);
    expect(setColour).toHaveBeenCalledWith({ version: 1, revision: 4, slot: 1, colour: '#445566' });
    expect(useFilamentSessionStore.getState().snapshot?.revisions.project).toBe(5);
  });

  it('resets an uncommitted colour draft when an external snapshot arrives', async () => {
    const initial = makeSnapshot();
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial) };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const input = rendered.container.querySelector('[data-testid="filament-colour-1"]') as HTMLButtonElement;
    await act(async () => input.click());
    await editColor('#223344');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="HEX color"]')!.value).toBe('223344');
    await act(async () => {
      useFilamentSessionStore.setState({ snapshot: makeSnapshot({ slots: initial.slots.map((slot) => slot.slot === 1 ? { ...slot, colour: { effective: '#abcdef', provenance: 'user' as const } } : slot) }) });
    });
    expect(input.value).toBe('#abcdef');
    expect(document.querySelector('input[aria-label="HEX color"]')).toBeNull();
  });

  it('does not dispatch a color mutation when confirmation leaves the color unchanged', async () => {
    const initial = makeSnapshot();
    const setColour = vi.fn();
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), setFilamentSlotColour: setColour };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const input = rendered.container.querySelector('[data-testid="filament-colour-1"]') as HTMLButtonElement;
    await act(async () => input.click());
    await confirmColor();
    expect(setColour).not.toHaveBeenCalled();
  });

  it('cancels a referenced Delete without dispatching mutation or changing the snapshot', async () => {
    const initial = makeSnapshot();
    const deleteSlot = vi.fn(async () => mutation(initial, 'delete'));
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), deleteFilamentSlot: deleteSlot };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const deleteAction = await openSlotAction(rendered.container, 2, 'delete');
    await act(async () => { deleteAction?.click(); });
    expect(rendered.container.querySelector('[data-testid="filament-impact-summary"]')).not.toBeNull();
    await act(async () => { (rendered.container.querySelector('[data-testid="filament-impact-cancel"]') as HTMLButtonElement).click(); });
    expect(deleteSlot).not.toHaveBeenCalled();
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(4);
  });

  it('projects pending and rejected states and obeys native capability flags', async () => {
    const initial = makeSnapshot({ capabilities: { minSlots: 1, maxSlots: 2, nozzleCount: 1, flexible: true, canAdd: false, canDelete: false, canMerge: false } });
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), addFilamentSlot: vi.fn() };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    expect((rendered.container.querySelector('[data-testid="filament-add"]') as HTMLButtonElement).disabled).toBe(true);
    const deleteAction = await openSlotAction(rendered.container, 1, 'delete');
    const mergeAction = await openSlotAction(rendered.container, 1, 'merge');
    expect(deleteAction?.getAttribute('data-disabled')).not.toBeNull();
    expect(mergeAction?.getAttribute('data-disabled')).not.toBeNull();
    const rejected = { ok: false as const, version: 1 as const, error: 'native rejected', errorCode: 'native_validation_failure' };
    let release: ((value: typeof rejected) => void) | undefined;
    const pendingAdd = vi.fn(() => new Promise<typeof rejected>((resolve) => { release = resolve; }));
    const rejecting = { ...runtime, addFilamentSlot: pendingAdd };
    await act(async () => { root?.render(<PlatformProvider value={{ ...rendered.platform, runtime: rejecting } as unknown as PlatformCapabilities}><FilamentRack /></PlatformProvider>); await Promise.resolve(); });
    await act(async () => { useFilamentSessionStore.setState({ snapshot: makeSnapshot(), pendingKind: null, rejected: null }); });
    await act(async () => { (rendered.container.querySelector('[data-testid="filament-add"]') as HTMLButtonElement).click(); });
    expect(rendered.container.querySelector('[data-testid="filament-rack"]')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => { release?.(rejected); await Promise.resolve(); });
    expect(rendered.container.querySelector('[data-testid="filament-rejected"]')).not.toBeNull();
  });

  it('keeps Add visually enabled while a scene mutation is publishing its projections', async () => {
    const initial = makeSnapshot();
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), addFilamentSlot: vi.fn() };
    useFilamentSessionStore.setState({ snapshot: initial });
    useProjectStore.setState({ projectMutationPendingCount: 1 });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    expect((rendered.container.querySelector('[data-testid="filament-add"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders a rejected load state without discarding the last coherent rack', async () => {
    const initial = makeSnapshot();
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => { throw new Error('replacement read failed'); }) };
    const rendered = renderRack(runtime); root = rendered.root;

    await act(async () => { await Promise.resolve(); });

    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    expect(rendered.container.querySelector('[data-testid="filament-rejected"]')).not.toBeNull();
  });
});
