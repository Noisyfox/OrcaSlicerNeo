import type { SlicerClient } from '@slicer/client';
import type { UserPreferences } from '@orca/platform-contract';

export async function restoreSelections(runtime: Pick<SlicerClient, 'selectPreset' | 'getPresets'>, preferences: UserPreferences): Promise<UserPreferences> {
  let resolved: UserPreferences = { ...preferences, selectedProfiles: { ...preferences.selectedProfiles } };
  for (const kind of ['printer', 'print', 'filament'] as const) {
    const name = resolved.selectedProfiles[kind];
    let result = name ? await runtime.selectPreset(kind, name) : null;
    if (!result?.ok) {
      if (name) console.warn(`profile ${kind} ${name} unavailable; using first available profile`);
      const list = await runtime.getPresets(kind);
      const first = list.presets.find((p) => p.is_visible) ?? list.presets[0];
      if (first) result = await runtime.selectPreset(kind, first.name);
    }
    if (result?.ok) {
      resolved = { ...resolved, selectedProfiles: {
        printer: result.printer.name, print: result.print.name, filament: result.filament.name,
      } };
    }
  }
  return resolved;
}
