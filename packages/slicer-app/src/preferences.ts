import type { PresetSnapshot, SlicerClient } from '@slicer/client';
import type { UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';

export interface RestoredSelections {
  /** The engine-resolved names to persist for the next launch. */
  preferences: UserPreferences;
  /** The final coherent picker state; do not rebuild it with legacy list reads. */
  snapshot: PresetSnapshot;
}

function resolvedPreferences(preferences: UserPreferences, snapshot: PresetSnapshot): UserPreferences {
  return {
    ...preferences,
    selectedProfiles: {
      printer: snapshot.printer.name,
      print: snapshot.print.name,
      filament: snapshot.filament.name,
    },
  };
}

/**
 * Restore profile names in dependency order using only candidates emitted by
 * the C++ engine's coherent snapshots. In particular, this deliberately does
 * not consult getPresets() or choose a client-side "first" profile: a failed
 * saved name falls back to the current engine selection for that snapshot.
 */
export async function restoreSelections(
  runtime: Pick<SlicerClient, 'getPresetSnapshot' | 'selectPreset'>,
  preferences: UserPreferences,
): Promise<RestoredSelections> {
  let initial = await runtime.getPresetSnapshot();
  if (!initial.ok) throw new Error(initial.error ?? 'getPresetSnapshot failed');
  let snapshot = initial;

  for (const kind of ['printer', 'print', 'filament'] as const) {
    const savedName = preferences.selectedProfiles[kind];
    const candidateName = snapshot[kind].name;
    const requestedName = savedName ?? candidateName;
    let result = await runtime.selectPreset(kind, requestedName);

    if (!result.ok) {
      if (savedName) {
        console.warn(`profile ${kind} ${savedName} unavailable; using the engine-selected candidate`);
      }
      // The current snapshot is still authoritative because a rejected
      // selectPreset leaves the engine state unchanged.
      result = await runtime.selectPreset(kind, candidateName);
    }
    if (!result.ok) throw new Error(result.error ?? `could not select ${kind}`);
    snapshot = result;
  }

  return { preferences: resolvedPreferences(preferences, snapshot), snapshot };
}

/** Preference persistence must never invalidate an already-resolved boot state. */
export async function persistRestoredSelections(
  repository: UserPreferencesRepository,
  preferences: UserPreferences,
): Promise<void> {
  try {
    await repository.save(preferences);
  } catch (error) {
    console.error('restored profile preference save failed; keeping session state', error);
  }
}
