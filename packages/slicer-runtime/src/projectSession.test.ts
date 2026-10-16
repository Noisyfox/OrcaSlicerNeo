import { describe, expect, it } from 'vitest';
import { compatibilityFallback, projectNameFromDisplayName, shouldAskProjectLoad } from './projectSession';
import { createWorkerClient, startWorker, type WorkerMessage } from './core';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from '../../slicer-wasm/src/client/testing/mock-module';

describe('project session policy', () => {
  it('keeps one scoped multi-target history operation through runtime refresh and Undo/Redo', async () => {
    const listeners: ((message: WorkerMessage) => void)[] = [];
    const transport = { post: (message: WorkerMessage) => listeners.forEach(listener => listener(message)),
      onMessage: (listener: (message: WorkerMessage) => void) => { listeners.push(listener); } };
    const client = createWorkerClient(transport);
    void startWorker(async () => createMockModule(), transport.post, transport.onMessage);
    await client.init(MOCK_PROFILE_ACTIVATION);
    await client.addShape('Cube', 'A'); await client.addShape('Cube', 'B');
    const structure = await client.getModelStructure(); if (!structure.ok) throw new Error(structure.error);
    const targets = structure.objects.map(object => ({ scope: 'object' as const, id: object.id }));
    const read = async () => { const result = await client.getScopedConfigEditor({version:1, targets}); if (!result.ok) throw new Error(result.error); return result; };
    const context = {selection:{mode:'object' as const,objectIds:targets.map(t=>t.id),partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}};
    await client.resetHistory(context);
    const mutate = (request: Parameters<typeof client.mutateNativeScopedConfig>[0]) => client.runProjectHistoryTransaction(
      'Scoped indexed edit','project',context,()=>client.mutateNativeScopedConfig(request),context);
    await mutate({ version:1,operation:'set-element',targets,expectedRevision:(await read()).revision,
      key:'outer_wall_speed',scalarType:'float',index:1,value:220 });
    const owned=await read();
    for(const target of owned.targets) expect(target.editorVectors.outer_wall_speed.overrideValues).toEqual([null,{value:220},null]);
    expect((await client.getHistoryStatus()).undoEntries).toHaveLength(1);
    await mutate({version:1,operation:'reset-fields',targets,expectedRevision:owned.revision,
      fields:[{key:'outer_wall_speed',kind:'indexed',index:1},{key:'layer_height',kind:'shared'}]});
    for(const target of (await read()).targets) expect(target.localKeys).not.toContain('outer_wall_speed');
    expect((await client.getHistoryStatus()).undoEntries).toHaveLength(2);
    await client.undoHistory();
    expect((await read()).targets).toEqual(owned.targets);
    await client.redoHistory();
    for(const target of (await read()).targets) expect(target.editorVectors.outer_wall_speed.overrideValues).toEqual([null,null,null]);
  });
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
    const beforeReset = await client.getHistoryStatus();
    const reset = await client.mutatePresetDraft({kind:'filament',canonicalName:source.canonicalName,
      expectedRevision:receipt.revision,action:'reset-category',fields:[
        {key:'filament_flow_ratio',kind:'indexed',index:1},{key:'filament_vendor',kind:'shared'},
      ]}, {selection:{mode:'object',objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}});
    expect(reset).toMatchObject({ok:true,historyEntryDelta:1,editorVectors:{filament_flow_ratio:{effectiveValues:[1,1]}}});
    expect((await client.getHistoryStatus()).undoEntries).toHaveLength(beforeReset.undoEntries.length+1);
    await client.undoHistory();
    expect(await client.getPresetDraft('filament',source.canonicalName)).toMatchObject({
      editorVectors:{filament_flow_ratio:{effectiveValues:[1,0.9]}},
    });
    const print = await client.getPrintConfigEditor();
    expect(print).toMatchObject({ ok: true, editorSelection: { kind: 'print', choices: [
      { extruderIndex: 0 }, { extruderIndex: 1 }, { extruderIndex: 2 },
    ] } });
    if(!print.ok)throw new Error(print.error);
    const context={selection:{mode:'object' as const,objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}};
    const mutatePrint=async(request:Parameters<typeof client.mutateNativeScopedConfig>[0])=>client.runProjectHistoryTransaction(
      'Print element','project',context,()=>client.mutateNativeScopedConfig(request),context);
    await mutatePrint({version:1,operation:'set-element',targets:[{scope:'project'}],expectedRevision:print.revision,
      key:'outer_wall_speed',index:2,scalarType:'float',value:240});
    const owned=await client.getPrintConfigEditor();if(!owned.ok)throw new Error(owned.error);
    expect(owned.editorVectors.outer_wall_speed.overrideValues).toEqual([null,null,{value:240}]);
    const history=await client.getHistoryStatus();
    await mutatePrint({version:1,operation:'reset-fields',targets:[{scope:'project'}],expectedRevision:owned.revision,
      fields:[{key:'outer_wall_speed',kind:'indexed',index:2},{key:'layer_height',kind:'shared'}]});
    expect((await client.getHistoryStatus()).undoEntries).toHaveLength(history.undoEntries.length+1);
    expect(await client.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{overrideValues:[null,null,null]}}});
    await client.undoHistory();
    expect(await client.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{overrideValues:[null,null,{value:240}]}}});
    // A Print operation neither retargets nor replaces the shared Filament draft.
    expect(await client.getPresetDraft('filament',source.canonicalName)).toMatchObject({editorVectors:{filament_flow_ratio:{effectiveValues:[1,0.9]}}});
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

