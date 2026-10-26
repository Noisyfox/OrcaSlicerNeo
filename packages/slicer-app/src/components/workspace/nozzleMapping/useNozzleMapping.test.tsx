// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { HistoryStatus, NozzleMappingSnapshot, PlateSessionSnapshot } from '@slicer/client';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { publishNozzleMappingSnapshot, useNozzleMapping } from './useNozzleMapping';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const history = (revision: number): HistoryStatus => ({
  editingSession: null, navigationFloor: null, canUndo: false, canRedo: false,
  undoEntries: [], redoEntries: [], cursor: 0, savedCheckpoint: 0, savedCheckpointEvicted: false,
  dirty: false, bytesUsed: 0, byteBudget: 1e6, evictedEntryCount: 0, lastEvictedEntryId: null,
  oldestRetainedEntryId: null, oversizedEntryRetained: false, disabled: false, activeTransactionId: null, revision,
});
const plates = (currentPlateId = 'A', revision = 1): PlateSessionSnapshot => ({
  ok: true, version: 1, currentPlateId, inputRevisions: { A: revision, B: revision }, instances: [],
  plates: ['A', 'B'].map((plateId, displayIndex) => ({ plateId, displayIndex, name: plateId, origin: [0, 0, 0] })),
});
const mapping = (plateId = 'A', revision = 1): NozzleMappingSnapshot => ({
  ok: true, plateId, revision, eligible: true, nozzles: [{ id: 1, diameter: .4, capacity: 4 }], usedFilaments: [1], modes: [], diagnostics: [],
  saved: { mode: 2, filamentMap: [1], volumeMap: null, nozzleMap: null },
  effective: { mode: 2, filamentMap: [1], volumeMap: [0], nozzleMap: [0] },
});
let root: Root;
function Probe({ id }: { id: string }) {
  const value = useNozzleMapping();
  return <output data-testid={id} data-plate={value.snapshot?.plateId} data-editable={value.revision !== undefined}
    data-revision={value.snapshot?.revision} data-error={value.error ?? undefined} />;
}
async function mount(getNozzleMapping = vi.fn(async (id: string) => mapping(id))) {
  usePlateSessionStore.getState().setSnapshot(plates());
  useHistoryNavigationStore.getState().setStatus(history(1));
  const runtime = { getNozzleMapping } as unknown as PlatformCapabilities['runtime'];
  const platform = { runtime } as PlatformCapabilities;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PlatformProvider value={platform}>{['slice', 'plate', 'capacity'].map(id => <Probe key={id} id={id} />)}</PlatformProvider>));
  return { runtime, getNozzleMapping, output: () => container.querySelector('output')! };
}
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; usePlateSessionStore.getState().reset(); useHistoryNavigationStore.getState().reset(); });

it('shares one read across all consumers and reuses a still-current Plate', async () => {
  const view = await mount(); expect(view.getNozzleMapping).toHaveBeenCalledTimes(1);
  await act(async () => usePlateSessionStore.getState().setSnapshot(plates('B')));
  expect(view.getNozzleMapping).toHaveBeenCalledTimes(2);
  await act(async () => usePlateSessionStore.getState().setSnapshot(plates('A')));
  expect(view.output().dataset.plate).toBe('A'); expect(view.output().dataset.editable).toBe('true');
  expect(view.getNozzleMapping).toHaveBeenCalledTimes(2);
});

it('publishes a native mutation receipt atomically without a follow-up read', async () => {
  const view = await mount();
  await act(async () => {
    useHistoryNavigationStore.getState().setStatus(history(2));
    usePlateSessionStore.getState().setSnapshot(plates('A', 2));
    publishNozzleMappingSnapshot(view.runtime, mapping('A', 2), 2);
  });
  expect(view.output().dataset.revision).toBe('2'); expect(view.output().dataset.editable).toBe('true');
  expect(view.getNozzleMapping).toHaveBeenCalledTimes(1);
});

it('discards a delayed read after a newer native receipt and clears removed targets', async () => {
  let finish!: (value: NozzleMappingSnapshot) => void;
  const pending = new Promise<NozzleMappingSnapshot>(resolve => { finish = resolve; });
  const read = vi.fn((_id: string) => pending); const view = await mount(read);
  expect(view.output().dataset.editable).toBe('false');
  try {
    await act(async () => {
      useHistoryNavigationStore.getState().setStatus(history(2));
      usePlateSessionStore.getState().setSnapshot(plates('A', 2));
      publishNozzleMappingSnapshot(view.runtime, mapping('A', 2), 2);
    });
    await act(async () => finish(mapping('A', 1)));
    expect(view.output().dataset.revision).toBe('2'); expect(view.output().dataset.editable).toBe('true');
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => usePlateSessionStore.getState().reset());
    expect(view.output().dataset.plate).toBeUndefined(); expect(view.output().dataset.editable).toBe('false');
  } finally { await act(async () => finish(mapping())); }
});
