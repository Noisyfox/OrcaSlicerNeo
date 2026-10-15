import { useEffect, useSyncExternalStore } from 'react';
import { colorValueKey, MAX_COLOR_FAVORITES, normalizeColorFavorites, normalizeColorValue,
  DEFAULT_COLOR_PICKER_UI, normalizeColorPickerUi, updateUserPreferences, usePlatform, type ColorPickerUiState, type ColorValue, type UserPreferencesRepository } from '@orca/platform-contract';

interface FavoriteSnapshot { favorites: readonly ColorValue[]; ui: ColorPickerUiState; ready: boolean }
const controllers = new WeakMap<UserPreferencesRepository, ReturnType<typeof createColorFavorites>>();

/** One shared collection per injected repository; UI components stay host-free. */
export function createColorFavorites(repository: UserPreferencesRepository) {
  let snapshot: FavoriteSnapshot = { favorites: [], ui: DEFAULT_COLOR_PICKER_UI, ready: false };
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (favorites: readonly ColorValue[], ui = snapshot.ui) => {
    snapshot = { favorites, ui, ready: true }; for (const listener of listeners) listener();
  };
  const load = () => loading ??= repository.load().then(prefs => publish(normalizeColorFavorites(prefs.colorPicker?.favorites), normalizeColorPickerUi(prefs.colorPicker?.ui)))
    .catch(error => { console.error('Could not load color favorites', error); publish([]); });
  const mutate = async (update: (favorites: ColorValue[]) => ColorValue[]) => {
    await load();
    // Publish immediately; the queued transaction merges against the latest
    // document, so rapid clicks and unrelated preference edits remain intact.
    publish(update([...snapshot.favorites]));
    try {
      await updateUserPreferences(repository, current => ({ ...current,
        colorPicker: { ...current.colorPicker, favorites: update(normalizeColorFavorites(current.colorPicker?.favorites)) },
      }));
    } catch (error) { console.error('Could not save color favorites; keeping session collection', error); }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    async updateUi(ui: ColorPickerUiState) {
      await load();
      const normalized = normalizeColorPickerUi(ui);
      publish(snapshot.favorites, normalized);
      try {
        await updateUserPreferences(repository, current => ({ ...current,
          colorPicker: { favorites: [], ...current.colorPicker, ui: normalized },
        }));
      } catch (error) { console.error('Could not save color picker layout; keeping session layout', error); }
    },
    add(value: ColorValue) {
      const color = normalizeColorValue(value);
      if (!color) return Promise.resolve();
      return mutate(favorites => {
        const key = colorValueKey(color);
        const existing = favorites.find(item => colorValueKey(item) === key);
        if (existing) return [existing, ...favorites.filter(item => colorValueKey(item) !== key)];
        return favorites.length >= MAX_COLOR_FAVORITES ? favorites : [color, ...favorites];
      });
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
  return { favorites: snapshot.favorites, favoritesReady: snapshot.ready, uiState: snapshot.ui,
    onUiStateChange: (ui: ColorPickerUiState) => { void controller.updateUi(ui); },
    onFavoriteAdd: (value: ColorValue) => { void controller.add(value); },
    onFavoriteRemove: (value: ColorValue) => { void controller.remove(value); } };
}
