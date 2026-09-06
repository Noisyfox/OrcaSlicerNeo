// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type UserPreferences } from '@orca/platform-contract';
import type { PresetInfo, PresetSnapshot, PresetSnapshotResult } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { SettingsPanel } from './SettingsPanel';

vi.mock('./MovePanel', () => ({ MovePanel: () => null }));
vi.mock('./RotatePanel', () => ({ RotatePanel: () => null }));
vi.mock('./ScalePanel', () => ({ ScalePanel: () => null }));

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function preset(name: string, isVisible = true): PresetInfo {
  return { name, is_visible: isVisible, is_default: false, vendor_id: '', model: '', variant: '', selected: false };
}

const initialSnapshot: PresetSnapshot = {
  ok: true,
  printers: [preset('Old Printer'), preset('New Printer')],
  // The false flag is deliberately retained: picker arrays are already bridge
  // candidates and must not be re-filtered by React.
  prints: [preset('Candidate Process B', false), preset('Candidate Process A')],
  filaments: [preset('Old Filament')],
  printer: { name: 'Old Printer', idx: 0 },
  print: { name: 'Candidate Process B', idx: 0 },
  filament: { name: 'Old Filament', idx: 0 },
};

const resolvedSnapshot: PresetSnapshot = {
  ok: true,
  printers: [preset('New Printer'), preset('Other Printer')],
  prints: [preset('Resolved Process')],
  filaments: [preset('Resolved Filament')],
  printer: { name: 'New Printer', idx: 4 },
  print: { name: 'Resolved Process', idx: 8 },
  filament: { name: 'Resolved Filament', idx: 12 },
};

function resetStores() {
  useProjectStore.getState().reset();
  useSettingsStore.setState({
    metadata: {},
    printers: initialSnapshot.printers,
    prints: initialSnapshot.prints,
    filaments: initialSnapshot.filaments,
    selectedPrinter: initialSnapshot.printer.name,
    selectedPrint: initialSnapshot.print.name,
    selectedFilament: initialSnapshot.filament.name,
    values: { layer_height: '0.12' },
  });
  useSlicerStore.setState({
    status: 'done', progress: 100, layers: 80, error: 'previous failure',
    resultExported: true, layer: 40, maxLayer: 79,
  });
}

function makePlatform(selectPreset: (kind: 'printer' | 'print' | 'filament', name: string) => Promise<PresetSnapshotResult>) {
  const preferences: UserPreferences = { version: 1, selectedProfiles: { printer: 'saved' }, ui: {} };
  const repository = {
    load: vi.fn(async () => preferences),
    save: vi.fn(async (next: UserPreferences) => { Object.assign(preferences, next); }),
  };
  return {
    platform: {
      runtime: {
        selectPreset: vi.fn(selectPreset),
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
      },
      preferences: repository,
    } as unknown as PlatformCapabilities,
    runtime: { selectPreset: undefined as unknown as ReturnType<typeof vi.fn> },
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
  });

  it('locks every selector, atomically applies the resolved snapshot, clears overrides, invalidates once, and persists the resolved triple', async () => {
    resetStores();
    let resolveSelection!: (snapshot: PresetSnapshotResult) => void;
    const pending = new Promise<PresetSnapshotResult>((resolve) => { resolveSelection = resolve; });
    const { platform, repository } = makePlatform(async () => pending);
    const { container, root } = await render(platform);
    roots.push(root);
    let slicerUpdates = 0;
    const unsubscribe = useSlicerStore.subscribe(() => { slicerUpdates += 1; });

    await selectOption(container, 'preset-select', 'New Printer');

    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="process-preset-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('[data-testid="filament-preset-select"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveSelection(resolvedSnapshot);
      await Promise.resolve();
    });
    unsubscribe();

    const settings = useSettingsStore.getState();
    expect(settings.printers).toBe(resolvedSnapshot.printers);
    expect(settings.prints).toBe(resolvedSnapshot.prints);
    expect(settings.filaments).toBe(resolvedSnapshot.filaments);
    expect([settings.selectedPrinter, settings.selectedPrint, settings.selectedFilament])
      .toEqual(['New Printer', 'Resolved Process', 'Resolved Filament']);
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
      selectedProfiles: { printer: 'New Printer', print: 'Resolved Process', filament: 'Resolved Filament' },
    }));
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('false');
    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the resolved session state when preference persistence fails', async () => {
    resetStores();
    const { platform, repository } = makePlatform(async () => resolvedSnapshot);
    repository.load.mockRejectedValueOnce(new Error('storage unavailable'));
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

});
