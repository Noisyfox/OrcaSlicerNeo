// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { FilamentRack } from './FilamentRack';
import { useFilamentSessionStore } from '../../stores/useFilamentSessionStore';
import type { FilamentSessionSnapshot } from '@slicer/client';

function makeSnapshot(overrides: Partial<FilamentSessionSnapshot> = {}): FilamentSessionSnapshot {
  return {
    ok: true, version: 1,
    slots: [
      { slot: 1, preset: { id: 'pla', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' } },
      { slot: 2, preset: { id: 'petg', name: 'PETG' }, colour: { effective: '#445566', provenance: 'user' } },
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

function mutation(snapshot: FilamentSessionSnapshot, kind: 'add' | 'delete' = 'add') {
  return { ok: true as const, version: 1 as const, result: {
    snapshot,
    mutation: {
      kind, historyEntryDelta: 1 as const, revisionBefore: snapshot.revisions.session - 1,
      revisionAfter: snapshot.revisions.session, dirty: true as const,
      allPlateResultsInvalidated: true,
    },
  } };
}

function renderRack(runtime: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const platform = { runtime } as unknown as PlatformCapabilities;
  act(() => { root.render(<PlatformProvider value={platform}><FilamentRack /></PlatformProvider>); });
  return { container, root };
}

describe('FilamentRack runtime interaction', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount(); root = undefined; document.body.innerHTML = '';
    useFilamentSessionStore.getState().reset();
  });

  it('dispatches Add and renders the complete returned snapshot, not an optimistic slot', async () => {
    const initial = makeSnapshot();
    const returned = makeSnapshot({
      slots: [...initial.slots, { slot: 3, preset: { id: 'abs', name: 'ABS' }, colour: { effective: '#778899', provenance: 'preset' } }],
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

  it('cancels a referenced Delete without dispatching mutation or changing the snapshot', async () => {
    const initial = makeSnapshot();
    const deleteSlot = vi.fn(async () => mutation(initial, 'delete'));
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => initial), deleteFilamentSlot: deleteSlot };
    useFilamentSessionStore.setState({ snapshot: initial });
    const rendered = renderRack(runtime); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    await act(async () => { (rendered.container.querySelector('[data-testid="filament-delete-2"]') as HTMLButtonElement).click(); });
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
    expect((rendered.container.querySelector('[data-testid="filament-delete-1"]') as HTMLButtonElement).disabled).toBe(true);
    expect((rendered.container.querySelector('[data-testid="filament-merge-1"]') as HTMLButtonElement).disabled).toBe(true);
    const rejected = { ok: false as const, version: 1 as const, error: 'native rejected', errorCode: 'native_validation_failure' };
    let release: ((value: typeof rejected) => void) | undefined;
    const pendingAdd = vi.fn(() => new Promise<typeof rejected>((resolve) => { release = resolve; }));
    const rejecting = { ...runtime, addFilamentSlot: pendingAdd };
    await act(async () => { root?.render(<PlatformProvider value={{ runtime: rejecting } as unknown as PlatformCapabilities}><FilamentRack /></PlatformProvider>); await Promise.resolve(); });
    await act(async () => { useFilamentSessionStore.setState({ snapshot: makeSnapshot(), pendingKind: null, rejected: null }); });
    await act(async () => { (rendered.container.querySelector('[data-testid="filament-add"]') as HTMLButtonElement).click(); });
    expect(rendered.container.querySelector('[data-testid="filament-rack"]')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => { release?.(rejected); await Promise.resolve(); });
    expect(rendered.container.querySelector('[data-testid="filament-rejected"]')).not.toBeNull();
  });

  it('renders a rejected load state without an unhandled rejection or stale project rack', async () => {
    const initial = makeSnapshot();
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => { throw new Error('replacement read failed'); }) };
    const rendered = renderRack(runtime); root = rendered.root;

    await act(async () => { await Promise.resolve(); });

    expect(useFilamentSessionStore.getState().snapshot).toBeNull();
    expect(rendered.container.querySelector('[data-testid="filament-rejected"]')).not.toBeNull();
  });
});
