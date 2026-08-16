import { create } from 'zustand';
import type { OptionMetadata, PresetInfo } from '@slicer/client';
import type { Vec3 } from '../lib/vec3';

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
  selectedObject: number | null;
  /** Active viewport tool. Only 'move' exists today; rotate/scale milestones
   *  extend this field — the gizmo family renders from it. */
  tool: string;
  /** Per-object current world offsets — the client-side truth for the move
   *  panel and drag commits (seeded at load, updated live during drags and
   *  on commit). */
  positions: Record<number, Vec3>;
  /** Load-time offset snapshot — Reset target. */
  initialPositions: Record<number, Vec3>;
  /** Object-local bounding-box min Z (from geometry) — Drop-to-bed input. */
  objectMinZ: Record<number, number>;
  setMetadata: (m: OptionMetadata) => void;
  setPresets: (printers: PresetInfo[], prints: PresetInfo[], filaments: PresetInfo[]) => void;
  setSelections: (printer: string, print: string, filament: string) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
  setModelLoaded: (v: boolean) => void;
  setSelectedObject: (v: number | null) => void;
  setObjectOffsets: (
    positions: Record<number, Vec3>,
    initialPositions: Record<number, Vec3>,
    objectMinZ: Record<number, number>,
  ) => void;
  setObjectOffset: (objectIdx: number, pos: Vec3) => void;
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
  selectedObject: null,
  tool: 'move',
  positions: {},
  initialPositions: {},
  objectMinZ: {},
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
  setModelLoaded: (modelLoaded) => set({ modelLoaded }),
  setSelectedObject: (selectedObject) => set({ selectedObject }),
  setObjectOffsets: (positions, initialPositions, objectMinZ) =>
    set({ positions, initialPositions, objectMinZ }),
  setObjectOffset: (objectIdx, pos) =>
    set((s) => ({ positions: { ...s.positions, [objectIdx]: pos } })),
}));
