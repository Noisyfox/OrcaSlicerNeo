// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type RememberedFilamentRack, type UserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, PresetInfo, ProfileSnapshot, ProfileSnapshotResult, PrinterTransitionResult } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '../../../stores/useHistoryNavigationStore';
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

function printerTransition(profileSnapshot = resolvedSnapshot, filamentSession = resolvedRack): PrinterTransitionResult {
  const affectedPlateIds = ['plate-1'];
  return {
    ok: true, profileSnapshot, filamentSession,
    plateSession: {
      ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
      instances: [], instanceTransforms: [], inputRevisions: { 'plate-1': 1 },
      affectedPlateIdsBefore: affectedPlateIds, affectedPlateIdsAfter: affectedPlateIds,
      affectedPlateIds, dirtyReasons: ['shared-configuration'],
    },
    historyStatus: {
      canUndo: true, canRedo: false, undoLabel: 'Select Printer',
      undoEntries: [{ id: 'entry-1', label: 'Select Printer', category: 'project' }], redoEntries: [],
      cursor: 1, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
      bytesUsed: 128, byteBudget: 256 * 1024 * 1024, evictedEntryCount: 0,
      lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
      disabled: false, activeTransactionId: null, revision: 1,
    },
    nativeScopedConfig: {
      version: 1, revision: 1, kind: 'full',
      snapshot: { project: {}, objects: {}, parts: {}, plates: {} }, removedTargets: [],
    },
    mutation: {
      kind: 'select-printer-with-remembered-rack', historyEntryDelta: 1,
      revisionBefore: 0, revisionAfter: 1, dirty: true,
      allPlateResultsInvalidated: true, affectedPlateIds,
    },
  };
}

function resetStores() {
  useProjectStore.getState().reset();
  usePlateSessionStore.getState().reset();
  useFilamentSessionStore.getState().reset();
  useHistoryNavigationStore.getState().reset();
    useSettingsStore.setState({
      metadata: {},
    printers: initialSnapshot.printers,
    prints: initialSnapshot.prints,
    filamentCatalog: initialSnapshot.filamentCatalog,
    selectedPrinter: initialSnapshot.printer.name,
    selectedPrint: initialSnapshot.print.name,
      values: { layer_height: '0.12' },
      configurationMode: 'project',
  });
  useSlicerStore.setState({
    status: 'done', progress: 100, layers: 80, error: 'previous failure',
    resultExported: true, layer: 40, maxLayer: 79,
  });
}

function makePlatform(
  selectProfile: (kind: 'printer' | 'print', name: string) => Promise<ProfileSnapshotResult>,
  selectPrinterWithRememberedRack: (printer: string, rack: RememberedFilamentRack | null) => Promise<PrinterTransitionResult> = async () => printerTransition(),
) {
  const preferences: UserPreferences = { version: 1, selectedProfiles: { printer: 'saved' }, ui: { switchToDeviceAfterSend: true } };
  const repository = {
    load: vi.fn(async () => preferences),
    save: vi.fn(async (next: UserPreferences) => { Object.assign(preferences, next); }),
  };
  const runtime = {
        selectProfile: vi.fn(selectProfile),
        selectPrinterWithRememberedRack: vi.fn(selectPrinterWithRememberedRack),
        revalidateNativeScopedConfig: vi.fn(async () => ({ ok: true, nativeScopedConfig: {
          version: 1 as const, revision: 0, kind: 'full' as const,
          snapshot: { project: {}, objects: {}, parts: {}, plates: {} }, removedTargets: [],
        } })),
        getFilamentSessionSnapshot: vi.fn(async () => resolvedRack),
        applyRememberedFilamentRack: vi.fn(async () => resolvedRack),
        markSharedConfigurationMutation: vi.fn(async () => ({
          instances: [],
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

async function render(platform: PlatformCapabilities, onEditPrinter?: (canonicalName: string) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PlatformProvider value={platform}><SettingsPanel sceneInteraction={null} onEditPrinter={onEditPrinter} /></PlatformProvider>);
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

  it('opens Printer editing for the currently selected canonical preset without changing selection', async () => {
    resetStores();
    const onEditPrinter = vi.fn();
    const { platform } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform, onEditPrinter);
    roots.push(root);

    await act(async () => { (container.querySelector('[data-testid="preset-edit-printer"]') as HTMLButtonElement).click(); });

    expect(onEditPrinter).toHaveBeenCalledOnce();
    expect(onEditPrinter).toHaveBeenCalledWith('Old Printer');
    expect(useSettingsStore.getState().selectedPrinter).toBe('Old Printer');
  });

  it('locks every selector, publishes one native Printer receipt, invalidates once, and persists its resolved state', async () => {
    resetStores();
    let resolveSelection!: (transition: PrinterTransitionResult) => void;
    const pending = new Promise<PrinterTransitionResult>((resolve) => { resolveSelection = resolve; });
    const { platform, repository, runtime } = makePlatform(async () => resolvedSnapshot, async () => pending);
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
      resolveSelection(printerTransition());
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
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledOnce();
    expect(runtime.markSharedConfigurationMutation).not.toHaveBeenCalled();
    expect(runtime.getFilamentSessionSnapshot).not.toHaveBeenCalled();
    expect(runtime.revalidateNativeScopedConfig).not.toHaveBeenCalled();
    expect(useFilamentSessionStore.getState().snapshot).toEqual(resolvedRack);
    expect(useHistoryNavigationStore.getState().status).toMatchObject({ revision: 1, undoLabel: 'Select Printer' });
    expect(useProjectStore.getState()).toMatchObject({
      dirty: true,
      dirtyReasons: [],
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
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      rememberedFilamentRacks: { 'New Printer': { version: 1, slots: [
        { preset: 'Resolved Filament', colour: '#112233' },
      ] } },
    }));
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('false');
    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the resolved session state when selected-profile preference persistence fails', async () => {
    resetStores();
    const { platform, repository, preferences } = makePlatform(async () => resolvedSnapshot);
    repository.load.mockResolvedValueOnce(preferences).mockResolvedValueOnce(preferences)
      .mockRejectedValueOnce(new Error('storage unavailable'));
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

  it('passes the remembered rack into one native transition and publishes preference only after success', async () => {
    resetStores();
    const events: string[] = [];
    const { platform, runtime, preferences, repository } = makePlatform(async () => resolvedSnapshot,
      async (_printer, rack) => { events.push('native-transition'); expect(rack?.slots[0]).toEqual({ preset: 'Resolved Filament', colour: '#112233' }); return printerTransition(); });
    preferences.rememberedFilamentRacks = {
      'New Printer': { version: 1, slots: [{ preset: 'Resolved Filament', colour: '#112233' }] },
    };
    repository.load.mockImplementation(async () => { events.push('preference-load'); return preferences; });
    repository.save.mockImplementation(async (next: UserPreferences) => { events.push('preference-save'); Object.assign(preferences, next); });
    const { container, root } = await render(platform);
    roots.push(root);

    await selectOption(container, 'preset-select', 'New Printer');
    await act(async () => { await Promise.resolve(); });

    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledWith('New Printer', {
      version: 1, slots: [{ preset: 'Resolved Filament', colour: '#112233' }],
    });
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledOnce();
    expect(runtime.applyRememberedFilamentRack).not.toHaveBeenCalled();
    expect(runtime.markSharedConfigurationMutation).not.toHaveBeenCalled();
    expect(runtime.getFilamentSessionSnapshot).not.toHaveBeenCalled();
    expect(events.indexOf('preference-load')).toBeLessThan(events.indexOf('native-transition'));
    expect(events.indexOf('native-transition')).toBeLessThan(events.indexOf('preference-save'));
  });

  it('does not publish a remembered rack when the native Printer transition fails', async () => {
    resetStores();
    const { platform, runtime, repository } = makePlatform(async () => resolvedSnapshot,
      async () => ({ ok: false, error: 'compatibility failed', errorCode: 'native_validation_failure' }));
    const { container, root } = await render(platform);
    roots.push(root);

    await selectOption(container, 'preset-select', 'New Printer');
    await act(async () => { await Promise.resolve(); });

    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledOnce();
    expect(repository.save).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().selectedPrinter).toBe('Old Printer');
    expect(useFilamentSessionStore.getState().snapshot).toBeNull();
  });

  it('renders prime-tower controls without exposing scene-owned coordinates', async () => {
    resetStores();
    useSettingsStore.setState({ metadata: {
      enable_prime_tower: { type: 'bool', label: 'Enable Prime Tower', default: '0', scopes: ['project'] },
      prime_tower_width: { type: 'float', label: 'Prime Tower Width', default: '20', scopes: ['project'] },
    } });
    const { container, root } = await render(makePlatform(async () => resolvedSnapshot).platform);
    roots.push(root);
    expect(container.querySelector('[data-testid="config-field-enable_prime_tower"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="config-field-prime_tower_width"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="config-field-wipe_tower_x"]')).toBeNull();
    expect(container.querySelector('[data-testid="config-field-wipe_tower_y"]')).toBeNull();
  });

  it('keeps the explicit Scoped mode across an empty selection and resolves the active plate', async () => {
    resetStores();
    useSettingsStore.setState({ metadata: {
      layer_height: { type: 'float', label: 'Layer height', scopes: ['project', 'plate'] },
    } });
    usePlateSessionStore.setState({ snapshot: {
      ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, name: 'Plate 1', origin: [0, 0, 0], instanceIds: [], outOfBoundsInstanceIds: [], valid: true, locked: false }],
      instances: [], instanceTransforms: [], inputRevisions: { 'plate-1': 0 },
    } });
    const { container, root } = await render(makePlatform(async () => resolvedSnapshot).platform);
    roots.push(root);
    const configurationPanel = container.querySelector('[data-testid="scoped-configuration-panel"]')!;
    const scopedModeButton = container.querySelector('[data-testid="config-mode-scoped"]') as HTMLElement;
    expect(configurationPanel.contains(scopedModeButton)).toBe(true);
    await act(async () => { scopedModeButton.click(); });
    expect(useSettingsStore.getState().configurationMode).toBe('scoped');
    expect(container.querySelector('[data-testid="scoped-target-label"]')?.textContent).toBe('Plate 1');
    expect(container.querySelector('[data-testid="config-field-layer_height"]')).not.toBeNull();
  });

});
