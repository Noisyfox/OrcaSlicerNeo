import { create } from 'zustand';
import type { FilamentCatalogItem, OptionMetadata, PresetInfo, ProfileSnapshot, NativeScopedConfigSnapshot } from '@slicer/client';

export const emptyNativeScopedConfig = (): NativeScopedConfigSnapshot => ({
  project: {}, objects: {}, parts: {}, plates: {},
});

export function nativeScopedConfigValues(snapshot: NativeScopedConfigSnapshot): Record<string, string> {
  return { ...snapshot.project };
}

function effectiveValues(baseValues: Record<string, string>, snapshot: NativeScopedConfigSnapshot): Record<string, string> {
  return { ...baseValues, ...nativeScopedConfigValues(snapshot) };
}

interface SettingsState {
  metadata: OptionMetadata | null;
  /** Enriched preset lists — the picker's installed/available grouping and
   *  value source (M4: entries carry the REAL is_visible / selected flags
   *  from the bridge, never computed client-side). */
  printers: PresetInfo[];
  prints: PresetInfo[];
  /** Engine-filtered filament catalogue consumed by the multi-filament rack.
   * It is not a single-filament selection or a second source of truth. */
  filamentCatalog: FilamentCatalogItem[];
  /** Current printer/process profile names, synced from the bridge. Filament
   * selection is owned exclusively by the Worker filament session/rack. */
  selectedPrinter: string;
  selectedPrint: string;
  /** Selected printer's build-plate polygon in slicer XY coordinates (mm). */
  printableArea: Array<[number, number]>;
  /** Native effective profile/project configuration before local edits. */
  baseValues: Record<string, string>;
  values: Record<string, string>;
  /** Disposable projection of native scoped configuration. */
  nativeScopedConfig: NativeScopedConfigSnapshot;
  modelLoaded: boolean;
  /** Advances on every successful add or clear so repeated adds reload the viewport. */
  modelRevision: number;
  setMetadata: (m: OptionMetadata) => void;
  /** Replace all picker state from one atomic native snapshot. */
  hydrateProfileSnapshot: (snapshot: ProfileSnapshot) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filamentCatalog: FilamentCatalogItem[]) => void;
  setSelections: (printer: string, print: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setNativeScopedConfig: (snapshot: NativeScopedConfigSnapshot) => void;
  setModelLoaded: (v: boolean) => void;
  /** Update the loaded flag after an incremental SceneDelta without scheduling a full mesh read. */
  setModelLoadedFromSceneDelta: (v: boolean) => void;
  /** Re-fetch the current model mesh (delete etc.) without toggling load state. */
  refreshModel: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  metadata: null,
  printers: [],
  prints: [],
  filamentCatalog: [],
  selectedPrinter: '',
  selectedPrint: '',
  printableArea: [[0, 0], [220, 0], [220, 220], [0, 220]],
  baseValues: {},
  values: {},
  nativeScopedConfig: emptyNativeScopedConfig(),
  modelLoaded: false,
  modelRevision: 0,
  setMetadata: (metadata) => set({ metadata }),
  hydrateProfileSnapshot: (snapshot) => set(() => {
    const baseValues = snapshot.project_config ?? {};
    const nativeScopedConfig = emptyNativeScopedConfig();
    return {
      printers: snapshot.printers,
      prints: snapshot.prints,
      filamentCatalog: snapshot.filamentCatalog,
      selectedPrinter: snapshot.printer.name,
      selectedPrint: snapshot.print.name,
      printableArea: snapshot.printable_area ?? [[0, 0], [220, 0], [220, 220], [0, 220]],
      baseValues,
      // A profile/project replacement starts with no scoped local values. The
      // caller applies the replacement project's native snapshot separately.
      nativeScopedConfig,
      values: effectiveValues(baseValues, nativeScopedConfig),
    };
  }),
  setPresets: (printers, prints, filamentCatalog) => set({
    printers, prints, filamentCatalog,
    selectedPrinter: printers.find((p) => p.selected)?.name ?? '',
    selectedPrint: prints.find((p) => p.selected)?.name ?? '',
  }),
  setSelections: (selectedPrinter, selectedPrint) => set({ selectedPrinter, selectedPrint }),
  setValue: (key, value) => set((s) => {
    const baseValues = { ...s.baseValues, [key]: value };
    return { baseValues, values: effectiveValues(baseValues, s.nativeScopedConfig) };
  }),
  setValues: (baseValues) => set((s) => ({ baseValues, values: effectiveValues(baseValues, s.nativeScopedConfig) })),
  setNativeScopedConfig: (nativeScopedConfig) => set((s) => ({
    nativeScopedConfig,
    // Re-derive from the immutable base so the renderer always reflects
    // native scope values after a committed response.
    values: effectiveValues(s.baseValues, nativeScopedConfig),
  })),
  setModelLoaded: (modelLoaded) => set((s) => ({ modelLoaded, modelRevision: s.modelRevision + 1 })),
  setModelLoadedFromSceneDelta: (modelLoaded) => set({ modelLoaded }),
  refreshModel: () => set((s) => ({ modelRevision: s.modelRevision + 1 })),
}));
