import { create } from 'zustand';
import type { UserPreferencesRepository } from '@orca/platform-contract';

/** Global execution state and application preference; operand picks belong to
 * the scene controller and never enter project history or persistence. */
export const useMeshBooleanStore = create<{
  busy: boolean; ready: boolean; keepPainting: boolean;
}>(() => ({ busy: false, ready: false, keepPainting: false }));

const loads = new WeakMap<UserPreferencesRepository, Promise<void>>();
export function loadMeshBooleanPreferences(repository: UserPreferencesRepository): Promise<void> {
  let task = loads.get(repository);
  if (!task) {
    task = repository.load().then(value => {
      useMeshBooleanStore.setState({ keepPainting: value.meshBooleanKeepPainting === true, ready: true });
    }).catch(error => {
      useMeshBooleanStore.setState({ ready: true });
      console.error('Could not load Mesh Boolean preferences', error);
    });
    loads.set(repository, task);
  }
  return task;
}
