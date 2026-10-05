import type { UserPreferences, UserPreferencesRepository } from './contracts';

const writes = new WeakMap<UserPreferencesRepository, Promise<unknown>>();

/** Serialize the complete read/modify/write transaction, not just disk writes.
 * Callers must describe their own changed fields against the latest document. */
export function updateUserPreferences(
  repository: UserPreferencesRepository,
  update: (current: UserPreferences) => UserPreferences,
): Promise<UserPreferences> {
  const task = (writes.get(repository) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const next = update(await repository.load());
    await repository.save(next);
    return next;
  });
  writes.set(repository, task);
  return task;
}
