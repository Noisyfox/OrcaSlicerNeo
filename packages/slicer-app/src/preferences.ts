import type { ProfileSnapshot } from '@slicer/client';
import type { RememberedFilamentRack, UserPreferences, UserPreferencesRepository } from '@orca/platform-contract';
import { loadUserPreferences, updateUserPreferences } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, SlicerClient } from '@slicer/client';
import type { HistoryContext, HistoryStatus } from '@slicer/client';
import { resetProjectHistory } from './components/workspace/actions/historyMutation';
import { useFilamentSessionStore } from './stores/useFilamentSessionStore';

export interface RestoredSelections {
  /** The engine-resolved names to persist for the next launch. */
  preferences: UserPreferences;
  /** The final coherent picker state; do not rebuild it with legacy list reads. */
  snapshot: ProfileSnapshot;
}

export interface RestoredBootstrapSession extends RestoredSelections {
  filament: FilamentSessionSnapshot;
  history: HistoryStatus;
}

// Rack edits are UI state first and preference state second.  Serialize
// writes per repository/printer so fire-and-forget persistence remains
// last-write-wins instead of allowing an older IPC/filesystem write to land
// after a newer slot mutation.
const rackWriteQueues = new WeakMap<object, Map<string, Promise<void>>>();

/** Build the only durable rack preference from the Worker-owned projection. */
export function rememberedRackFromSnapshot(snapshot: FilamentSessionSnapshot): RememberedFilamentRack {
  return {
    version: 1,
    slots: snapshot.slots.map((slot) => ({
      preset: slot.preset.name,
      colour: /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(slot.colour.effective)
        ? slot.colour.effective : slot.colour.display.colors.find((value) => /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) ?? '#26A69A',
      native: { ...slot.colour.native },
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
  let queues = rackWriteQueues.get(repository);
  if (!queues) { queues = new Map(); rackWriteQueues.set(repository, queues); }
  const previous = queues.get(printer) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    try {
      await updateUserPreferences(repository, current => ({
        ...current,
        rememberedFilamentRacks: {
          ...(current.rememberedFilamentRacks ?? {}),
          [printer]: rememberedRackFromSnapshot(snapshot),
        },
      }));
    } catch (error) {
      console.error('remembered filament rack save failed; keeping session state', error);
    }
  });
  queues.set(printer, write);
  await write;
  if (queues.get(printer) === write) queues.delete(printer);
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
export async function applyRememberedFilamentRack(
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot' | 'applyRememberedFilamentRack'>,
  preferences: UserPreferences,
  printer: string,
): Promise<FilamentSessionSnapshot | null> {
  const rack = rememberedFilamentRack(preferences, printer);
  if (!rack) return null;
  try {
    const current = await runtime.getFilamentSessionSnapshot();
    if (!current.ok) return null;
    const result = await runtime.applyRememberedFilamentRack({ version: 1, revision: current.revisions.session, slots: rack.slots });
    return result.ok ? result : null;
  } catch (error) {
    console.warn('remembered filament rack restore failed; keeping native defaults', error);
    return null;
  }
}

/** Wait for any in-flight rack publication before reading the target
 * printer's preference. This prevents a fast printer round-trip from applying
 * an older repository value after the newest rack has already been queued. */
export async function applyRememberedFilamentRackFromRepository(
  repository: UserPreferencesRepository,
  runtime: Pick<SlicerClient, 'getFilamentSessionSnapshot' | 'applyRememberedFilamentRack'>,
  printer: string,
): Promise<FilamentSessionSnapshot | null> {
  const pending = rackWriteQueues.get(repository)?.get(printer);
  if (pending) await pending.catch(() => undefined);
  try {
    return applyRememberedFilamentRack(runtime, await repository.load(), printer);
  } catch (error) {
    console.warn('remembered filament rack load failed; keeping native defaults', error);
    return null;
  }
}

/** Read a Printer's remembered rack without mutating native project state.
 * Explicit Printer transitions pass this value into the one native command,
 * unlike bootstrap/3MF restoration which applies it only to a fresh session. */
export async function loadRememberedFilamentRackFromRepository(
  repository: UserPreferencesRepository,
  printer: string,
): Promise<RememberedFilamentRack | null> {
  const pending = rackWriteQueues.get(repository)?.get(printer);
  if (pending) await pending.catch(() => undefined);
  try {
    return rememberedFilamentRack(await repository.load(), printer);
  } catch (error) {
    console.warn('remembered filament rack load failed; using native compatibility defaults', error);
    return null;
  }
}

function resolvedPreferences(preferences: UserPreferences, snapshot: ProfileSnapshot): UserPreferences {
  return {
    ...preferences,
    selectedProfiles: {
      printer: snapshot.printer.name,
      print: snapshot.print.name,
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
  runtime: Pick<SlicerClient, 'getProfileSnapshot' | 'selectProfile'>,
  preferences: UserPreferences,
): Promise<RestoredSelections> {
  let initial = await runtime.getProfileSnapshot();
  if (!initial.ok) throw new Error(initial.error ?? 'getProfileSnapshot failed');
  let snapshot = initial;

  for (const kind of ['printer', 'print'] as const) {
    const savedName = preferences.selectedProfiles[kind];
    const candidateName = snapshot[kind].name;
    const requestedName = savedName ?? candidateName;
    let result = await runtime.selectProfile(kind, requestedName);

    if (!result.ok) {
      if (savedName) {
        console.warn(`profile ${kind} ${savedName} unavailable; using the engine-selected candidate`);
      }
      // The current snapshot is still authoritative because a rejected
      // selectProfile leaves the engine state unchanged.
      result = await runtime.selectProfile(kind, candidateName);
    }
    if (!result.ok) throw new Error(result.error ?? `could not select ${kind}`);
    snapshot = result;
  }

  return { preferences: resolvedPreferences(preferences, snapshot), snapshot };
}

/** Restore the complete native boot session before React publishes any part
 * of it. The remembered rack is applied after native printer/process
 * compatibility, then history is reset so boot exposes one clean baseline. */
export async function restoreBootstrapSession(
  runtime: Pick<SlicerClient, 'getProfileSnapshot' | 'selectProfile' |
    'getFilamentSessionSnapshot' | 'applyRememberedFilamentRack' | 'resetHistory' | 'mutateNativeScopedConfig'>,
  preferences: UserPreferences,
  context: HistoryContext,
): Promise<RestoredBootstrapSession> {
  const restored = await restoreSelections(runtime, preferences);
  await applyRememberedFilamentRack(runtime, preferences, restored.snapshot.printer.name);
  const seeded = await seedRememberedBedType(runtime, preferences.rememberedBedTypes[restored.snapshot.printer.name] ?? null);
  if (seeded) {
    const snapshot = await runtime.getProfileSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error ?? 'seeded boot profile snapshot unavailable');
    restored.snapshot = snapshot;
    restored.preferences = resolvedPreferences(preferences, snapshot);
  }
  const history = await resetProjectHistory(runtime, context);
  const filament = useFilamentSessionStore.getState().snapshot ?? await runtime.getFilamentSessionSnapshot();
  if (!filament.ok) throw new Error(filament.error ?? 'filament session unavailable after bootstrap');
  return { ...restored, filament, history };
}

/** Preference persistence must never invalidate an already-resolved boot state. */
export async function persistRestoredSelections(
  repository: UserPreferencesRepository,
  preferences: UserPreferences,
): Promise<void> {
  try {
    await updateUserPreferences(repository, current => ({ ...current, selectedProfiles: preferences.selectedProfiles }));
  } catch (error) {
    console.error('restored profile preference save failed; keeping session state', error);
  }
}

/** Preference memory never belongs to a project-history frame. */
export async function publishRememberedBedType(repository: UserPreferencesRepository, printer: string, bed: string): Promise<void> {
  if (!printer || !bed) return;
  try {
    await updateUserPreferences(repository, current => ({ ...current,
      rememberedBedTypes: { ...current.rememberedBedTypes, [printer]: bed },
    }));
  } catch (error) { console.error('remembered bed type save failed; keeping session state', error); }
}

export async function loadRememberedBedTypeFromRepository(repository: UserPreferencesRepository, printer: string): Promise<string | null> {
  try {
    const value = (await loadUserPreferences(repository)).rememberedBedTypes[printer];
    return typeof value === 'string' && value.trim() ? value : null;
  }
  catch (error) { console.warn('remembered bed type unavailable; using native default', error); return null; }
}

/** Only bootstrap and New Project seed memory. Project loads/history restore
 * their own native roots. Invalid memory falls back to the selected Printer's
 * already-normalized native default. This seed precedes the clean baseline. */
export async function seedRememberedBedType(
  runtime: Pick<SlicerClient, 'getProfileSnapshot' | 'mutateNativeScopedConfig'>,
  bed: string | null,
): Promise<import('@slicer/client').NativeScopedConfigResult | null> {
  if (!bed) return null;
  const snapshot = await runtime.getProfileSnapshot();
  if (!snapshot.ok) throw new Error(snapshot.error ?? 'Printer capabilities unavailable');
  if (!snapshot.bedType.supportsSelection || !snapshot.bedType.choices.some(choice => choice.value === bed)) return null;
  const result = await runtime.mutateNativeScopedConfig({ version: 1, operation: 'set',
    targets: [{ scope: 'project' }], key: 'curr_bed_type', value: bed });
  if (!result.ok) throw new Error(result.error);
  return result;
}
