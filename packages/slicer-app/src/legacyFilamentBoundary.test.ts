import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function source(relative: string): string {
  const text = sources[relative];
  if (typeof text !== 'string') throw new Error(`missing source fixture ${relative}`);
  return text;
}

describe('multi-filament application boundary', () => {
  it('keeps printer/process selection separate from rack-owned filament state', () => {
    const settingsPanel = source('./components/workspace/settings/SettingsPanel.tsx');
    const settingsStore = source('./stores/useSettingsStore.ts');
    const preferences = source('./preferences.ts');
    const projectActions = source('./projectActions.ts');

    for (const productionSource of [settingsPanel, settingsStore, preferences, projectActions]) {
      expect(productionSource).not.toContain('filament-preset-select');
      expect(productionSource).not.toContain('selectedFilament');
      expect(productionSource).not.toContain('selectPreset');
      expect(productionSource).not.toContain('getPresetSnapshot');
    }
    expect(settingsPanel).toContain('selectProfile');
    expect(source('./components/workspace/FilamentRack.tsx')).toContain('filamentCatalog');
  });

  it('keeps the rack catalogue separate from the printer/process selectors', () => {
    const settingsStore = source('./stores/useSettingsStore.ts');
    const projectStore = source('./stores/useProjectStore.ts');
    const projectActions = source('./projectActions.ts');
    const app = source('./App.tsx');
    expect(settingsStore).toContain('filamentCatalog');
    expect(settingsStore).not.toContain('selectedFilament');
    expect(settingsStore).not.toContain('hydratePresetSnapshot');
    for (const productionSource of [projectStore, projectActions, app]) {
      expect(productionSource).not.toContain('ProjectPresetSelections.filament');
      expect(productionSource).not.toContain('filamentCatalog?.[0]');
      expect(productionSource).not.toContain('compatibilityFilament');
    }
  });
});
