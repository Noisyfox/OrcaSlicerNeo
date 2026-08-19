import type { SlicerClient } from '@slicer/client';
import type { UserPreferences } from '@orca/platform-contract';

export async function restoreSelections(runtime: Pick<SlicerClient, 'selectPreset'>, preferences: UserPreferences): Promise<UserPreferences> {
  let resolved = preferences;
  for (const kind of ['printer', 'print', 'filament'] as const) {
    const name = preferences.selectedProfiles[kind];
    if (!name) continue;
    const result = await runtime.selectPreset(kind, name);
    if (result.ok) resolved = { ...resolved, selectedProfiles: {
      printer: result.printer.name, print: result.print.name, filament: result.filament.name,
    } };
    else console.warn(`profile ${kind} ${name} unavailable; using bridge default`);
  }
  return resolved;
}
