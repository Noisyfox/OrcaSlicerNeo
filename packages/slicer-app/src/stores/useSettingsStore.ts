import { create } from 'zustand';
import type { OptionMetadata, PresetInfo } from '@slicer/client';

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
  values: Record<string, string>;
  modelLoaded: boolean;
  /** Advances on every successful add or clear so repeated adds reload the viewport. */
  modelRevision: number;
  setMetadata: (m: OptionMetadata) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filaments: PresetInfo[]) => void;
  setSelections: (printer: string, print: string, filament: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setModelLoaded: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  metadata: null,
  printers: [],
  prints: [],
  filaments: [],
  selectedPrinter: '',
  selectedPrint: '',
  selectedFilament: '',
  values: {},
  modelLoaded: false,
  modelRevision: 0,
  setMetadata: (metadata) => set({ metadata }),
  setPresets: (printers, prints, filaments) => set({
    printers, prints, filaments,
    selectedPrinter: printers.find((p) => p.selected)?.name ?? '',
    selectedPrint: prints.find((p) => p.selected)?.name ?? '',
    selectedFilament: filaments.find((p) => p.selected)?.name ?? '',
  }),
  setSelections: (selectedPrinter, selectedPrint, selectedFilament) =>
    set({ selectedPrinter, selectedPrint, selectedFilament }),
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  setValues: (values) => set({ values }),
  setModelLoaded: (modelLoaded) => set((s) => ({ modelLoaded, modelRevision: s.modelRevision + 1 })),
}));
