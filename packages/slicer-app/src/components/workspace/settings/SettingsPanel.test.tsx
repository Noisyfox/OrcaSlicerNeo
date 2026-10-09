// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type RememberedFilamentRack, type UserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, PresetInfo, ProfileSnapshot, ProfileSnapshotResult, PrinterTransitionResult } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { sliceModel } from '../actions/sliceActions';
import { SettingsPanel } from './SettingsPanel';

vi.mock('./MovePanel', () => ({ MovePanel: () => null }));
vi.mock('./RotatePanel', () => ({ RotatePanel: () => null }));
vi.mock('./ScalePanel', () => ({ ScalePanel: () => null }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });

function preset(name: string, isVisible = true): PresetInfo {
  return { name, label: name, vendor: '', is_visible: isVisible, is_default: false, vendor_id: '', model: '', variant: '', selected: false };
}

const initialSnapshot: ProfileSnapshot = {
  ok: true,
  printerPicker: { items: [
    { id: 'old', label: 'Old Printer', preset: 'Old Printer' },
    { id: 'new', label: 'New Printer', preset: 'New Printer' },
  ], selectedId: 'old', variants: [{ value: '0.4', preset: 'Old Printer' }], selectedVariant: '0.4' },
  printers: [preset('Old Printer'), preset('New Printer')],
  // The false flag is deliberately retained: picker arrays are already bridge
  // candidates and must not be re-filtered by React.
  prints: [preset('Candidate Process B', false), preset('Candidate Process A')],
  filamentCatalog: [preset('Old Filament')],
  printer: { name: 'Old Printer', idx: 0 },
  print: { name: 'Candidate Process B', idx: 0 },
  bedType: { supportsSelection: true, defaultValue: 'Textured PEI Plate', choices: [{ value: 'Textured PEI Plate', label: 'Textured PEI Plate' }] },
};

const resolvedSnapshot: ProfileSnapshot = {
  ok: true,
  printerPicker: { items: [
    { id: 'new', label: 'New Printer', preset: 'New Printer' },
    { id: 'other', label: 'Other Printer', preset: 'Other Printer' },
  ], selectedId: 'new', variants: [{ value: '0.6', preset: 'New Printer' }], selectedVariant: '0.6' },
  printers: [preset('New Printer'), preset('Other Printer')],
  prints: [preset('Resolved Process')],
  filamentCatalog: [preset('Resolved Filament')],
  printer: { name: 'New Printer', idx: 4 },
  print: { name: 'Resolved Process', idx: 8 },
  bedType: { supportsSelection: true, defaultValue: 'Textured PEI Plate', choices: [{ value: 'Textured PEI Plate', label: 'Textured PEI Plate' }] },
};

const resolvedRack: FilamentSessionSnapshot = {
  ok: true, version: 1,
  slots: [{ logicalId: 'filament-1', slot: 1, preset: { id: 'Resolved Filament', name: 'Resolved Filament', label: 'Resolved Filament', vendor: '' }, colour: { effective: '#112233', provenance: 'preset', native: { representative: '#112233', multiColour: '#112233', type: '1' }, display: { mode: 'solid' as const, colors: ['#112233'] } } }],
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
      editingSession: null, navigationFloor: null,
      canUndo: true, canRedo: false, undoLabel: 'Select Printer',
      undoEntries: [{ id: 'entry-1', label: 'Select Printer', category: 'project' }], redoEntries: [],
      cursor: 1, savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true,
      bytesUsed: 128, byteBudget: 256 * 1024 * 1024, evictedEntryCount: 0,
      lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
      disabled: false, activeTransactionId: null, revision: 1,
    },
    nativeScopedConfig: {
      version: 1, revision: 1, kind: 'full',
      snapshot: { project: { curr_bed_type: 'Textured PEI Plate' }, objects: {}, parts: {}, plates: {} }, removedTargets: [],
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
      bedType: { supportsSelection: true, defaultValue: 'Textured PEI Plate', choices: [
        { value: 'High Temp Plate', label: 'Smooth PEI Plate' },
        { value: 'Textured PEI Plate', label: 'Textured PEI Plate' },
      ] },
      nativeScopedConfigRevision: 0,
      nativeScopedConfig: { project: { curr_bed_type: 'Textured PEI Plate' }, objects: {}, parts: {}, plates: { 'plate-1': { curr_bed_type: 'High Temp Plate' } } },
      metadata: {},
    printers: initialSnapshot.printers,
    printerPicker: initialSnapshot.printerPicker,
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
  selectPrinterWithRememberedRack: (printer: string, rack: RememberedFilamentRack | null, bed: string | null) => Promise<PrinterTransitionResult> = async () => printerTransition(),
) {
  const preferences: UserPreferences = { version: 1, rememberedBedTypes: {}, selectedProfiles: { printer: 'saved' }, ui: { switchToDeviceAfterSend: true } };
  const repository = {
    load: vi.fn(async () => preferences),
    save: vi.fn(async (next: UserPreferences) => { Object.assign(preferences, next); }),
  };
  const runtime = {
        getRuntimeExecutionState: vi.fn(() => ({ threaded: false, sliceActive: false, serialSliceActive: false, serialTerminalEpoch: '0' })),
        getHistoryStatus: vi.fn(async () => (printerTransition() as Extract<PrinterTransitionResult, { ok: true }>).historyStatus),
        mutateNativeScopedConfig: vi.fn(async (request: { value?: string }) => ({ ok: true as const,
          plateSession: (printerTransition() as Extract<PrinterTransitionResult, { ok: true }>).plateSession,
          nativeScopedConfig: { version: 1 as const, revision: 1, kind: 'full' as const,
            snapshot: { ...useSettingsStore.getState().nativeScopedConfig, project: { curr_bed_type: request.value ?? 'Textured PEI Plate' } }, removedTargets: [],
          },
        })),
        runProjectHistoryTransaction: vi.fn(async (_label: string, _category: string, _before: unknown, mutation: (id: string) => Promise<unknown>) => {
          const result = await mutation('tx-1');
          return { result, sceneDelta: null, status: { ...(printerTransition() as Extract<PrinterTransitionResult, { ok: true }>).historyStatus,
            nativeScopedConfig: (result as { nativeScopedConfig: unknown }).nativeScopedConfig } };
        }),
        selectProfile: vi.fn(selectProfile),
        selectPrinterWithRememberedRack: vi.fn(selectPrinterWithRememberedRack),
        revalidateNativeScopedConfig: vi.fn(async () => ({ ok: true, nativeScopedConfig: {
          version: 1 as const, revision: 0, kind: 'full' as const,
          snapshot: { project: { curr_bed_type: 'Textured PEI Plate' }, objects: {}, parts: {}, plates: {} }, removedTargets: [],
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

  it('rejects mounting before the required profile snapshot is initialized', async () => {
    resetStores();
    useSettingsStore.setState({ printerPicker: null });
    const { platform } = makePlatform(async () => resolvedSnapshot);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await expect(act(async () => {
      root.render(<PlatformProvider value={platform}><SettingsPanel sceneInteraction={null} /></PlatformProvider>);
    })).rejects.toThrow('SettingsPanel requires an initialized profile snapshot');
    expect(container.querySelector('[data-testid="preset-select"]')).toBeNull();
  });

  afterEach(() => {
    roots.forEach((root) => root.unmount());
    roots = [];
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function chooseBed(container: HTMLElement, label: string) {
    await act(async () => (container.querySelector('[data-testid="global-bed-type-select"]') as HTMLElement).click());
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(item => item.textContent === label)!;
      expect(option).toBeDefined(); option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
  }

  async function chooseNozzle(container: HTMLElement, value: string) {
    await act(async () => (container.querySelector('[data-testid="nozzle-variant-select"]') as HTMLElement).click());
    const option = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find(item => item.textContent === value)!;
    expect(option).toBeDefined();
    await act(async () => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
  }

  it('uses native model labels and canonical targets, with inert Sync and actual-profile editing', async () => {
    resetStores();
    useSettingsStore.setState({ prints: initialSnapshot.prints.map(item => ({ ...item, label: 'Process alias' })) });
    useSettingsStore.setState({ printerPicker: {
      ...initialSnapshot.printerPicker,
      items: initialSnapshot.printerPicker.items.map(item => ({ ...item, label: `${item.label} Model` })),
    } });
    const edit = vi.fn();
    const { platform, runtime } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform, edit); roots.push(root);
    expect(container.querySelector('[data-testid="process-preset-select"]')?.textContent).toBe('Process alias');
    expect(container.querySelector('[data-testid="process-preset-select"]')?.getAttribute('title')).toBe('Candidate Process B');
    expect(container.querySelector('[data-testid="preset-select"]')?.textContent).toBe('Old Printer Model');
    expect(container.querySelector('[data-testid="preset-select"]')?.getAttribute('title')).toBe('Old Printer');
    await act(async () => (container.querySelector('[data-testid="nozzle-sync-placeholder"]') as HTMLElement).click());
    expect(runtime.selectPrinterWithRememberedRack).not.toHaveBeenCalled();
    await act(async () => (container.querySelector('[data-testid="preset-edit-printer"]') as HTMLElement).click());
    expect(edit).toHaveBeenCalledWith('Old Printer');
    await selectOption(container, 'preset-select', 'New Printer Model');
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledWith('New Printer', null, null);
    expect(container.querySelector('[data-testid="preset-select"]')?.getAttribute('title')).toBe('New Printer');
    expect(container.querySelector('[data-testid="nozzle-variant-select"]')?.textContent).toContain('0.6');
  });

  it('switches a named/mixed variant through the existing atomic Printer transaction and locks Nozzle', async () => {
    resetStores();
    const picker = { items: [{ id: 'model', label: 'One Printer', preset: 'Old Printer' }], selectedId: 'model',
      variants: [{ value: '0.4', preset: 'Old Printer' }, { value: '0.4+0.6', preset: 'Mixed Profile' }], selectedVariant: '0.4' };
    useSettingsStore.setState({ printerPicker: picker });
    const profile: ProfileSnapshot = { ...resolvedSnapshot, printer: { name: 'Mixed Profile', idx: 2 }, printerPicker: {
      ...picker, items: [{ ...picker.items[0], preset: 'Mixed Profile' }], selectedVariant: '0.4+0.6',
    } };
    let finish!: (value: PrinterTransitionResult) => void;
    const pending = new Promise<PrinterTransitionResult>(resolve => { finish = resolve; });
    const { platform, runtime, preferences } = makePlatform(async () => resolvedSnapshot, async () => pending);
    const { container, root } = await render(platform); roots.push(root);
    await chooseNozzle(container, '0.4+0.6');
    for (const id of ['preset-select', 'nozzle-variant-select', 'process-preset-select', 'global-bed-type-select'])
      expect((container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(printerTransition(profile)); await pending; });
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledExactlyOnceWith('Mixed Profile', null, null);
    expect(runtime.selectProfile).not.toHaveBeenCalled();
    expect(preferences.selectedProfiles.printer).toBe('Mixed Profile');
    expect(useSettingsStore.getState().selectedPrinter).toBe('Mixed Profile');
    expect(container.querySelector('[data-testid="preset-select"]')?.textContent).toBe('One Printer');
    expect(container.querySelector('[data-testid="preset-select"]')?.getAttribute('title')).toBe('Mixed Profile');
    expect(container.querySelector('[data-testid="nozzle-variant-select"]')?.textContent).toContain('0.4+0.6');
    expect(useSlicerStore.getState().status).toBe('idle');
    // Restores replace the projection rather than replaying a selection command.
    await act(async () => useSettingsStore.getState().hydrateProfileSnapshot(initialSnapshot));
    expect(container.querySelector('[data-testid="preset-select"]')?.getAttribute('title')).toBe('Old Printer');
    expect(container.querySelector('[data-testid="nozzle-variant-select"]')?.textContent).toContain('0.4');
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous Nozzle and releases locks when a variant transition is rejected', async () => {
    resetStores();
    useSettingsStore.setState({ printerPicker: { ...initialSnapshot.printerPicker,
      variants: [...initialSnapshot.printerPicker.variants, { value: '0.6HS', preset: 'Rejected Profile' }],
    } });
    const { platform, runtime } = makePlatform(async () => resolvedSnapshot,
      async () => ({ ok: false, errorCode: 'preset_not_visible', error: 'profile unavailable' }));
    const { container, root } = await render(platform); roots.push(root);
    await chooseNozzle(container, '0.6HS');
    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="nozzle-variant-select"]')?.textContent).toContain('0.4');
    expect((container.querySelector('[data-testid="nozzle-variant-select"]') as HTMLButtonElement).disabled).toBe(false);
    expect(useSettingsStore.getState().selectedPrinter).toBe('Old Printer');
  });

  it('shows global scope independently of plate override and sends native serialized values with official labels', async () => {
    resetStores();
    const { platform, runtime, preferences } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform); roots.push(root);
    const trigger = container.querySelector('[data-testid="global-bed-type-select"]') as HTMLButtonElement;
    expect(trigger.querySelector('[data-slot="select-value"]')?.textContent).toBe('Textured PEI Plate');
    expect(trigger.title).toContain('plates without a local override inherit');
    expect(container.querySelector('[data-testid="printer-bed-row"]')?.children.length).toBe(2);
    await act(async () => trigger.click());
    expect([...document.querySelectorAll('[data-slot="select-item"]')].map(item => item.textContent)).toEqual(['Smooth PEI Plate', 'Textured PEI Plate']);
    await act(async () => { const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(item => item.textContent === 'Smooth PEI Plate')!; item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); item.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledExactlyOnceWith({ version: 1, operation: 'set', targets: [{ scope: 'project' }], key: 'curr_bed_type', value: 'High Temp Plate' });
    expect(trigger.querySelector('[data-slot="select-value"]')?.textContent).toBe('Smooth PEI Plate');
    expect(preferences.rememberedBedTypes).toEqual({ 'Old Printer': 'High Temp Plate' });
  });

  it('locks bed, printer and process until native bed mutation settles and releases after rejection', async () => {
    resetStores();
    const { platform, runtime } = makePlatform(async () => resolvedSnapshot);
    let reject!: (error: Error) => void;
    runtime.mutateNativeScopedConfig.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const { container, root } = await render(platform); roots.push(root);
    await chooseBed(container, 'Smooth PEI Plate');
    for (const id of ['global-bed-type-select', 'preset-select', 'process-preset-select'])
      expect((container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => reject(new Error('native rejected bed')));
    expect(useSlicerStore.getState().error).toContain('native rejected bed');
    expect((container.querySelector('[data-testid="global-bed-type-select"]') as HTMLButtonElement).disabled).toBe(false);
    expect(runtime.mutateNativeScopedConfig).toHaveBeenCalledOnce();
  });

  it('an immediately requested Slice waits for the pending bed configuration FIFO', async () => {
    resetStores();
    const { platform, runtime } = makePlatform(async () => resolvedSnapshot);
    const native = runtime.mutateNativeScopedConfig.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    runtime.mutateNativeScopedConfig.mockImplementationOnce(async request => { await gate; return native(request); });
    const finalSession = { ...(printerTransition() as Extract<PrinterTransitionResult, { ok: true }>).plateSession,
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1] }] };
    const getPlateSessionSnapshot = vi.fn(async () => finalSession);
    const slicePlate = vi.fn(async () => ({ ok: false, error: 'fixture slice terminal' }));
    Object.assign(runtime, { getPlateSessionSnapshot, slicePlate });
    const { container, root } = await render(platform); roots.push(root);
    await chooseBed(container, 'Smooth PEI Plate');
    let slicing!: Promise<void>;
    await act(async () => { slicing = sliceModel(platform); await Promise.resolve(); });
    expect(getPlateSessionSnapshot).not.toHaveBeenCalled(); expect(slicePlate).not.toHaveBeenCalled();
    await act(async () => { release(); await slicing; });
    expect(slicePlate).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().nativeScopedConfig.project.curr_bed_type).toBe('High Temp Plate');
  });

  it('disables transitions during slice, history publication, and project replacement', async () => {
    resetStores();
    const { platform, runtime } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform); roots.push(root);
    const disabled = () => (container.querySelector('[data-testid="global-bed-type-select"]') as HTMLButtonElement).disabled;
    await act(async () => useSlicerStore.setState({ status: 'slicing' })); expect(disabled()).toBe(true);
    runtime.getRuntimeExecutionState.mockReturnValue({ threaded: true, sliceActive: true, serialSliceActive: false, serialTerminalEpoch: '0' });
    await act(async () => useSlicerStore.setState({ status: 'idle' }));
    await act(async () => useSlicerStore.setState({ status: 'slicing' })); expect(disabled()).toBe(false);
    await act(async () => { useSlicerStore.setState({ status: 'idle' }); useProjectStore.getState().beginProjectMutation(); }); expect(disabled()).toBe(true);
    await act(async () => { useProjectStore.getState().endProjectMutation(); useProjectStore.getState().setOperation({ phase: 'loading' }); }); expect(disabled()).toBe(true);
    await act(async () => useProjectStore.getState().setOperation({ phase: 'completed' })); expect(disabled()).toBe(false);
  });

  it('uses the same allowed options in the local plate editor and hides it for single-bed printers', async () => {
    resetStores();
    useSettingsStore.setState({ configurationMode: 'plates', metadata: { curr_bed_type: { type: 'enum', label: 'Bed type', category: 'Other', scopes: ['project', 'plate'], enum_values: ['unsupported-stale-value'], enum_labels: ['Unsupported'] } } });
    usePlateSessionStore.getState().setSnapshot({ ok: true, version: 1, currentPlateId: 'plate-1', instances: [],
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }] });
    const { platform } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform); roots.push(root);
    const local = container.querySelector('[data-testid="config-input-curr_bed_type"]') as HTMLButtonElement;
    expect(local).not.toBeNull(); expect(local.textContent).toContain('Smooth PEI Plate');
    await act(async () => local.click());
    expect([...document.querySelectorAll('[data-slot="select-item"]')].map(item => item.textContent)).toEqual(['Smooth PEI Plate', 'Textured PEI Plate']);
    await act(async () => useSettingsStore.setState({ bedType: { ...initialSnapshot.bedType, supportsSelection: false } }));
    expect(container.querySelector('[data-testid="config-input-curr_bed_type"]')).toBeNull();
  });

  it('hides selection when native capabilities are absent or single-bed', async () => {
    resetStores();
    const { platform } = makePlatform(async () => resolvedSnapshot);
    const { container, root } = await render(platform); roots.push(root);
    await act(async () => useSettingsStore.setState({ bedType: null })); expect(container.querySelector('[data-testid="global-bed-type-select"]')).toBeNull();
    await act(async () => useSettingsStore.setState({ bedType: { ...initialSnapshot.bedType, supportsSelection: false } })); expect(container.querySelector('[data-testid="global-bed-type-select"]')).toBeNull();
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
    expect(settings.values).toEqual({ curr_bed_type: 'Textured PEI Plate' });
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
        { preset: 'Resolved Filament', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } },
      ] } },
    }));
    expect(container.querySelector('[data-testid="preset-transition-region"]')?.getAttribute('aria-busy')).toBe('false');
    expect((container.querySelector('[data-testid="preset-select"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the resolved session state when selected-profile preference persistence fails', async () => {
    resetStores();
    const { platform, repository, preferences } = makePlatform(async () => resolvedSnapshot);
    repository.load.mockResolvedValueOnce(preferences).mockResolvedValueOnce(preferences)
      .mockResolvedValueOnce(preferences).mockResolvedValueOnce(preferences)
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
      async (_printer, rack) => { events.push('native-transition'); expect(rack?.slots[0]).toEqual({ preset: 'Resolved Filament', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }); return printerTransition(); });
    preferences.rememberedFilamentRacks = {
      'New Printer': { version: 1, slots: [{ preset: 'Resolved Filament', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }] },
    };
    preferences.rememberedBedTypes = { 'New Printer': 'Textured PEI Plate', 'Old Printer': 'High Temp Plate' };
    repository.load.mockImplementation(async () => { events.push('preference-load'); return preferences; });
    repository.save.mockImplementation(async (next: UserPreferences) => { events.push('preference-save'); Object.assign(preferences, next); });
    const { container, root } = await render(platform);
    roots.push(root);

    await selectOption(container, 'preset-select', 'New Printer');
    await act(async () => { await Promise.resolve(); });

    expect(runtime.selectPrinterWithRememberedRack).toHaveBeenCalledWith('New Printer', {
      version: 1, slots: [{ preset: 'Resolved Filament', colour: '#112233', native: { representative: '#112233', multiColour: '#112233', type: '1' } }],
    }, 'Textured PEI Plate');
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

  it('keeps Objects empty without a selection and exposes plate settings only in Plates', async () => {
    resetStores();
    useSettingsStore.setState({ metadata: {
      print_sequence: { type: 'enum', label: 'Print sequence', enum_values: ['by layer', 'by object'], scopes: ['project', 'plate'] },
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
    expect(scopedModeButton.textContent).toBe('Objects');
    expect(container.querySelector('[data-testid="scoped-target-label"]')?.textContent).toBe('No object selected');
    expect(container.querySelector('[data-testid="config-field-print_sequence"]')).toBeNull();
    expect(container.querySelector('[data-testid="scoped-invalid-selection"]')).not.toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="config-mode-plates"]')!.click(); });
    expect(useSettingsStore.getState().configurationMode).toBe('plates');
    expect(container.querySelector('[data-testid="scoped-target-label"]')?.textContent).toBe('Plate 1');
    expect(container.querySelector('[data-testid="config-field-print_sequence"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Settings category"]')).toBeNull();
  });

});
