import { create } from 'zustand';
import type {
  FilamentCatalogItem, OptionMetadata, PresetInfo, ProfileSnapshot,
  NativeScopedConfigSnapshot, NativeScopedConfigTransport,
} from '@slicer/client';

export const emptyNativeScopedConfig = (): NativeScopedConfigSnapshot => ({
  project: {}, objects: {}, parts: {}, plates: {},
});

export function nativeScopedConfigValues(snapshot: NativeScopedConfigSnapshot): Record<string, string> {
  return { ...snapshot.project };
}

export type NativeScopedConfigApplyResult = 'applied' | 'stale' | 'refresh-required';

function cloneSnapshot(snapshot: NativeScopedConfigSnapshot): NativeScopedConfigSnapshot {
  return {
    project: { ...snapshot.project },
    objects: Object.fromEntries(Object.entries(snapshot.objects).map(([id, values]) => [id, { ...values }])),
    parts: Object.fromEntries(Object.entries(snapshot.parts).map(([id, values]) => [id, { ...values }])),
    plates: Object.fromEntries(Object.entries(snapshot.plates).map(([id, values]) => [id, { ...values }])),
  };
}

function replaceTarget(snapshot: NativeScopedConfigSnapshot, scope: 'project' | 'object' | 'part' | 'plate', id: string | undefined,
  values: Readonly<Record<string, string>>): NativeScopedConfigSnapshot {
  const next = cloneSnapshot(snapshot);
  if (scope === 'project') return { ...next, project: { ...values } };
  if (id === undefined) return next;
  const key = scope === 'object' ? 'objects' : scope === 'part' ? 'parts' : 'plates';
  const buckets = { ...next[key] };
  if (Object.keys(values).length === 0) delete buckets[id];
  else buckets[id] = { ...values };
  return { ...next, [key]: buckets } as NativeScopedConfigSnapshot;
}

function removeTarget(snapshot: NativeScopedConfigSnapshot, scope: 'project' | 'object' | 'part' | 'plate', id: string | undefined): NativeScopedConfigSnapshot {
  if (scope === 'project') return { ...cloneSnapshot(snapshot), project: {} };
  if (id === undefined) return snapshot;
  const next = cloneSnapshot(snapshot);
  const key = scope === 'object' ? 'objects' : scope === 'part' ? 'parts' : 'plates';
  const buckets = { ...next[key] };
  delete buckets[id];
  return { ...next, [key]: buckets } as NativeScopedConfigSnapshot;
}

function hasTarget(snapshot: NativeScopedConfigSnapshot, scope: 'project' | 'object' | 'part' | 'plate', id: string | undefined): boolean {
  if (scope === 'project') return id === undefined;
  if (id === undefined) return false;
  const key = scope === 'object' ? 'objects' : scope === 'part' ? 'parts' : 'plates';
  return Object.hasOwn(snapshot[key], id);
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
  /** Revision of the last accepted native scoped transport, null before the
   * first full snapshot. */
  nativeScopedConfigRevision: number | null;
  /** True after an affected receipt exposes a revision gap or unknown target. */
  nativeScopedConfigRefreshRequired: boolean;
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
  applyNativeScopedConfigTransport: (transport: NativeScopedConfigTransport) => NativeScopedConfigApplyResult;
  resetNativeScopedConfig: () => void;
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
  nativeScopedConfigRevision: null,
  nativeScopedConfigRefreshRequired: false,
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
      nativeScopedConfigRevision: null,
      nativeScopedConfigRefreshRequired: false,
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
  applyNativeScopedConfigTransport: (transport) => {
    let outcome: NativeScopedConfigApplyResult = 'stale';
    set((s) => {
      const current = s.nativeScopedConfigRevision;
      const refreshRequired = s.nativeScopedConfigRefreshRequired;
      if (transport.kind === 'full') {
        if (current !== null && transport.revision < current) return s;
        if (current !== null && transport.revision === current && !refreshRequired) return s;
        outcome = 'applied';
        return {
          nativeScopedConfig: cloneSnapshot(transport.snapshot),
          nativeScopedConfigRevision: transport.revision,
          nativeScopedConfigRefreshRequired: false,
          values: effectiveValues(s.baseValues, transport.snapshot),
        };
      }
      if (current === null || refreshRequired || transport.revision !== current + 1) {
        outcome = 'refresh-required';
        return { nativeScopedConfigRefreshRequired: true };
      }
      if (transport.replacements.some((replacement) =>
        !hasTarget(s.nativeScopedConfig, replacement.scope, replacement.id)) ||
        transport.removedTargets.some((removed) =>
          !hasTarget(s.nativeScopedConfig, removed.scope, removed.id))) {
        outcome = 'refresh-required';
        return { nativeScopedConfigRefreshRequired: true };
      }
      let nativeScopedConfig = cloneSnapshot(s.nativeScopedConfig);
      for (const replacement of transport.replacements)
        nativeScopedConfig = replaceTarget(nativeScopedConfig, replacement.scope, replacement.id, replacement.values);
      for (const removed of transport.removedTargets)
        nativeScopedConfig = removeTarget(nativeScopedConfig, removed.scope, removed.id);
      outcome = 'applied';
      return {
        nativeScopedConfig,
        nativeScopedConfigRevision: transport.revision,
        nativeScopedConfigRefreshRequired: false,
        values: effectiveValues(s.baseValues, nativeScopedConfig),
      };
    });
    return outcome;
  },
  resetNativeScopedConfig: () => set((s) => {
    const nativeScopedConfig = emptyNativeScopedConfig();
    return {
      nativeScopedConfig,
      nativeScopedConfigRevision: null,
      nativeScopedConfigRefreshRequired: false,
      values: effectiveValues(s.baseValues, nativeScopedConfig),
    };
  }),
  setModelLoaded: (modelLoaded) => set((s) => ({ modelLoaded, modelRevision: s.modelRevision + 1 })),
  setModelLoadedFromSceneDelta: (modelLoaded) => set({ modelLoaded }),
  refreshModel: () => set((s) => ({ modelRevision: s.modelRevision + 1 })),
}));
