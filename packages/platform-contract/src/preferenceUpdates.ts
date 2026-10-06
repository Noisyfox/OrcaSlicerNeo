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

/** Read after already queued preference writes, without rewriting the document. */
export async function loadUserPreferences(repository: UserPreferencesRepository): Promise<UserPreferences> {
  await (writes.get(repository) ?? Promise.resolve()).catch(() => undefined);
  return repository.load();
}
