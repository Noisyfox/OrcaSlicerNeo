// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PresetDraftSnapshot } from '@slicer/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RegistryPresetField } from './PresetEditorDialog';
import { RegistryScopedField } from './ScopedConfigurationPanel';
import { FILAMENT_PRESET_EDITOR_MANIFEST } from './presetEditorManifests';
import { presetOptionPublication, type PresetOptionData } from './presetOptionProjection';
import { scopedOptionPublication, type ScopedOptionData } from './scopedOptionProjection';
import { OptionStateScope } from './optionStateRegistry';
import { editorSettingContext } from './settingConditionContext';
import { updateOptionStates } from './updateOptionStates';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

describe('production editor option subscriptions', () => {
  it('keeps Filament controls mounted, and only commits renders for changed option presentation or values', async () => {
    const keys = ['adaptive_pressure_advance_bridges', 'pressure_advance', 'filament_cost'];
    let snapshot = {
      ok: true, kind: 'filament', canonicalName: 'Filament', revision: 1, modified: false, draftExists: false,
      sourceValues: { adaptive_pressure_advance_bridges: '1', pressure_advance: '0.03', filament_cost: '20' },
      effectiveValues: { adaptive_pressure_advance_bridges: '1', pressure_advance: '0.03', filament_cost: '20', enable_pressure_advance: '1', adaptive_pressure_advance: '1' },
      optionMetadata: { adaptive_pressure_advance_bridges: { type: 'bool' }, pressure_advance: { type: 'float' }, filament_cost: { type: 'float' } },
      editorVectors: {}, editorBindings: {}, overrides: {}, editorCandidates: [],
      editorSelection: { kind: 'filament', activeSource: false, choices: [], firstChoiceId: null, nozzles: [],
        fieldBindings: Object.fromEntries(keys.map(key => [key, { kind: 'shared' }])) },
    } as PresetDraftSnapshot;
    const scope = new OptionStateScope<PresetOptionData>();
    const publish = () => scope.publish(keys.map(key => presetOptionPublication(snapshot, key, null, false, false)),
      [editorSettingContext(snapshot, null, { scope: 'filament' })], updateOptionStates, JSON.stringify(snapshot.effectiveValues));
    publish();
    const renders = new Map<string, number>();
    const record = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
    const mutate = vi.fn(async () => ({ ok: false as const, error: 'not submitted' }));
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<TooltipProvider>{keys.map(key => {
        const page = FILAMENT_PRESET_EDITOR_MANIFEST.pages.find(page => page.groups.some(group => group.fields.some(field => field.key === key)))!;
        const group = page.groups.find(group => group.fields.some(field => field.key === key))!;
        const field = group.fields.find(field => field.key === key)!;
        return <Profiler key={key} id={key} onRender={record}><RegistryPresetField scope={scope} field={field} page={page} group={group} onMutate={mutate} /></Profiler>;
      })}</TooltipProvider>));
      const checkbox = container.querySelector<HTMLElement>('[data-testid="preset-editor-input-adaptive_pressure_advance_bridges"]')!;
      const pressure = container.querySelector<HTMLInputElement>('[data-testid="preset-editor-input-pressure_advance"]')!;
      const cost = container.querySelector<HTMLInputElement>('[data-testid="preset-editor-input-filament_cost"]')!;
      expect(checkbox).not.toBeNull();
      const initial = new Map(renders);
      snapshot = { ...snapshot, revision: 2, effectiveValues: { ...snapshot.effectiveValues, enable_pressure_advance: '0' } };
      await act(async () => publish());
      expect(renders.get('filament_cost')).toBe(initial.get('filament_cost'));
      expect(renders.get('pressure_advance')).toBeGreaterThan(initial.get('pressure_advance')!);
      expect(pressure.disabled).toBe(true);
      expect(checkbox.closest('article')!.hidden).toBe(true);
      expect(container.querySelector('[data-testid="preset-editor-input-adaptive_pressure_advance_bridges"]')).toBe(checkbox);
      const stable = new Map(renders);
      snapshot = { ...snapshot, revision: 3 };
      await act(async () => publish());
      expect(renders).toEqual(stable);
      snapshot = { ...snapshot, revision: 4, effectiveValues: { ...snapshot.effectiveValues, enable_pressure_advance: '1' } };
      await act(async () => publish());
      expect(checkbox.closest('article')!.hidden).toBe(false);
      expect(container.querySelector('[data-testid="preset-editor-input-pressure_advance"]')).toBe(pressure);
      expect(container.querySelector('[data-testid="preset-editor-input-filament_cost"]')).toBe(cost);
      const beforeValue = new Map(renders);
      snapshot = { ...snapshot, effectiveValues: { ...snapshot.effectiveValues, filament_cost: '25' } };
      await act(async () => publish());
      expect(cost.value).toBe('25');
      expect(renders.get('pressure_advance')).toBe(beforeValue.get('pressure_advance'));
      expect(mutate).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });

  it('keeps Project/Objects controls and untouched render counts stable across toggles and revision-only publications', async () => {
    const scope = new OptionStateScope<ScopedOptionData>();
    let revision = 1;
    const keys = ['prime_tower_width', 'layer_height'];
    const targets = [{ scope: 'project' as const, label: 'Project' }];
    const rows = () => keys.map(key => scopedOptionPublication({ field: {
      key, label: key, category: 'Test', meta: { type: 'float' }, value: key === 'layer_height' ? '0.2' : '35',
      mixed: false, source: 'project', local: true, resettable: true,
      editor: { target: { kind: 'shared' }, source: '0', effective: key === 'layer_height' ? '0.2' : '35', revision },
    }, targets, disabled: false, selectionGutter: false, viewKey: key }));
    const publish = (enabled: boolean) => scope.publish(rows(), [editorSettingContext(null, null, {
      scope: 'project', projectValues: { enable_prime_tower: enabled ? '1' : '0', wipe_tower_wall_type: 'rectangle' },
    })], updateOptionStates, String(enabled));
    publish(true);
    const renders = new Map<string, number>();
    const record = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);
    const commit = vi.fn(async () => '35'), reset = vi.fn(async () => {});
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => root.render(<TooltipProvider>{keys.map(key => <Profiler key={key} id={key} onRender={record}>
        <RegistryScopedField scope={scope} optionKey={key} onCommit={commit} onReset={reset} />
      </Profiler>)}</TooltipProvider>));
      const width = container.querySelector<HTMLInputElement>('[data-testid="config-input-prime_tower_width"]')!;
      const height = container.querySelector('[data-testid="config-input-layer_height"]');
      const baseline = new Map(renders);
      revision++;
      await act(async () => publish(false));
      expect(width.closest<HTMLElement>('[data-testid="config-field-prime_tower_width"]')!.hidden).toBe(true);
      expect(renders.get('layer_height')).toBe(baseline.get('layer_height'));
      const hidden = new Map(renders);
      revision++;
      await act(async () => publish(false));
      expect(renders).toEqual(hidden);
      await act(async () => publish(true));
      expect(container.querySelector('[data-testid="config-input-prime_tower_width"]')).toBe(width);
      expect(container.querySelector('[data-testid="config-input-layer_height"]')).toBe(height);
      expect(commit).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
