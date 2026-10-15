import { expect, it } from 'vitest';
import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences, updateUserPreferences, type UserPreferencesRepository } from '@orca/platform-contract';
import { createColorFavorites } from './useColorFavorites';

it('restores, shares, normalizes and persists favorites across a recreated controller', async () => {
  let saved = normalizeUserPreferences(DEFAULT_USER_PREFERENCES);
  const repository: UserPreferencesRepository = { async load() { return structuredClone(saved); }, async save(next) { saved = normalizeUserPreferences(next); } };
  const colors = createColorFavorites(repository);
  await Promise.all([
    colors.add({ kind: 'solid', color: '#12345680' }),
    colors.add({ kind: 'linear-gradient', colors: ['#F008', '#00F'] }),
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

it('keeps sixteen favorites, evicts the oldest new-color save and promotes existing colors without duplication', async () => {
  const initial = Array.from({ length: 16 }, (_, i) => ({ kind: 'solid' as const, color: '#' + i.toString(16).padStart(6, '0').toUpperCase() }));
  let saved = normalizeUserPreferences({ ...DEFAULT_USER_PREFERENCES, colorPicker: { favorites: initial } });
  const repository: UserPreferencesRepository = { async load() { return saved; }, async save(next) { saved = next; } };
  const colors = createColorFavorites(repository); await colors.add({ kind: 'solid', color: '#FFFFFF' });
  const afterAdd = [{ kind: 'solid' as const, color: '#FFFFFF' }, ...initial.slice(0, 15)];
  expect(saved.colorPicker!.favorites).toEqual(afterAdd);
  await colors.add({ kind: 'solid', color: '#000007FF' });
  const reordered = [initial[7], ...afterAdd.filter(item => item.color !== initial[7].color)];
  expect(colors.getSnapshot().favorites).toEqual(reordered);
  expect(saved.colorPicker!.favorites).toEqual(reordered);
  const restored = createColorFavorites(repository); await restored.load();
  expect(restored.getSnapshot().favorites).toEqual(reordered);
});

it('merges picker layout and concurrent favorite writes without losing other preferences', async () => {
  let saved = normalizeUserPreferences(DEFAULT_USER_PREFERENCES);
  const repository: UserPreferencesRepository = { async load() { return structuredClone(saved); }, async save(next) { saved = normalizeUserPreferences(next); } };
  const colors = createColorFavorites(repository);
  await Promise.all([
    colors.updateUi({ sidebarOpen: true, paletteId: 'gradient' }),
    colors.add({ kind: 'linear-gradient', colors: ['#11223301', '#44556680', '#778899FE'] }),
    updateUserPreferences(repository, current => ({ ...current, ui: { ...current.ui, sidebarWidth: 480 } })),
  ]);
  const restored = createColorFavorites(repository); await restored.load();
  expect(restored.getSnapshot()).toEqual(colors.getSnapshot());
  expect(saved.colorPicker!.ui).toEqual({ sidebarOpen: true, paletteId: 'gradient' });
  expect(saved.colorPicker!.favorites).toEqual([{ kind: 'linear-gradient', colors: ['#11223301', '#44556680', '#778899FE'] }]);
  expect(saved.ui.sidebarWidth).toBe(480);
});
