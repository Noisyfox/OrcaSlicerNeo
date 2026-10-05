import { expect, it } from 'vitest';
import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences, updateUserPreferences, type UserPreferencesRepository } from '@orca/platform-contract';
import { createColorFavorites } from './useColorFavorites';

it('restores, shares, normalizes and persists favorites across a recreated controller', async () => {
  let saved = normalizeUserPreferences(DEFAULT_USER_PREFERENCES);
  const repository: UserPreferencesRepository = { async load() { return structuredClone(saved); }, async save(next) { saved = normalizeUserPreferences(next); } };
  const colors = createColorFavorites(repository);
  await Promise.all([
    colors.add({ kind: 'solid', color: '#12345680' }),
    colors.add({ kind: 'linear-gradient', start: '#F008', end: '#00F' }),
    updateUserPreferences(repository, current => ({ ...current, ui: { ...current.ui, sidebarWidth: 400 } })),
  ]);
  await colors.add({ kind: 'solid', color: '#0000FFFF' });
  await colors.add({ kind: 'solid', color: '#0000FF' });
  const restored = createColorFavorites(repository); await restored.load();
  expect(restored.getSnapshot().favorites).toEqual(colors.getSnapshot().favorites);
  expect(saved.ui.sidebarWidth).toBe(400);
  expect(saved.colorPicker!.favorites).toHaveLength(3);
  await restored.remove({ kind: 'solid', color: '#12345680' });
  expect(saved.colorPicker!.favorites).toHaveLength(2);
});

it('keeps a full collection intact instead of evicting a favorite', async () => {
  const initial = Array.from({ length: 24 }, (_, i) => ({ kind: 'solid' as const, color: '#' + i.toString(16).padStart(6, '0').toUpperCase() }));
  let saved = normalizeUserPreferences({ ...DEFAULT_USER_PREFERENCES, colorPicker: { favorites: initial } });
  const repository: UserPreferencesRepository = { async load() { return saved; }, async save(next) { saved = next; } };
  const colors = createColorFavorites(repository); await colors.add({ kind: 'solid', color: '#FFFFFF' });
  expect(saved.colorPicker!.favorites).toEqual(initial);
  await colors.add({ kind: 'solid', color: '#000007FF' });
  const reordered = [initial[7], ...initial.filter((_, index) => index !== 7)];
  expect(colors.getSnapshot().favorites).toEqual(reordered);
  expect(saved.colorPicker!.favorites).toEqual(reordered);
  const restored = createColorFavorites(repository); await restored.load();
  expect(restored.getSnapshot().favorites).toEqual(reordered);
});
