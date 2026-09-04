import { create } from 'zustand';
import type { OpaqueProjectLocation } from '@orca/platform-contract';

export type ProjectPresetScope = 'system' | 'project';
export type ProjectOperationPhase =
  | 'idle'
  | 'waiting-for-load-choice'
  | 'waiting-for-dirty-decision'
  | 'loading'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ProjectPresetSelections {
  printer: string;
  print: string;
  filament: string;
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

export interface ProjectSessionState {
  /** Base name only; host paths never enter this store. */
  projectName: string;
  /** Host-private token, opaque to shared code and UI. */
  location?: OpaqueProjectLocation;
  hasContent: boolean;
  dirty: boolean;
  scope: ProjectPresetScope;
  systemPresets: ProjectPresetSelections | null;
  projectPresets: ProjectPresetSelections | null;
  flattenedMultiPlate: boolean;
  notices: ProjectNotice[];
  operation: ProjectOperation;
  setProject: (value: Partial<Pick<ProjectSessionState, 'projectName' | 'location' | 'hasContent' | 'dirty' | 'scope' | 'systemPresets' | 'projectPresets' | 'flattenedMultiPlate' | 'notices'>>) => void;
  markDirty: () => void;
  markClean: () => void;
  setOperation: (operation: Partial<ProjectOperation> & Pick<ProjectOperation, 'phase'>) => void;
  resetOperation: () => void;
  reset: () => void;
}

export const DEFAULT_PROJECT_PRESETS: ProjectPresetSelections = {
  printer: '', print: '', filament: '',
};

const initialSession = (): Omit<ProjectSessionState, 'setProject' | 'markDirty' | 'markClean' | 'setOperation' | 'resetOperation' | 'reset'> => ({
  projectName: 'Untitled',
  location: undefined,
  hasContent: false,
  dirty: false,
  scope: 'system',
  systemPresets: null,
  projectPresets: null,
  flattenedMultiPlate: false,
  notices: [],
  operation: { phase: 'idle', progress: 0, cancellable: false },
});

export const useProjectStore = create<ProjectSessionState>((set) => ({
  ...initialSession(),
  setProject: (value) => set(value),
  markDirty: () => set({ dirty: true }),
  markClean: () => set({ dirty: false }),
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

export function projectPresetTriple(snapshot: { printer: { name: string }; print: { name: string }; filament: { name: string } }): ProjectPresetSelections {
  return { printer: snapshot.printer.name, print: snapshot.print.name, filament: snapshot.filament.name };
}

