import { create } from 'zustand';
import type { OptionMetadata, PresetInfo, PresetSnapshot, ProjectConfigOverlay } from '@slicer/client';

export const emptyProjectConfigOverlay = (): ProjectConfigOverlay => ({
  project: {}, objects: {}, parts: {}, plates: {},
});

export function projectOverlayValues(overlay: ProjectConfigOverlay): Record<string, string> {
  return { ...overlay.project };
}

interface SettingsState {
  metadata: OptionMetadata | null;
  /** Enriched preset lists — the picker's installed/available grouping and
   *  value source (M4: entries carry the REAL is_visible / selected flags
   *  from the bridge, never computed client-side). */
  printers: PresetInfo[];
  prints: PresetInfo[];
  filaments: PresetInfo[];
  /** Current selection names, synced from the bridge: setPresets derives
   *  them from the lists' `selected` flags at boot; setSelections applies
   *  selectPreset responses (all three, since printer change re-runs the
   *  compatibility tail that moves print/filament). */
  selectedPrinter: string;
  selectedPrint: string;
  selectedFilament: string;
  /** Selected printer's build-plate polygon in slicer XY coordinates (mm). */
  printableArea: Array<[number, number]>;
  values: Record<string, string>;
  /** Render projection of the Worker-owned project configuration overlay. */
  overlay: ProjectConfigOverlay;
  modelLoaded: boolean;
  /** Advances on every successful add or clear so repeated adds reload the viewport. */
  modelRevision: number;
  setMetadata: (m: OptionMetadata) => void;
  /** Replace all picker state from one atomic compatibility snapshot. */
  hydratePresetSnapshot: (snapshot: PresetSnapshot) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filaments: PresetInfo[]) => void;
  setSelections: (printer: string, print: string, filament: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setOverlay: (overlay: ProjectConfigOverlay) => void;
  setOverlayValue: (scope: 'project' | 'object' | 'part' | 'plate', id: string | undefined, key: string, value: string) => void;
  setModelLoaded: (v: boolean) => void;
  /** Re-fetch the current model mesh (delete etc.) without toggling load state. */
  refreshModel: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  metadata: null,
  printers: [],
  prints: [],
  filaments: [],
  selectedPrinter: '',
  selectedPrint: '',
  selectedFilament: '',
  printableArea: [[0, 0], [220, 0], [220, 220], [0, 220]],
  values: {},
  overlay: emptyProjectConfigOverlay(),
  modelLoaded: false,
  modelRevision: 0,
  setMetadata: (metadata) => set({ metadata }),
  hydratePresetSnapshot: (snapshot) => set({
    printers: snapshot.printers,
    prints: snapshot.prints,
    filaments: snapshot.filaments,
    selectedPrinter: snapshot.printer.name,
    selectedPrint: snapshot.print.name,
    selectedFilament: snapshot.filament.name,
    printableArea: snapshot.printable_area ?? [[0, 0], [220, 0], [220, 220], [0, 220]],
    // A system preset transition replaces the base configuration. Temporary
    // renderer overrides belong to the previous combination and must not leak
    // into the next slice.
    values: projectOverlayValues(get().overlay),
  }),
  setPresets: (printers, prints, filaments) => set({
    printers, prints, filaments,
    selectedPrinter: printers.find((p) => p.selected)?.name ?? '',
    selectedPrint: prints.find((p) => p.selected)?.name ?? '',
    selectedFilament: filaments.find((p) => p.selected)?.name ?? '',
  }),
  setSelections: (selectedPrinter, selectedPrint, selectedFilament) =>
    set({ selectedPrinter, selectedPrint, selectedFilament, values: projectOverlayValues(get().overlay) }),
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  setValues: (values) => set({ values }),
  setOverlay: (overlay) => set({ overlay, values: projectOverlayValues(overlay) }),
  setOverlayValue: (scope, id, key, value) => set((s) => {
    const overlay = structuredClone(s.overlay) as {
      project: Record<string, string>;
      objects: Record<string, Record<string, string>>;
      parts: Record<string, Record<string, string>>;
      plates: Record<string, Record<string, string>>;
    };
    const bucket = scope === 'project' ? overlay.project
      : scope === 'object' ? (overlay.objects[id ?? ''] ??= {})
        : scope === 'part' ? (overlay.parts[id ?? ''] ??= {})
          : (overlay.plates[id ?? ''] ??= {});
    bucket[key] = value;
    return { overlay, values: projectOverlayValues(overlay) };
  }),
  setModelLoaded: (modelLoaded) => set((s) => ({ modelLoaded, modelRevision: s.modelRevision + 1 })),
  refreshModel: () => set((s) => ({ modelRevision: s.modelRevision + 1 })),
}));
