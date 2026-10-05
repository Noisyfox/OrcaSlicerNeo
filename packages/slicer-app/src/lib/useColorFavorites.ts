import { useEffect, useSyncExternalStore } from 'react';
import { colorValueKey, MAX_COLOR_FAVORITES, normalizeColorFavorites, normalizeColorValue,
  updateUserPreferences, usePlatform, type ColorValue, type UserPreferencesRepository } from '@orca/platform-contract';

interface FavoriteSnapshot { favorites: readonly ColorValue[]; ready: boolean }
const controllers = new WeakMap<UserPreferencesRepository, ReturnType<typeof createColorFavorites>>();

/** One shared collection per injected repository; UI components stay host-free. */
export function createColorFavorites(repository: UserPreferencesRepository) {
  let snapshot: FavoriteSnapshot = { favorites: [], ready: false };
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (favorites: readonly ColorValue[]) => {
    snapshot = { favorites, ready: true }; for (const listener of listeners) listener();
  };
  const load = () => loading ??= repository.load().then(prefs => publish(normalizeColorFavorites(prefs.colorPicker?.favorites)))
    .catch(error => { console.error('Could not load color favorites', error); publish([]); });
  const mutate = async (update: (favorites: ColorValue[]) => ColorValue[]) => {
    await load();
    // Publish immediately; the queued transaction merges against the latest
    // document, so rapid clicks and unrelated preference edits remain intact.
    publish(update([...snapshot.favorites]));
    try {
      await updateUserPreferences(repository, current => ({ ...current,
        colorPicker: { favorites: update(normalizeColorFavorites(current.colorPicker?.favorites)) },
      }));
    } catch (error) { console.error('Could not save color favorites; keeping session collection', error); }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    add(value: ColorValue) {
      const color = normalizeColorValue(value);
      if (!color) return Promise.resolve();
      return mutate(favorites => favorites.some(item => colorValueKey(item) === colorValueKey(color)) || favorites.length >= MAX_COLOR_FAVORITES
        ? favorites : [color, ...favorites]);
    },
    remove(value: ColorValue) { return mutate(favorites => favorites.filter(item => colorValueKey(item) !== colorValueKey(value))); },
  };
}

export function useColorFavorites() {
  const { preferences } = usePlatform();
  let controller = controllers.get(preferences);
  if (!controller) { controller = createColorFavorites(preferences); controllers.set(preferences, controller); }
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.load(); }, [controller]);
  return { favorites: snapshot.favorites, favoritesReady: snapshot.ready,
    onFavoriteAdd: (value: ColorValue) => { void controller.add(value); },
    onFavoriteRemove: (value: ColorValue) => { void controller.remove(value); } };
}
