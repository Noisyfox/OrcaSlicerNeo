import { create } from 'zustand';
import { normalizeArrangementPreferences, updateUserPreferences, type ArrangementPreferences, type UserPreferencesRepository } from '@orca/platform-contract';
import type { ArrangementResult } from '@slicer/client';

export type ArrangementMode = 'byLayer' | 'byObject';
interface ArrangementState {
  preferences: ArrangementPreferences;
  ready: boolean;
  alignY: boolean;
  mode: ArrangementMode;
  printer: string | null;
  printerStructure: string;
  active: boolean;
  cancellable: boolean;
  cancelling: boolean;
  progress: number;
  message: string;
  result: ArrangementResult | null;
}
export const useArrangementStore = create<ArrangementState>(() => ({
  preferences: normalizeArrangementPreferences(null), ready: false, alignY: false,
  mode: 'byLayer', printer: null, printerStructure: '',
  active: false, cancellable: false, cancelling: false, progress: 0, message: '', result: null,
}));

const loads = new WeakMap<UserPreferencesRepository, Promise<void>>();
const writes = new WeakMap<UserPreferencesRepository, Promise<void>>();

export function arrangementMode(printSequence: string | undefined): ArrangementMode {
  return printSequence === 'by object' ? 'byObject' : 'byLayer';
}

/** Printer defaults are session state; switching print modes only enforces the
 * rotation exclusion and never writes a new printing preference. */
export function synchronizeArrangementContext(printer: string, printerStructure: string, printSequence: string | undefined): void {
  const state = useArrangementStore.getState();
  const mode = arrangementMode(printSequence);
  const changedPrinter = state.printer !== printer || state.printerStructure !== printerStructure;
  const alignY = !state.preferences[mode].rotate &&
    (changedPrinter ? printerStructure.toLowerCase() === 'i3' : state.alignY);
  if (changedPrinter || state.mode !== mode || state.alignY !== alignY)
    useArrangementStore.setState({ printer, printerStructure, mode, alignY });
}

export function setArrangementAlignY(alignY: boolean): void {
  const state = useArrangementStore.getState();
  useArrangementStore.setState({ alignY: alignY && !state.preferences[state.mode].rotate });
}

export function loadArrangementPreferences(repository: UserPreferencesRepository): Promise<void> {
  let task = loads.get(repository);
  if (!task) {
    task = repository.load().then(value => {
      const preferences = normalizeArrangementPreferences(value.arrangement);
      const state = useArrangementStore.getState();
      useArrangementStore.setState({ preferences, ready: true, alignY: state.alignY && !preferences[state.mode].rotate });
    })
      .catch(error => { useArrangementStore.setState({ ready: true }); console.error('Could not load arrangement preferences', error); });
    loads.set(repository, task);
  }
  return task;
}
export function updateArrangementPreferences(repository: UserPreferencesRepository, preferences: ArrangementPreferences): Promise<void> {
  const normalized = normalizeArrangementPreferences(preferences);
  const state = useArrangementStore.getState();
  useArrangementStore.setState({ preferences: normalized, alignY: state.alignY && !normalized[state.mode].rotate });
  const task = (writes.get(repository) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await updateUserPreferences(repository, current => ({ ...current, arrangement: normalized }));
  }).catch(error => { console.error('Could not save arrangement preferences', error); });
  writes.set(repository, task);
  return task;
}
export function resetArrangementPreferences(repository: UserPreferencesRepository, mode: ArrangementMode, printerStructure: string): Promise<void> {
  const current = useArrangementStore.getState().preferences;
  const defaults = normalizeArrangementPreferences(null);
  useArrangementStore.setState({ alignY: printerStructure.toLowerCase() === 'i3' });
  return updateArrangementPreferences(repository, { ...current, [mode]: defaults[mode], multipleMaterials: true, avoidCalibration: true });
}
