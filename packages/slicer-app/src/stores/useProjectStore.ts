import { create } from 'zustand';
import type { OpaqueProjectLocation } from '@orca/platform-contract';
import { projectNameFromDisplayName } from '@orca/slicer-runtime';

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
  kind: 'compatibility-fallback' | 'multi-plate' | 'embedded-presets' | 'bed-type-normalization';
  message: string;
  details?: unknown;
}

export interface ProjectOperation {
  phase: ProjectOperationPhase;
  progress: number;
  message?: string;
  cancellable: boolean;
}

export interface ProjectSessionState {
  /** Base name only; host paths never enter this store. */
  projectName: string;
  /** Actual opened/saved display filename; null for an unsaved new session.
   * Independent of the host's ability to overwrite a file. Never an OS path. */
  projectFileName: string | null;
  /** Host-private token, opaque to shared code and UI. */
  location?: OpaqueProjectLocation;
  hasContent: boolean;
  /** Number of project mutations whose native and renderer projections have
   * not completed yet. Revision-fenced filament commands must not overtake
   * them. */
  projectMutationPendingCount: number;
  /** Synchronous UI projection of Worker HistoryStatus.dirty. */
  dirty: boolean;
  scope: ProjectPresetScope;
  systemPresets: ProjectPresetSelections | null;
  projectPresets: ProjectPresetSelections | null;
  notices: ProjectNotice[];
  operation: ProjectOperation;
  setProject: (value: Partial<Pick<ProjectSessionState, 'projectName' | 'projectFileName' | 'location' | 'hasContent' | 'scope' | 'systemPresets' | 'projectPresets' | 'notices'>>) => void;
  beginProjectMutation: () => void;
  endProjectMutation: () => void;
  setOperation: (operation: Partial<ProjectOperation> & Pick<ProjectOperation, 'phase'>) => void;
  resetOperation: () => void;
  reset: () => void;
}

export const DEFAULT_PROJECT_PRESETS: ProjectPresetSelections = {
  printer: '', print: '',
};

const initialSession = (): Omit<ProjectSessionState, 'setProject' | 'beginProjectMutation' | 'endProjectMutation' | 'setOperation' | 'resetOperation' | 'reset'> => ({
  projectName: 'Untitled',
  projectFileName: null,
  location: undefined,
  hasContent: false,
  projectMutationPendingCount: 0,
  dirty: false,
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

/** Empty means Orca should derive input_filename_base from printable objects. */
export function projectFilenameBase(session: Pick<ProjectSessionState, 'projectFileName'>): string {
  return session.projectFileName === null ? '' : projectNameFromDisplayName(session.projectFileName);
}

