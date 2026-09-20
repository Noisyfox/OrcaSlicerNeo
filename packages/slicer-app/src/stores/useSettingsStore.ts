import { create } from 'zustand';
import type { FilamentCatalogItem, OptionMetadata, PresetInfo, ProfileSnapshot, ProjectConfigOverlay } from '@slicer/client';

export const emptyProjectConfigOverlay = (): ProjectConfigOverlay => ({
  project: {}, objects: {}, parts: {}, plates: {},
});

export function projectOverlayValues(overlay: ProjectConfigOverlay): Record<string, string> {
  return { ...overlay.project };
}

function effectiveValues(baseValues: Record<string, string>, overlay: ProjectConfigOverlay): Record<string, string> {
  return { ...baseValues, ...projectOverlayValues(overlay) };
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
  /** Native effective profile/project configuration before Neo's overlay. */
  baseValues: Record<string, string>;
  values: Record<string, string>;
  /** Render projection of the Worker-owned project configuration overlay. */
  overlay: ProjectConfigOverlay;
  modelLoaded: boolean;
  /** Advances on every successful add or clear so repeated adds reload the viewport. */
  modelRevision: number;
  setMetadata: (m: OptionMetadata) => void;
  /** Replace all picker state from one atomic compatibility snapshot. */
  hydrateProfileSnapshot: (snapshot: ProfileSnapshot) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filamentCatalog: FilamentCatalogItem[]) => void;
  setSelections: (printer: string, print: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setOverlay: (overlay: ProjectConfigOverlay) => void;
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
  overlay: emptyProjectConfigOverlay(),
  modelLoaded: false,
  modelRevision: 0,
  setMetadata: (metadata) => set({ metadata }),
  hydrateProfileSnapshot: (snapshot) => set(() => {
    const baseValues = snapshot.project_config ?? {};
    const overlay = emptyProjectConfigOverlay();
    return {
      printers: snapshot.printers,
      prints: snapshot.prints,
      filamentCatalog: snapshot.filamentCatalog,
      selectedPrinter: snapshot.printer.name,
      selectedPrint: snapshot.print.name,
      printableArea: snapshot.printable_area ?? [[0, 0], [220, 0], [220, 220], [0, 220]],
      baseValues,
      // A profile/project replacement starts with no old project overlay. The
      // caller applies the replacement project's overlay in a separate step.
      overlay,
      values: effectiveValues(baseValues, overlay),
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
    return { baseValues, values: effectiveValues(baseValues, s.overlay) };
  }),
  setValues: (baseValues) => set((s) => ({ baseValues, values: effectiveValues(baseValues, s.overlay) })),
  setOverlay: (overlay) => set((s) => ({
    overlay,
    // A loaded 3MF may select a Process preset with enable_prime_tower=1
    // without storing a Neo overlay entry. Re-derive from the immutable base
    // so removing an override restores that native value.
    values: effectiveValues(s.baseValues, overlay),
  })),
  setModelLoaded: (modelLoaded) => set((s) => ({ modelLoaded, modelRevision: s.modelRevision + 1 })),
  setModelLoadedFromSceneDelta: (modelLoaded) => set({ modelLoaded }),
  refreshModel: () => set((s) => ({ modelRevision: s.modelRevision + 1 })),
}));
