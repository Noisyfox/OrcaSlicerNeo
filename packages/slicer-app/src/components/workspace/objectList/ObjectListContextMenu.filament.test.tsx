// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ObjectListContextMenu } from './ObjectListContextMenu';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useObjectListStore } from './useObjectListStore';
import type { FilamentSessionSnapshot, ModelObjectStructure } from '@slicer/client';

const object: ModelObjectStructure = {
  id: 10, index: 0, name: 'Object', printable: true, instanceCount: 2,
  volumes: [{ id: 20, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
  instances: [{ id: 100, index: 0, printable: true }, { id: 101, index: 1, printable: true }],
};
const snapshot = {
  ok: true, version: 1,
  slots: [{ logicalId: 'filament-1', slot: 1, preset: { id: 'a', name: 'PLA', label: 'PLA' }, colour: { effective: '#112233', provenance: 'preset', native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid', colors: ['#112233'] } } }, { logicalId: 'filament-2', slot: 2, preset: { id: 'b', name: 'PETG', label: 'PETG' }, colour: { effective: '#445566', provenance: 'preset', native: { representative: '#445566', multiColour: '#445566', type: '1' }, display: { mode: 'solid', colors: ['#445566'] } } }],
  mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
  flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
  capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
  assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 7, project: 7, result: 0, plates: {} }, status: { state: 'ready', error: null },
} as unknown as FilamentSessionSnapshot;

function renderMenu(target: Parameters<typeof ObjectListContextMenu>[0]['target'], assignFilament: ReturnType<typeof vi.fn>) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const runtime = { assignFilament };
  root.render(<PlatformProvider value={{ runtime } as unknown as PlatformCapabilities}><ContextMenu open><ContextMenuTrigger><div /></ContextMenuTrigger><ObjectListContextMenu target={target} onClose={() => undefined} /></ContextMenu></PlatformProvider>);
  return { container, root };
}

async function openSubmenu(testid: string) {
  await act(async () => { (document.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click(); });
}

describe('Object List filament context command', () => {
  let root: Root | undefined;
  afterEach(() => { root?.unmount(); root = undefined; document.body.innerHTML = ''; useFilamentSessionStore.getState().reset(); });

  it('shows native multicolor partitions in Change Filament choices', async () => {
    const multi = { ...snapshot, slots: snapshot.slots.map((slot) => slot.slot === 2
      ? { ...slot, colour: { ...slot.colour, display: { mode: 'multicolor' as const, colors: ['#ff0000', '#00ff00'] } } }
      : slot) };
    useFilamentSessionStore.setState({ snapshot: multi });
    const rendered = renderMenu({ kind: 'object', object }, vi.fn()); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    await openSubmenu('objectlist-change-filament');
    const item = document.querySelector('[data-testid="objectlist-change-filament-2"]') as HTMLElement;
    const swatch = item.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    expect(swatch.style.backgroundImage).toContain('#ff0000 0%, #ff0000 50%, #00ff00 50%, #00ff00 100%');
  });

  it('dispatches the object command and deduplicates instance targets', async () => {
    const assignFilament = vi.fn(async () => ({ ok: false, version: 1, error: 'done', errorCode: 'test' }));
    useFilamentSessionStore.setState({ snapshot });
    useObjectListStore.setState({ projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set([100, 101]) } });
    const rendered = renderMenu({ kind: 'object', object }, assignFilament); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="objectlist-change-filament-default"]')).toBeNull();
    await act(async () => { (document.querySelector('[data-testid="objectlist-change-filament"]') as HTMLElement).click(); });
    const item = document.querySelector('[data-testid="objectlist-change-filament-2"]') as HTMLElement;
    expect(item).not.toBeNull();
    await act(async () => { item.click(); await Promise.resolve(); });
    expect(assignFilament).toHaveBeenCalledWith({ version: 1, revision: 7, slot: 2, targets: [{ kind: 'instance', id: 100 }, { kind: 'instance', id: 101 }] });
  });

  it('offers part Default/inherit and dispatches slot zero through the same command', async () => {
    const assignFilament = vi.fn(async () => ({ ok: false, version: 1, error: 'done', errorCode: 'test' }));
    useFilamentSessionStore.setState({ snapshot });
    useObjectListStore.setState({ projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set() } });
    const rendered = renderMenu({ kind: 'part', object, volume: object.volumes[0] }, assignFilament); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    await act(async () => { (document.querySelector('[data-testid="objectlist-change-filament"]') as HTMLElement).click(); });
    const item = document.querySelector('[data-testid="objectlist-change-filament-default"]') as HTMLElement;
    expect(item).not.toBeNull();
    await act(async () => { item.click(); await Promise.resolve(); });
    expect(assignFilament).toHaveBeenCalledWith({ version: 1, revision: 7, slot: 0, targets: [{ kind: 'model-part', id: 20 }] });
  });

  it('waits for a post-model refresh and uses its revision for a queued Slot 2 command', async () => {
    let releaseRefresh!: (value: FilamentSessionSnapshot) => void;
    const refreshed = { ...snapshot, revisions: { ...snapshot.revisions, session: 8, project: 8 } } as FilamentSessionSnapshot;
    const assignFilament = vi.fn(async (request: { revision: number }) => ({ ok: true as const, version: 1 as const, result: {
      snapshot: { ...refreshed, revisions: { ...refreshed.revisions, session: request.revision + 1, project: request.revision + 1 } },
      mutation: { kind: 'assign' as const, historyEntryDelta: 1 as const, revisionBefore: request.revision, revisionAfter: request.revision + 1,
        dirty: true as const, allPlateResultsInvalidated: false as const, affectedPlateIds: [] },
    } }));
    const runtime = {
      assignFilament,
      getFilamentSessionSnapshot: vi.fn(() => new Promise<FilamentSessionSnapshot>((resolve) => { releaseRefresh = resolve; })),
    };
    useFilamentSessionStore.setState({ snapshot, rejected: null });
    useObjectListStore.setState({ projection: { objectIds: new Set(), volumeIds: new Set(), instanceIds: new Set([100, 101]) } });
    const rendered = renderMenu({ kind: 'object', object }, assignFilament); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    const refresh = useFilamentSessionStore.getState().refresh(runtime as never);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await act(async () => { (document.querySelector('[data-testid="objectlist-change-filament"]') as HTMLElement).click(); });
    const item = document.querySelector('[data-testid="objectlist-change-filament-2"]') as HTMLElement;
    await act(async () => { item.click(); await Promise.resolve(); });
    expect(assignFilament).not.toHaveBeenCalled();
    releaseRefresh(refreshed);
    await refresh;
    await vi.waitFor(() => expect(assignFilament).toHaveBeenCalledOnce());
    expect(assignFilament).toHaveBeenCalledWith(expect.objectContaining({ revision: 8, slot: 2 }));
  });
  it('offers the five add submenus in Orca order for a full object and full instance', async () => {
    for (const selection of [{ objectIds: new Set([10]), volumeIds: new Set<number>(), instanceIds: new Set<number>() },
      { objectIds: new Set<number>(), volumeIds: new Set<number>(), instanceIds: new Set([100]) }]) {
      useObjectListStore.setState({ projection: selection });
      const rendered = renderMenu({ kind: 'object', object }, vi.fn()); root = rendered.root;
      await act(async () => { await Promise.resolve(); });
      const triggers = [...document.querySelectorAll('[data-testid^="objectlist-add-"][data-slot="context-menu-sub-trigger"]')];
      expect(triggers.map((t) => t.textContent)).toEqual(['Add Part', 'Add Negative Part', 'Add Modifier', 'Add Support Blocker', 'Add Support Enforcer']);
      await openSubmenu('objectlist-add-model_part');
      const menu = document.querySelector('[data-testid="objectlist-add-model_part-menu"]')!;
      expect([...menu.querySelectorAll('[role="menuitem"]')].map((t) => t.textContent)).toEqual(['Load...', 'Cube', 'Cylinder', 'Sphere', 'Cone', 'Disc', 'Torus']);
      await act(async () => { root?.unmount(); }); root = undefined;
      document.body.innerHTML = '';
    }
  });

  it('hides add menus for partial parts and multiple selections even with an object target', async () => {
    for (const selection of [{ objectIds: new Set([10, 11]), volumeIds: new Set<number>(), instanceIds: new Set<number>() },
      { objectIds: new Set<number>(), volumeIds: new Set([20]), instanceIds: new Set<number>() },
      { objectIds: new Set<number>(), volumeIds: new Set<number>(), instanceIds: new Set([100, 999]) }]) {
      useObjectListStore.setState({ projection: selection });
      const rendered = renderMenu({ kind: 'object', object }, vi.fn()); root = rendered.root;
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector('[data-testid="objectlist-add-model_part"]')).toBeNull();
      await act(async () => { root?.unmount(); }); root = undefined;
      document.body.innerHTML = '';
    }
  });

  it('hides filament commands for support and negative parts and a single-slot rack', async () => {
    for (const type of ['negative_volume', 'support_blocker', 'support_enforcer'] as const) {
      useFilamentSessionStore.setState({ snapshot });
      const rendered = renderMenu({ kind: 'part', object, volume: { ...object.volumes[0], type } }, vi.fn()); root = rendered.root;
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector('[data-testid="objectlist-change-filament"]')).toBeNull();
      await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = '';
    }
    useFilamentSessionStore.setState({ snapshot: { ...snapshot, slots: snapshot.slots.slice(0, 1) } });
    const rendered = renderMenu({ kind: 'object', object }, vi.fn()); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[data-testid="objectlist-change-filament"]')).toBeNull();
  });

  it('assigns a parameter modifier from the submenu', async () => {
    const assignFilament = vi.fn(async () => ({ ok: false, version: 1, error: 'done', errorCode: 'test' }));
    useFilamentSessionStore.setState({ snapshot });
    useObjectListStore.setState({ projection: { objectIds: new Set(), volumeIds: new Set([20]), instanceIds: new Set() } });
    const rendered = renderMenu({ kind: 'part', object, volume: { ...object.volumes[0], type: 'parameter_modifier' } }, assignFilament); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    await openSubmenu('objectlist-change-filament');
    await act(async () => { (document.querySelector('[data-testid="objectlist-change-filament-default"]') as HTMLElement).click(); });
    expect(assignFilament).toHaveBeenCalledWith(expect.objectContaining({ slot: 0, targets: [{ kind: 'parameter-modifier', id: 20 }] }));
  });

  it('assigns the complete mixed selection of whole objects and full instances', async () => {
    const assignFilament = vi.fn(async () => ({ ok: false, version: 1, error: 'done', errorCode: 'test' }));
    useFilamentSessionStore.setState({ snapshot });
    useObjectListStore.setState({ projection: { objectIds: new Set([11]), volumeIds: new Set(), instanceIds: new Set([100]) } });
    const rendered = renderMenu({ kind: 'object', object }, assignFilament); root = rendered.root;
    await act(async () => { await Promise.resolve(); });
    await openSubmenu('objectlist-change-filament');
    await act(async () => { (document.querySelector('[data-testid="objectlist-change-filament-2"]') as HTMLElement).click(); });
    expect(assignFilament).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ kind: 'object', id: 11 }, { kind: 'instance', id: 100 }] }));
  });

});
