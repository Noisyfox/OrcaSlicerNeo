import { describe, expect, it } from 'vitest';
import { compatibilityFallback, projectNameFromDisplayName, shouldAskProjectLoad } from './projectSession';
import { createWorkerClient, startWorker, type WorkerMessage } from './core';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from '../../slicer-wasm/src/client/testing/mock-module';

describe('project session policy', () => {
  it('preserves selection mappings through the public runtime Worker boundary and receipt refresh', async () => {
    const listeners: ((message: WorkerMessage) => void)[] = [];
    const transport = { post: (message: WorkerMessage) => listeners.forEach(listener => listener(message)),
      onMessage: (listener: (message: WorkerMessage) => void) => { listeners.push(listener); } };
    const client = createWorkerClient(transport);
    void startWorker(async () => createMockModule(), transport.post, transport.onMessage);
    await client.init(MOCK_PROFILE_ACTIVATION);
    const source = await client.getPresetDraft('filament', 'Generic PLA @System');
    if (!source.ok) throw new Error(source.error);
    expect(source.editorSelection.fieldBindings.filament_flow_ratio).toEqual({ kind: 'per_selection',
      bindings: [{ kind: 'indexed', index: 0 }, { kind: 'indexed', index: 1 }] });
    const receipt = await client.mutatePresetDraft({ kind: 'filament', canonicalName: source.canonicalName,
      action: 'set-element', key: 'filament_flow_ratio', index: 1, scalarType: 'float', value: 0.9,
      expectedRevision: source.revision }, { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
      activePlateId: null, gizmo: null, nativeScopedConfig: {} });
    if (!receipt.ok) throw new Error(receipt.error);
    expect(receipt.editorSelection).toEqual(source.editorSelection);
    expect(receipt.editorVectors.filament_flow_ratio.effectiveValues[1]).toBe(0.9);
    const print = await client.getPrintConfigEditor();
    expect(print).toMatchObject({ ok: true, editorSelection: { kind: 'print', choices: [
      { extruderIndex: 0 }, { extruderIndex: 1 }, { extruderIndex: 2 },
    ] } });
  });
  it.each([
    ['load_all', false, false], ['load_all', true, false],
    ['ask_when_relevant', false, false], ['ask_when_relevant', true, true],
    ['always_ask', false, true], ['always_ask', true, true],
    ['load_geometry_only', false, false], ['load_geometry_only', true, false],
  ] as const)('load policy %s with model=%s asks=%s', (policy, model, expected) => {
    expect(shouldAskProjectLoad(policy, model)).toBe(expected);
  });

  it('reports generic, unsupported, and missing-setting fallback reasons', () => {
    expect(compatibilityFallback({ bedTypeNormalization: null, ok: true, objects: 1, instances: 1, compatibility: 'generic' })).toContain('generic');
    expect(compatibilityFallback({ bedTypeNormalization: null, ok: true, objects: 1, instances: 1, compatibility: 'unsupported' })).toContain('unavailable');
    expect(compatibilityFallback({ bedTypeNormalization: null, ok: true, objects: 1, instances: 1, compatibility: 'orca', projectSettingsAvailable: false })).toContain('unavailable');
    expect(compatibilityFallback({ bedTypeNormalization: null, ok: true, objects: 1, instances: 1, compatibility: 'bambu', projectSettingsAvailable: true })).toBeNull();
  });

  it('derives a safe project name from a display name', () => {
    expect(projectNameFromDisplayName('C:\\work\\Robot.3MF')).toBe('Robot');
    expect(projectNameFromDisplayName('')).toBe('Untitled');
  });
});

