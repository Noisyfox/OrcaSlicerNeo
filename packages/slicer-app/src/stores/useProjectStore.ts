import { create } from 'zustand';
import type { OpaqueProjectLocation } from '@orca/platform-contract';

export type ProjectPresetScope = 'system' | 'project';
export type ProjectOperationPhase =
  | 'idle'
  | 'waiting-for-load-choice'
  | 'waiting-for-project-confirmation'
  | 'waiting-for-dirty-decision'
  | 'loading'
  | 'saving'
  | 'model-import'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ProjectPresetSelections {
  printer: string;
  print: string;
}

export interface ProjectNotice {
  kind: 'compatibility-fallback' | 'multi-plate' | 'embedded-presets';
  message: string;
  details?: unknown;
}

export interface ProjectOperation {
  phase: ProjectOperationPhase;
  progress: number;
  message?: string;
  cancellable: boolean;
}

export type ProjectDirtyReason =
  | 'plate-structure'
  | 'model-import'
  | 'model-delete'
  | 'model-clear'
  | 'model-transform'
  | 'model-structure'
  | 'shared-configuration'
  | (string & {});

export interface ProjectSessionState {
  /** Base name only; host paths never enter this store. */
  projectName: string;
  /** Host-private token, opaque to shared code and UI. */
  location?: OpaqueProjectLocation;
  hasContent: boolean;
  /** Number of project mutations whose native and renderer projections have
   * not completed yet. Revision-fenced filament commands must not overtake
   * them. */
  projectMutationPendingCount: number;
  /** Synchronous UI projection of Worker HistoryStatus.dirty when history is available. */
  dirty: boolean;
  /** Legacy mutation reasons for the pre-history editing surface; lifecycle
   * guards must query Worker HistoryStatus and history-backed flows clear this. */
  dirtyReasons: readonly ProjectDirtyReason[];
  /** Runtime-only plate input generations used by later result ownership. */
  plateInputRevisions: Readonly<Record<string, number>>;
  scope: ProjectPresetScope;
  systemPresets: ProjectPresetSelections | null;
  projectPresets: ProjectPresetSelections | null;
  notices: ProjectNotice[];
  operation: ProjectOperation;
  setProject: (value: Partial<Pick<ProjectSessionState, 'projectName' | 'location' | 'hasContent' | 'dirty' | 'dirtyReasons' | 'plateInputRevisions' | 'scope' | 'systemPresets' | 'projectPresets' | 'notices'>>) => void;
  beginProjectMutation: () => void;
  endProjectMutation: () => void;
  /** Compatibility projection for ordinary edits not yet migrated to history. */
  markDirty: (reason?: ProjectDirtyReason) => void;
  /** Advance every known plate input for one shared configuration commit. */
  recordSharedConfigurationMutation: () => void;
  /** Compatibility projection; Worker history remains authoritative for lifecycle state. */
  recordPlateMutation: (mutation: {
    inputRevisions?: Readonly<Record<string, number>>;
    dirtyReasons?: readonly string[];
  }) => void;
  markClean: () => void;
  setOperation: (operation: Partial<ProjectOperation> & Pick<ProjectOperation, 'phase'>) => void;
  resetOperation: () => void;
  reset: () => void;
}

export const DEFAULT_PROJECT_PRESETS: ProjectPresetSelections = {
  printer: '', print: '',
};

const initialSession = (): Omit<ProjectSessionState, 'setProject' | 'beginProjectMutation' | 'endProjectMutation' | 'markDirty' | 'recordSharedConfigurationMutation' | 'recordPlateMutation' | 'markClean' | 'setOperation' | 'resetOperation' | 'reset'> => ({
  projectName: 'Untitled',
  location: undefined,
  hasContent: false,
  projectMutationPendingCount: 0,
  dirty: false,
  dirtyReasons: [],
  plateInputRevisions: {},
  scope: 'system',
  systemPresets: null,
  projectPresets: null,
  notices: [],
  operation: { phase: 'idle', progress: 0, cancellable: false },
});

export const useProjectStore = create<ProjectSessionState>((set) => ({
  ...initialSession(),
  setProject: (value) => set(value),
  beginProjectMutation: () => set((state) => ({ projectMutationPendingCount: state.projectMutationPendingCount + 1 })),
  endProjectMutation: () => set((state) => ({ projectMutationPendingCount: Math.max(0, state.projectMutationPendingCount - 1) })),
  markDirty: (reason) => set((state) => ({
    dirty: true,
    ...(reason && !state.dirtyReasons.includes(reason) ? { dirtyReasons: [...state.dirtyReasons, reason] } : {}),
  })),
  recordSharedConfigurationMutation: () => set((state) => ({
    dirty: true,
    dirtyReasons: state.dirtyReasons.includes('shared-configuration')
      ? state.dirtyReasons
      : [...state.dirtyReasons, 'shared-configuration'],
    plateInputRevisions: Object.fromEntries(
      Object.entries(state.plateInputRevisions).map(([plateId, revision]) => [plateId, revision + 1]),
    ),
  })),
  recordPlateMutation: (mutation) => set((state) => {
    const reasons = mutation.dirtyReasons ?? [];
    return {
      dirty: reasons.length > 0 ? true : state.dirty,
      ...(mutation.inputRevisions ? { plateInputRevisions: { ...mutation.inputRevisions } } : {}),
      ...(reasons.length > 0 ? { dirtyReasons: [...new Set([...state.dirtyReasons, ...reasons as ProjectDirtyReason[]])] } : {}),
    };
  }),
  markClean: () => set({ dirty: false, dirtyReasons: [] }),
  setOperation: (operation) => set((state) => ({
    operation: {
      ...state.operation,
      ...operation,
      progress: Math.max(0, Math.min(100, operation.progress ?? state.operation.progress)),
    },
  })),
  resetOperation: () => set({ operation: { phase: 'idle', progress: 0, cancellable: false } }),
  reset: () => set(initialSession()),
}));

export function projectPresetSelections(snapshot: { printer: { name: string }; print: { name: string } }): ProjectPresetSelections {
  return { printer: snapshot.printer.name, print: snapshot.print.name };
}

