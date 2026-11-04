import { beforeEach, expect, it, vi } from 'vitest';
import { normalizeUserPreferences } from '@orca/platform-contract';
import { loadMeshBooleanPreferences, setMeshBooleanKeepPainting, useMeshBooleanStore } from './useMeshBooleanStore';

beforeEach(() => useMeshBooleanStore.setState({ busy: false, ready: false, keepPainting: false }));
it('loads once with OFF as the default and persists only the Boolean policy without changing other preferences', async () => {
  let value = normalizeUserPreferences({ version: 1, selectedProfiles: { printer: 'P' } });
  const repository = { load: vi.fn(async () => value), save: vi.fn(async next => { value = next; }) };
  await Promise.all([loadMeshBooleanPreferences(repository), loadMeshBooleanPreferences(repository)]);
  expect(repository.load).toHaveBeenCalledOnce();
  expect(useMeshBooleanStore.getState()).toMatchObject({ ready: true, keepPainting: false });
  await setMeshBooleanKeepPainting(repository, true);
  expect(value.meshBooleanKeepPainting).toBe(true); expect(value.selectedProfiles.printer).toBe('P');
  useMeshBooleanStore.setState({ keepPainting: false });
  const reopened = { load: async () => value, save: repository.save };
  await loadMeshBooleanPreferences(reopened);
  expect(useMeshBooleanStore.getState().keepPainting).toBe(true);
  useMeshBooleanStore.setState({ busy: true });
  await setMeshBooleanKeepPainting(repository, false);
  expect(value.meshBooleanKeepPainting).toBe(true);
});
