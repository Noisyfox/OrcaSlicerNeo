import { expect, it } from 'vitest';
import { DEFAULT_USER_PREFERENCES, type UserPreferences, type UserPreferencesRepository } from './contracts';
import { updateUserPreferences } from './preferenceUpdates';

it('serializes full transactions and preserves unrelated fields across concurrent writers', async () => {
  let saved: UserPreferences = structuredClone(DEFAULT_USER_PREFERENCES);
  let active = 0, maxActive = 0;
  const repository: UserPreferencesRepository = {
    async load() { return structuredClone(saved); },
    async save(next) {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 5)); saved = structuredClone(next); active--;
    },
  };
  const profileActivation = { models: [{ vendor: 'BBL', model: 'P', nozzle_diameter: ['0.4'] }], filaments: ['PLA'] };
  await Promise.all([
    updateUserPreferences(repository, current => ({ ...current, ui: { ...current.ui, sidebarWidth: 300 } })),
    updateUserPreferences(repository, current => ({ ...current, colorPicker: { favorites: [{ kind: 'solid', color: '#12345680' }] } })),
    updateUserPreferences(repository, current => ({ ...current, profileActivation })),
    updateUserPreferences(repository, current => ({ ...current, selectedProfiles: { printer: 'P' } })),
  ]);
  expect(saved.profileActivation).toEqual(profileActivation);
  expect(maxActive).toBe(1);
  expect(saved).toMatchObject({ ui: { sidebarWidth: 300 }, selectedProfiles: { printer: 'P' },
    colorPicker: { favorites: [{ kind: 'solid', color: '#12345680' }] } });
});

it('a rejected transaction does not poison the next update', async () => {
  let saved = structuredClone(DEFAULT_USER_PREFERENCES);
  let fail = true;
  const repository: UserPreferencesRepository = { async load() { return saved; }, async save(next) {
    if (fail) { fail = false; throw new Error('disk full'); } saved = next;
  } };
  await expect(updateUserPreferences(repository, current => current)).rejects.toThrow('disk full');
  await updateUserPreferences(repository, current => ({ ...current, ui: { ...current.ui, sidebarWidth: 300 } }));
  expect(saved.ui.sidebarWidth).toBe(300);
});
