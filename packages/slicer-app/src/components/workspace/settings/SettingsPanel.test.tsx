// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type UserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, PresetInfo, ProfileSnapshot, ProfileSnapshotResult } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { SettingsPanel } from './SettingsPanel';

vi.mock('./MovePanel', () => ({ MovePanel: () => null }));
vi.mock('./RotatePanel', () => ({ RotatePanel: () => null }));
vi.mock('./ScalePanel', () => ({ ScalePanel: () => null }));

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function preset(name: string, isVisible = true): PresetInfo {
  return { name, is_visible: isVisible, is_default: false, vendor_id: '', model: '', variant: '', selected: false };
}

const initialSnapshot: ProfileSnapshot = {
  ok: true,
  printers: [preset('Old Printer'), preset('New Printer')],
  // The false flag is deliberately retained: picker arrays are already bridge
  // candidates and must not be re-filtered by React.
  prints: [preset('Candidate Process B', false), preset('Candidate Process A')],
  filamentCatalog: [preset('Old Filament')],
  printer: { name: 'Old Printer', idx: 0 },
  print: { name: 'Candidate Process B', idx: 0 },
};

const resolvedSnapshot: ProfileSnapshot = {
  ok: true,
  printers: [preset('New Printer'), preset('Other Printer')],
  prints: [preset('Resolved Process')],
  filamentCatalog: [preset('Resolved Filament')],
  printer: { name: 'New Printer', idx: 4 },
  print: { name: 'Resolved Process', idx: 8 },
};

const resolvedRack: FilamentSessionSnapshot = {
  ok: true, version: 1,
  slots: [{ slot: 1, preset: { id: 'Resolved Filament', name: 'Resolved Filament' }, colour: { effective: '#112233', provenance: 'preset' } }],
  mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
  flushing: { matrix: [0], vector: [], matrixDimension: 1, planeCount: 1, source: 'native' },
  capabilities: { minSlots: 1, maxSlots: 64, nozzleCount: 1, flexible: true, canAdd: true, canDelete: false, canMerge: false },
  assignments: { objects: [], parts: [], modifiers: [] },
  revisions: { session: 1, project: 1, result: 0, plates: {} },
  status: { state: 'ready', error: null },
};

function resetStores() {
  useProjectStore.getState().reset();
  usePlateSessionStore.getState().reset();
  useSettingsStore.setState({
    metadata: {},
    printers: initialSnapshot.printers,
    prints: initialSnapshot.prints,
    filamentCatalog: initialSnapshot.filamentCatalog,
    selectedPrinter: initialSnapshot.printer.name,
    selectedPrint: initialSnapshot.print.name,
    values: { layer_height: '0.12' },
  });
  useSlicerStore.setState({
    status: 'done', progress: 100, layers: 80, error: 'previous failure',
    resultExported: true, layer: 40, maxLayer: 79,
  });
}

function makePlatform(selectProfile: (kind: 'printer' | 'print', name: string) => Promise<ProfileSnapshotResult>) {
  const preferences: UserPreferences = { version: 1, selectedProfiles: { printer: 'saved' }, ui: {} };
  const repository = {
    load: vi.fn(async () => preferences),
    save: vi.fn(async (next: UserPreferences) => { Object.assign(preferences, next); }),
  };
  const runtime = {
        selectProfile: vi.fn(selectProfile),
        getFilamentSessionSnapshot: vi.fn(async () => resolvedRack),
        applyRememberedFilamentRack: vi.fn(async () => resolvedRack),
        markSharedConfigurationMutation: vi.fn(async () => ({
          ok: true,
          version: 1,
          currentPlateId: 'plate-1',
          plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0] as [number, number, number], name: 'Plate 1' }],
          instanceTransforms: [],
          inputRevisions: { 'plate-1': 1 },
          affectedPlateIdsBefore: ['plate-1'],
          affectedPlateIdsAfter: ['plate-1'],
          affectedPlateIds: ['plate-1'],
          dirtyReasons: ['shared-configuration'],
        })),
      };
  return {
    platform: {
      runtime,
      preferences: repository,
    } as unknown as PlatformCapabilities,
    runtime,
    repository,
    preferences,
  };
}

async function render(platform: PlatformCapabilities) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PlatformProvider value={platform}><SettingsPanel sceneInteraction={null} /></PlatformProvider>);
  });
  return { container, root };
}

async function selectOption(container: HTMLElement, triggerId: string, name: string) {
  await act(async () => {
    (container.querySelector(`[data-testid="${triggerId}"]`) as HTMLElement).click();
  });
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')]
    .find((element) => element.textContent === name);
  expect(item).toBeDefined();
  await act(async () => {
    item?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
}

describe('SettingsPanel preset transitions', () => {
  let roots: Root[] = [];

  afterEach(() => {
    roots.forEach((root) => root.unmount());
    roots = [];
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders bridge candidate arrays as-is and preserves their engine order', async () => {
    resetStores();
    const { platform } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform);
    roots.push(root);

    await act(async () => {
      (container.querySelector('[data-testid="process-preset-select"]') as HTMLElement).click();
    });

    expect([...document.querySelectorAll('[data-slot="combobox-item"]')].map((item) => item.textContent))
      .toEqual(['Candidate Process B', 'Candidate Process A']);
    expect(container.querySelector('[data-testid="filament-preset-select"]')).toBeNull();
    expect(container.querySelector('[data-testid="preset-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="process-preset-select"]')).not.toBeNull();
  });

  it('locks every selector, atomically applies the resolved snapshot, clears overrides, invalidates once, and persists the resolved triple', async () => {
    resetStores();
    let resolveSelection!: (snapshot: ProfileSnapshotResult) => void;
    const pending = new Promise<ProfileSnapshotResult>((resolve) => { resolveSelection = resolve; });
    const { platform, repository } = makePlatform(async () => pending);
    const { container, root } = await render(platform);
    roots.push(root);
    let slicerUpdates = 0;
    const unsubscribe = useSlicerStore.subscribe(() => { slicerUpdates += 1; });

    await selectOption(container, 'preset-select', 'New Printer');

    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="process-preset-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="filament-preset-select"]')).toBeNull();
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveSelection(resolvedSnapshot);
      await Promise.resolve();
    });
    unsubscribe();

    const settings = useSettingsStore.getState();
    expect(settings.printers).toBe(resolvedSnapshot.printers);
    expect(settings.prints).toBe(resolvedSnapshot.prints);
    expect(settings.filamentCatalog).toBe(resolvedSnapshot.filamentCatalog);
    expect([settings.selectedPrinter, settings.selectedPrint])
      .toEqual(['New Printer', 'Resolved Process']);
    expect(settings.values).toEqual({});
    expect((platform.runtime as unknown as { markSharedConfigurationMutation: ReturnType<typeof vi.fn> })
      .markSharedConfigurationMutation).toHaveBeenCalledOnce();
    expect(useProjectStore.getState()).toMatchObject({
      dirtyReasons: ['shared-configuration'],
      plateInputRevisions: { 'plate-1': 1 },
    });
    expect(slicerUpdates).toBe(1);
    expect(useSlicerStore.getState()).toMatchObject({
      status: 'idle', progress: 0, layers: 0, error: null,
      resultExported: false, layer: 0, maxLayer: 0,
    });
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      selectedProfiles: { printer: 'New Printer', print: 'Resolved Process' },
    }));
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('false');
    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the resolved session state when preference persistence fails', async () => {
    resetStores();
    const { platform, repository, preferences } = makePlatform(async () => resolvedSnapshot);
    repository.load.mockResolvedValueOnce(preferences).mockRejectedValueOnce(new Error('storage unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container, root } = await render(platform);
    roots.push(root);

    await selectOption(container, 'preset-select', 'New Printer');
    await act(async () => { await Promise.resolve(); });

    expect(useSettingsStore.getState().selectedPrinter).toBe('New Printer');
    expect(useSlicerStore.getState().status).toBe('idle');
    expect(useSlicerStore.getState().error).toBeNull();
    expect(log).toHaveBeenCalledWith(
      'preset preference save failed; keeping resolved session state',
      expect.any(Error),
    );
    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('applies the resolved printer remembered rack before publishing the profile transition', async () => {
    resetStores();
    const { platform, runtime, preferences } = makePlatform(async () => resolvedSnapshot);
    preferences.rememberedFilamentRacks = {
      'New Printer': { version: 1, slots: [{ preset: 'Resolved Filament', colour: '#112233' }] },
    };
    const { container, root } = await render(platform);
    roots.push(root);

    await selectOption(container, 'preset-select', 'New Printer');
    await act(async () => { await Promise.resolve(); });

    expect(runtime.applyRememberedFilamentRack).toHaveBeenCalledWith({
      version: 1, revision: 1,
      slots: [{ preset: 'Resolved Filament', colour: '#112233' }],
    });
    expect(runtime.applyRememberedFilamentRack.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.markSharedConfigurationMutation.mock.invocationCallOrder[0]);
    expect(runtime.markSharedConfigurationMutation.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.getFilamentSessionSnapshot.mock.invocationCallOrder.at(-1)!);
  });

  it('renders prime-tower controls with project and current-plate scope', async () => {
    resetStores();
    useSettingsStore.setState({ metadata: {
      enable_prime_tower: { type: 'bool', label: 'Enable Prime Tower', default: '0' },
      prime_tower_width: { type: 'float', label: 'Prime Tower Width', default: '20' },
      wipe_tower_x: { type: 'float', label: 'Prime Tower X', default: '0' },
      wipe_tower_y: { type: 'float', label: 'Prime Tower Y', default: '0' },
    } });
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-2',
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' },
        { plateId: 'plate-2', displayIndex: 1, origin: [220, 0, 0], name: 'Plate 2' }],
      inputRevisions: { 'plate-1': 4, 'plate-2': 7 }, instanceTransforms: [],
    });
    const { container, root } = await render(makePlatform(async () => resolvedSnapshot).platform);
    roots.push(root);
    expect(container.querySelector('#enable_prime_tower')).toBeTruthy();
    expect(container.querySelector('#prime_tower_width')).toBeTruthy();
    expect(container.querySelector('#wipe_tower_x')).toBeTruthy();
    expect(container.querySelector('#wipe_tower_y')).toBeTruthy();
    expect(container.querySelector('#wipe_tower_x')?.getAttribute('value')).toBe('0');
  });

});
