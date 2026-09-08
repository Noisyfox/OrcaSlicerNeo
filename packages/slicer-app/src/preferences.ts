import type { PresetSnapshot } from '@slicer/client';
import type { RememberedFilamentRack, UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, SlicerClient } from '@slicer/client';

export interface RestoredSelections {
  /** The engine-resolved names to persist for the next launch. */
  preferences: UserPreferences;
  /** The final coherent picker state; do not rebuild it with legacy list reads. */
  snapshot: PresetSnapshot;
}

/** Build the only durable rack preference from the Worker-owned projection. */
export function rememberedRackFromSnapshot(snapshot: FilamentSessionSnapshot): RememberedFilamentRack {
  return {
    version: 1,
    slots: snapshot.slots.map((slot) => ({
      preset: slot.preset.name,
      colour: slot.colour.effective,
    })),
  };
}

/**
 * Persist the current effective rack for one printer. Preference IO is a
 * best-effort side effect: a failure must never roll back native project
 * state or history navigation.
 */
export async function publishRememberedFilamentRack(
  repository: UserPreferencesRepository,
  printer: string,
  snapshot: FilamentSessionSnapshot,
): Promise<void> {
  if (!printer) return;
  try {
    const current = await repository.load();
    await repository.save({
      ...current,
      rememberedFilamentRacks: {
        ...(current.rememberedFilamentRacks ?? {}),
        [printer]: rememberedRackFromSnapshot(snapshot),
      },
    });
  } catch (error) {
    console.error('remembered filament rack save failed; keeping session state', error);
  }
}

export function rememberedFilamentRack(
  preferences: UserPreferences,
  printer: string,
): RememberedFilamentRack | null {
  const rack = preferences.rememberedFilamentRacks?.[printer];
  return rack && rack.version === 1 && rack.slots.length > 0 ? rack : null;
}

/**
 * Seed a fresh native session from a printer's last successfully stored rack.
 * Each native command remains revision-fenced; a missing/incompatible preset
 * simply leaves the fresh session at its engine-selected defaults.
 */
export async function restoreRememberedFilamentRack(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot' | 'restoreFilamentRack'>,
  preferences: UserPreferences,
  printer: string,
): Promise<FilamentSessionSnapshot | null> {
  const rack = rememberedFilamentRack(preferences, printer);
  if (!rack) return null;
  try {
    const current = await runtime.getFilamentSessionSnapshot();
    if (!current.ok) return null;
    const result = await runtime.restoreFilamentRack({ version: 1, revision: current.revisions.session, slots: rack.slots });
    return result.ok ? result.result.snapshot : null;
  } catch (error) {
    console.warn('remembered filament rack restore failed; keeping native defaults', error);
    return null;
  }
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
 * the C++ engine's coherent snapshots. A failed saved name falls back to the
 * current engine selection for that snapshot; the client never chooses a
 * "first" profile itself.
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
