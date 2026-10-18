import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { FILAMENT_OVERRIDE_KEYS } from './filamentOverrides';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from './testing/mock-module';

const context = { selection: { mode: 'object' as const, objectIds: [], partIds: [], instanceIds: [] }, activePlateId: null, gizmo: null, nativeScopedConfig: {} };

describe('Filament Setting Overrides projection', () => {
  it('uses current Printer references and preserves Filament nil values, false and zero', async () => {
    const client = createClient(async () => createMockModule()); await client.init(MOCK_PROFILE_ACTIVATION);
    const read = async () => { const result = await client.getPresetDraft('filament', 'Generic PLA @System');
      if (!result.ok) throw new Error(result.error); return result; };
    const before = await client.getHistoryStatus();
    const initial = await read();
    expect(Object.keys(initial.filamentOverrideContext).sort()).toEqual([...FILAMENT_OVERRIDE_KEYS].sort());
    expect(initial.filamentOverrideContext.filament_retraction_length.map(entry => entry.referenceValue)).toEqual([0.8, 0.8]);
    expect(initial.editorVectors.filament_retraction_length.effectiveValues).toEqual([null, null]);
    expect(initial.filamentOverrideContext.filament_wipe[0].referenceValue).toBe(false);
    expect(initial.filamentOverrideContext.filament_ironing_inset[0].referenceValue).toBe(0);
    expect(await client.getHistoryStatus()).toEqual(before);
    const profile = await client.getProfileSnapshot(); if (!profile.ok) throw new Error(profile.error);
    const printer = profile.printer.name;
    const p = await client.getPresetDraft('printer', printer); if (!p.ok) throw new Error(p.error);
    expect(p.filamentOverrideContext).toEqual({});
    const changed = await client.mutatePresetDraft({ kind: 'printer', canonicalName: printer, action: 'set-element', key: 'retraction_length', scalarType: 'float', index: 0, value: 0, expectedRevision: p.revision }, context);
    if (!changed.ok) throw new Error(changed.error);
    const disabled = await read();
    expect(disabled.filamentOverrideContext.filament_retraction_speed.every(entry => !entry.enabled)).toBe(true);
    expect(disabled.filamentOverrideContext.filament_retraction_length[0].enabled).toBe(true);
    const edit = await client.mutatePresetDraft({ kind: 'filament', canonicalName: initial.canonicalName, action: 'set-element', key: 'filament_retraction_length', scalarType: 'float', index: 1, value: 1, expectedRevision: disabled.revision }, context);
    if (!edit.ok) throw new Error(edit.error);
    expect(edit.filamentOverrideContext).toEqual((await read()).filamentOverrideContext);
    expect(edit.filamentOverrideContext.filament_retraction_speed.map(entry => entry.enabled)).toEqual([false, true]);
    await client.undoHistory();
    expect((await read()).filamentOverrideContext.filament_retraction_speed.every(entry => !entry.enabled)).toBe(true);
  });

  it.each(['missing', 'type', 'count', 'unknown', 'hidden-enabled'] as const)('rejects %s native override context', async mode => {
    const module = createMockModule(), original = module.ccall;
    module.ccall = (name, ret, types, args) => {
      const pointer = original(name, ret, types, args); if (name !== 'orc_get_preset_draft') return pointer;
      const payload = JSON.parse(module.UTF8ToString(Number(pointer))); module._free(Number(pointer));
      const entry = payload.filament_override_context.filament_retraction_length;
      if (mode === 'missing') delete payload.filament_override_context;
      if (mode === 'type') entry[0].reference_value = false;
      if (mode === 'count') entry.pop();
      if (mode === 'unknown') payload.filament_override_context.other = [];
      if (mode === 'hidden-enabled') Object.assign(entry[0], { visible: false, enabled: true });
      const bytes = new TextEncoder().encode(JSON.stringify(payload)), next = module._malloc(bytes.length + 1);
      module.HEAPU8.set(bytes, next); module.HEAPU8[next + bytes.length] = 0; return next;
    };
    const client = createClient(async () => module); await client.init(MOCK_PROFILE_ACTIVATION);
    expect(await client.getPresetDraft('filament', 'Generic PLA @System')).toMatchObject({ ok: false, errorCode: 'invalid_response' });
  });
});
