// @vitest-environment jsdom
import { EditorSnapshotController } from './usePrintConfigEditor';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  createMockModule,
  MOCK_PROFILE_ACTIVATION,
  type ConfigEditorSnapshot,
  type ScopedConfigEditorSnapshot
} from '@slicer/client';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { Selection } from '../viewport/Selection';
import { glVolumeCollection } from '../viewport/GLVolume';
import { projectFullModelMesh } from '../viewport/modelMeshProjection';
import { type SceneInteractionController } from '../viewport/SceneInteractionController';
import { ScopedConfigurationPanel } from './ScopedConfigurationPanel';
import { printChoiceFlow } from './PrintEditorSelection';
import { editorDirtyChoiceIds } from './presetEditorBindings';
import {
  elementText,
  parsePrintElement,
  printHasLocalOverrides,
  projectPrintField,
  scopedPrintField,
  scopedDirtyChoiceIds,
  scopedHasLocalOverrides
} from './printEditorProjection';
import {
  CommittedEditorRefreshError,
  commitPrintConfigurationMutation,
  readConfigurationEditor,
  waitForConfigurationMutations,
  commitScopedEditorMutation
} from './configurationActions';

let root:Root|undefined;
let container:HTMLDivElement;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(async()=>{await act(async()=>root?.unmount());container?.remove();await waitForConfigurationMutations();vi.unstubAllGlobals();vi.restoreAllMocks();});
const context={selection:{mode:'object' as const,objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}};

async function click(id:string){await act(async()=>{(document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();});}
async function choose(label:string){
  const option=[...document.querySelectorAll<HTMLElement>('[data-testid="print-editor-selection"] button')].find(option=>option.getAttribute('aria-label')===label)!;
  await act(async()=>option.click());
}
const selectedChoice=()=>document.querySelector('[data-testid="print-editor-selection"] [aria-pressed="true"]')?.getAttribute('aria-label');
const profileDirty=()=>document.querySelector('[data-testid="config-process-profile"]')?.getAttribute('data-dirty');
const dirtyChoices=()=>[...document.querySelectorAll('[data-testid="print-editor-selection"] [data-dirty="true"]')].map(choice=>choice.getAttribute('aria-label'));
async function type(value:string,enter=true){
  const input=document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')!;
  await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  if(enter)await act(async()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
  return input;
}
async function setup(scopedFixture=false,presentationFixture=false){
  glVolumeCollection.clear();useObjectListStore.getState().setStructure([]);
  useProjectStore.getState().reset();useHistoryNavigationStore.getState().reset();useHistoryRestoreStore.setState({phase:'idle',revision:0});
  const module=createMockModule({metadataKeys:{
    layer_height:{type:'float',category:'Speed',scopes:['project','object','part']},
    print_sequence:{type:'enum',category:'Speed',scopes:['project','plate'],enum_values:['by layer','by object']},
    curr_bed_type:{type:'enum',category:'Speed',scopes:['project','plate'],enum_values:['High Temp Plate','Textured PEI Plate']},
    outer_wall_speed:{type:'floats',category:'Speed',scopes:['project','object','part'],min:0},
    enable_overhang_speed:{type:'bools',category:'Speed',scopes:['project','object','part']},
    small_perimeter_speed:{type:'floats_or_percents',category:'Speed',scopes:['project','object','part']},
    ...(presentationFixture ? {
      slowdown_for_curled_perimeters:{type:'bool',category:'Speed',scopes:['project','object','part']},
      wall_loops:{type:'int',category:'Strength',scopes:['project','object','part']},
    } as const : {}),
  }});
  const runtime=createClient(async()=>module);await runtime.init(MOCK_PROFILE_ACTIVATION);await runtime.resetHistory(context);
  let controller:SceneInteractionController|null=null;
  let objects: Awaited<ReturnType<typeof runtime.getModelStructure>>['objects']=[];
  let selectionIndices=[0];let selectedParts:number[]|null=null;let selectionKind='object';
  if(scopedFixture){
    await runtime.addShape('Cube','Scoped object');
    await runtime.addShape('Cube','Second object');
    let structure=await runtime.getModelStructure();const object=structure.objects[0];
    await runtime.addVolume({objectId:object.id,instanceId:object.instances[0].id,volumeType:'parameter_modifier',shape:'Cube'});
    await runtime.addVolume({objectId:object.id,instanceId:object.instances[0].id,volumeType:'parameter_modifier',shape:'Cube'});
    structure=await runtime.getModelStructure(); objects=structure.objects;
    await runtime.resetHistory(context);
    useObjectListStore.getState().setStructure(structure.objects);
    glVolumeCollection.replace(projectFullModelMesh(await runtime.getModelMesh()));
    controller={selection:new Selection(),computeSelectionKind:()=>selectionKind,selectedVolumes:()=>selectedParts ? selectedParts.map(index=>({buffer:{objectId:objects[0].id,volumeId:objects[0].volumes[index].id}})) : selectionIndices.map(index=>({buffer:{objectId:objects[index].id,volumeId:objects[index].volumes[0].id}}))} as unknown as SceneInteractionController;
  }
  const profile=await runtime.getProfileSnapshot();if(!profile.ok)throw Error(profile.error);
  useSettingsStore.getState().hydrateProfileSnapshot(profile);
  const scoped=await runtime.getNativeScopedConfig();if(!scoped.ok)throw Error(scoped.error);
  useSettingsStore.getState().applyNativeScopedConfigTransport(scoped.nativeScopedConfig);
  useSettingsStore.getState().setMetadata(await runtime.getOptionMetadata());
  let project:((snapshot:ConfigEditorSnapshot)=>ConfigEditorSnapshot)|undefined;
  const nativeRead=runtime.getPrintConfigEditor.bind(runtime);
  const read=vi.spyOn(runtime,'getPrintConfigEditor').mockImplementation(async()=>{
    const result=await nativeRead();if(!result.ok)return result;
    const choices=[{...result.editorSelection.choices[0],id:'ordinal-0',extruderIndex:0,variant:'Direct Drive Standard',label:'T1 SF'},
      {...result.editorSelection.choices[1],id:'ordinal-1',extruderIndex:0,variant:'Direct Drive High Flow',flowType:1,label:'T1 HF'},
      {...result.editorSelection.choices[2],id:'ordinal-2',extruderIndex:1,variant:'Direct Drive Standard',label:'T2 SF'}];
    const snapshot={...result,editorSelection:{...result.editorSelection,choices,firstChoiceId:choices[0].id}};
    return project?project(snapshot):snapshot;
  });
  let scopedProject:((snapshot:ScopedConfigEditorSnapshot)=>ScopedConfigEditorSnapshot)|undefined;
  const nativeScopedRead=runtime.getScopedConfigEditor.bind(runtime);
  const scopedRead=vi.spyOn(runtime,'getScopedConfigEditor').mockImplementation(async request=>{
    const result=await nativeScopedRead(request);if(!result.ok)return result;
    const mapping=await read();if(!mapping.ok)throw Error(mapping.error);
    const snapshot={...result,editorSelection:{...result.editorSelection,choices:mapping.editorSelection.choices,firstChoiceId:mapping.editorSelection.firstChoiceId}};
    return scopedProject?scopedProject(snapshot):snapshot;
  });
  const nativeMutate=runtime.mutateNativeScopedConfig.bind(runtime);
  const mutate=vi.spyOn(runtime,'mutateNativeScopedConfig');
  const platform={runtime,preferences:{load:async()=>structuredClone(DEFAULT_USER_PREFERENCES),save:async()=>{}}} as unknown as PlatformCapabilities;
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(<PlatformProvider value={platform}><TooltipProvider><ScopedConfigurationPanel sceneInteraction={controller} /></TooltipProvider></PlatformProvider>));
  return {runtime,platform,read,scopedRead,nativeScopedRead,nativeMutate,objects,
    select:async(indices:number[],kind='object')=>act(async()=>{selectionIndices=indices;selectedParts=null;selectionKind=kind;controller!.selection.replaceIds(indices.map(index=>String(objects[index].id)));}),
    selectParts:async(indices:number[])=>act(async()=>{selectedParts=indices;selectionKind='part';controller!.selection.replaceIds(indices.map(index=>String(objects[0].volumes[index].id)));}),
    scoped:(next:typeof scopedProject)=>{scopedProject=next;},mutate,project:(next:typeof project)=>{project=next;},refresh:async()=>act(async()=>{useHistoryRestoreStore.getState().advanceRevision();})};
}

it('uses loaded Hybrid choices, one captured typed mutation/history operation, mapped ownership, reset and scoped boundaries',async()=>{
  const h=await setup();
  expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  expect(document.querySelector('[data-testid="config-nozzle-gutter-layer_height"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="config-nozzle-icon-layer_height"]')).toBeNull();
  await click('config-page-Speed');
  expect(document.querySelector('[data-testid="config-nozzle-icon-outer_wall_speed"]')).not.toBeNull();
  const reads=h.read.mock.calls.length;
  await choose('T1 HF');
  expect(h.read).toHaveBeenCalledTimes(reads);expect(h.mutate).not.toHaveBeenCalled();
  const input=()=>document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')!;
  expect(input().value).toBe('220');
  expect(document.querySelector('[data-testid="config-field-outer_wall_speed"]')?.getAttribute('data-native-index')).toBe('1');
  const before=await h.runtime.getHistoryStatus();
  await type('225');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set-element',key:'outer_wall_speed',index:1,scalarType:'float',value:225,targets:[{scope:'project'}],expectedRevision:expect.any(Number)}));
  expect((await h.runtime.getHistoryStatus()).undoEntries).toHaveLength(before.undoEntries.length+1);
  await type('220'); // Source-equivalent ownership remains explicit.
  expect(document.querySelector('[data-testid="config-option-label-outer_wall_speed"]')?.getAttribute('data-local-override-highlight')).toBe('true');
  await choose('T2 SF');expect(input().value).toBe('240');
  expect(document.querySelector('[data-testid="config-option-label-outer_wall_speed"]')?.getAttribute('data-local-override-highlight')).toBe('false');
  await choose('T1 HF');await click('config-reset-outer_wall_speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:[{key:'outer_wall_speed',kind:'indexed',index:1}]}));
  await type('228');
  const history=await h.runtime.getHistoryStatus();
  await act(async()=>{(document.querySelector('[data-testid="config-category-toggle-Other layers speed"]') as HTMLElement).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  expect(document.querySelector('[data-testid="config-reset-category-Other layers speed"]')?.textContent).toBe('Reset Other layers speed');
  await click('config-reset-category-Other layers speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:expect.arrayContaining([
    {key:'outer_wall_speed',kind:'indexed',index:1},
  ])}));
  const sectionReset = h.mutate.mock.calls.at(-1)![0];
  if(sectionReset.operation==='reset-fields') {
    expect(sectionReset.fields.some(field=>field.key==='layer_height')).toBe(false);
    expect(sectionReset.fields.some(field=>field.key==='enable_overhang_speed')).toBe(false);
  }
  expect((await h.runtime.getHistoryStatus()).undoEntries).toHaveLength(history.undoEntries.length+1);
  await act(async()=>{const restored=await h.runtime.undoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});
  expect(input().value).toBe('228');expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>{const restored=await h.runtime.redoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});expect(input().value).toBe('220');
  await click('config-mode-scoped');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  await click('config-mode-plates');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  await click('config-mode-project');expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>useSettingsStore.getState().enterPrintPreset());
  expect(selectedChoice()).toBe('T1 SF');
});

it('aggregates explicit Process ownership across nozzles while field/category resets and history stay selected',async()=>{
  const h=await setup();await click('config-page-Speed');
  expect(profileDirty()).toBe('false');expect(dirtyChoices()).toEqual([]);
  await choose('T1 HF');await type('225');await type('220'); // Explicit Source-equivalent ownership is dirty.
  expect(dirtyChoices()).toEqual(['T1 HF']);expect(profileDirty()).toBe('true');
  const history=await h.runtime.getHistoryStatus();const writes=h.mutate.mock.calls.length;const reads=h.read.mock.calls.length;
  await choose('T2 SF');
  expect(h.mutate).toHaveBeenCalledTimes(writes);expect(h.read).toHaveBeenCalledTimes(reads);
  expect(await h.runtime.getHistoryStatus()).toEqual(history);
  expect(profileDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T1 HF']);
  expect((document.querySelector('[data-testid="config-reset-all"]') as HTMLButtonElement).disabled).toBe(false);
  expect(document.querySelector('[data-testid="config-option-label-outer_wall_speed"]')?.getAttribute('data-local-override-highlight')).toBe('false');
  await type('245');expect(dirtyChoices()).toEqual(['T1 HF','T2 SF']);
  await click('config-reset-outer_wall_speed');expect(dirtyChoices()).toEqual(['T1 HF']);expect(profileDirty()).toBe('true');
  await type('246');
  await act(async()=>document.querySelector('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10})));
  await click('config-reset-category-Other layers speed');
  expect(dirtyChoices()).toEqual(['T1 HF']);expect(profileDirty()).toBe('true');
  await choose('T1 HF');await click('config-reset-outer_wall_speed');
  expect(dirtyChoices()).toEqual([]);expect(profileDirty()).toBe('false');
  expect((document.querySelector('[data-testid="config-reset-all"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{const restored=await h.runtime.undoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});
  expect(profileDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T1 HF']);expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>{const restored=await h.runtime.redoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});
  expect(profileDirty()).toBe('false');expect(dirtyChoices()).toEqual([]);
});

it('keeps active-page nozzle markers and whole-profile ownership independent of search and other pages/shared fields',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');await type('225');
  h.project(snapshot=>({...snapshot,sourceValues:{...snapshot.sourceValues,line_width:'0.4,0.4,0.4'},effectiveValues:{...snapshot.effectiveValues,line_width:'0.4,0.4,0.4'},
    editorSelection:{...snapshot.editorSelection,fieldBindings:{...snapshot.editorSelection.fieldBindings,line_width:snapshot.editorSelection.fieldBindings.outer_wall_speed}},
    editorVectors:{...snapshot.editorVectors,line_width:{...snapshot.editorVectors.outer_wall_speed,sourceValues:[0.4,0.4,0.4],effectiveValues:[0.4,0.4,0.4],overrideValues:[null,null,null]}}}));
  await act(async()=>useSettingsStore.getState().setMetadata({...useSettingsStore.getState().metadata,line_width:{type:'floats',category:'Quality',scopes:['project']}}));
  await h.refresh();await click('config-page-Quality');
  expect(document.querySelector('[data-testid="print-editor-selection"]')).not.toBeNull();
  expect(dirtyChoices()).toEqual([]);expect(profileDirty()).toBe('true');
  await click('config-page-Speed');expect(dirtyChoices()).toEqual(['T1 HF']);
  const searchToggle=document.querySelector<HTMLButtonElement>('[aria-label="Search settings"]')!;
  await act(async()=>searchToggle.click());
  const search=document.querySelector<HTMLInputElement>('[data-testid="scoped-config-search"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Overhang');search.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(document.querySelector('[data-testid="config-field-outer_wall_speed"]')).toBeNull();
  expect(dirtyChoices()).toEqual(['T1 HF']);expect(profileDirty()).toBe('true');
  await act(async()=>searchToggle.click());await click('config-reset-all');
  expect(profileDirty()).toBe('false');expect(dirtyChoices()).toEqual([]);
  await act(async()=>{await commitPrintConfigurationMutation(h.platform,{version:1,operation:'set',targets:[{scope:'project'}],key:'layer_height',value:'0.17'});});
  expect(profileDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);
  await choose('T2 SF');expect(profileDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);
  await click('config-reset-all');expect(profileDirty()).toBe('false');
});

it('allows whole-profile Reset All when its only dirty element is unavailable in the current mapping',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');await type('227');
  h.project(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,fieldBindings:{...snapshot.editorSelection.fieldBindings,
    outer_wall_speed:{kind:'per_selection',bindings:[{kind:'indexed',index:0},{kind:'unavailable'},{kind:'indexed',index:2}]}}}}));
  await h.refresh();expect(document.querySelector('[data-testid="config-input-outer_wall_speed"]')?.textContent).toBe('Unavailable');
  expect(profileDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);
  expect((document.querySelector('[data-testid="config-reset-all"]') as HTMLButtonElement).disabled).toBe(false);
  await click('config-reset-all');expect(h.mutate).toHaveBeenLastCalledWith({version:1,operation:'reset-all',targets:[{scope:'project'}]});
  expect(profileDirty()).toBe('false');
  const snapshot=await h.runtime.getPrintConfigEditor();if(!snapshot.ok)throw Error(snapshot.error);
  expect(snapshot.editorVectors.outer_wall_speed.overrideValues).toEqual([null,null,null]);
});

it('uses native ownership and resolved indices without short-vector fallback or external project-domain dirtiness',async()=>{
  const h=await setup();const source=await h.runtime.getPrintConfigEditor();if(!source.ok)throw Error(source.error);
  const vector=source.editorVectors.outer_wall_speed;
  const snapshot={...source,editorSelection:{...source.editorSelection,fieldBindings:{...source.editorSelection.fieldBindings,
    outer_wall_speed:{kind:'per_selection' as const,bindings:[{kind:'indexed' as const,index:2},{kind:'unavailable' as const},{kind:'indexed' as const,index:1}]}}},
    editorVectors:{...source.editorVectors,outer_wall_speed:{...vector,effectiveValues:[200],sourceValues:[200],overrideValues:[{value:null},null,{value:240}]}}};
  expect([...editorDirtyChoiceIds(snapshot,['outer_wall_speed'])]).toEqual(['ordinal-0']); // Native index 2; null/value-equal owners both remain explicit.
  expect([...editorDirtyChoiceIds({...snapshot,editorVectors:{...snapshot.editorVectors,outer_wall_speed:{...snapshot.editorVectors.outer_wall_speed,overrideValues:[{value:null}]}}},['outer_wall_speed'])]).toEqual([]);
  expect(printHasLocalOverrides(snapshot,{})).toBe(true); // Even ownership with no available choice is globally dirty.
  const nilOwner={...source,editorVectors:{...source.editorVectors,outer_wall_speed:{...vector,overrideValues:[{value:null},null,null]}}};
  expect([...editorDirtyChoiceIds(nilOwner,['outer_wall_speed'])]).toEqual(['ordinal-0']);
  expect(printHasLocalOverrides(source,{curr_bed_type:'Textured PEI Plate',nozzle_volume_type:'Hybrid'})).toBe(false);
  const hidden={...source,sourceValues:{...source.sourceValues,unexposed_print_option:'baseline'},effectiveValues:{...source.effectiveValues,unexposed_print_option:'local'}};
  expect(printHasLocalOverrides(hidden,{unexposed_print_option:'local'})).toBe(true);
  expect([...editorDirtyChoiceIds(hidden,['unexposed_print_option'])]).toEqual([]);
});

it.each([true,false])('navigates invalid/pending Print fields immediately and confines late receipts (success=%s)',async success=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  await type('invalid');expect(h.mutate).not.toHaveBeenCalled();
  await choose('T2 SF');expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();
  await choose('T1 HF');
  // Capture the original method before replacing the spy implementation.
  const native=h.nativeMutate;
  let finish!:()=>void;
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  h.mutate.mockImplementationOnce(async request=>{await gate;if(!success)return {ok:false,version:1,error:'Rejected old element'};return native(request);});
  const input=await type('229',false);await act(async()=>input.blur());
  await choose('T2 SF');expect(document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')?.value).toBe('240');
  await act(async()=>finish());
  expect(selectedChoice()).toBe('T2 SF');
  expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();
  await choose('T1 HF');expect(document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')?.value).toBe(success?'229':'220');
});

it('reconciles semantic identity on ordinal reorder, missing mappings and bounded short vectors',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  h.project(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,
    choices:[snapshot.editorSelection.choices[1],snapshot.editorSelection.choices[0],snapshot.editorSelection.choices[2]].map((choice,index)=>({...choice,id:`ordinal-${index}`})),
    fieldBindings:{...snapshot.editorSelection.fieldBindings,outer_wall_speed:{kind:'per_selection',bindings:[{kind:'indexed',index:1},{kind:'indexed',index:0},{kind:'unavailable'}]}}},
    editorVectors:{...snapshot.editorVectors,outer_wall_speed:{...snapshot.editorVectors.outer_wall_speed,effectiveValues:[200],sourceValues:[200]}}}));
  await h.refresh();expect(selectedChoice()).toBe('T1 HF');
  expect(document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')?.value).toBe('200');
  await choose('T2 SF');expect(document.querySelector('[data-testid="config-input-outer_wall_speed"]')?.textContent).toBe('Unavailable');
  expect(document.querySelector('[data-testid="config-nozzle-icon-outer_wall_speed"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="config-reset-outer_wall_speed"]')).toBeNull();
  await act(async()=>{await commitPrintConfigurationMutation(h.platform,{version:1,operation:'set',targets:[{scope:'project'}],key:'layer_height',value:'0.17'});});
  await click('config-page-Quality');
  await act(async()=>{document.querySelector('[data-testid="config-category-toggle-Layer height"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  await click('config-reset-category-Layer height');
  const reset=h.mutate.mock.calls.at(-1)![0];
  expect(reset.operation).toBe('reset-fields');
  if(reset.operation==='reset-fields')expect(reset.fields.some(field=>field.key==='outer_wall_speed')).toBe(false);
});

it('renders actual effective nozzle diameters and native flow labels without changing bindings or allowing deselection',async()=>{
  const h=await setup();
  await act(async()=>useSettingsStore.getState().setValues({nozzle_diameter:'0.4, 0.6'}));
  await click('config-page-Speed');
  const options=()=>[...document.querySelectorAll<HTMLElement>('[data-testid="print-editor-selection"] button')];
  expect(options().map(option=>option.textContent)).toEqual(['10.4 SF','10.4 HF','20.6 SF']);
  await choose('T1 HF');await choose('T1 HF');expect(selectedChoice()).toBe('T1 HF');
  expect(h.mutate).not.toHaveBeenCalled();
  await act(async()=>useSettingsStore.getState().setValues({nozzle_diameter:'0.8'}));
  expect(options()[2].textContent).toBe('20.8 SF'); // bounded display fallback, no native remapping
  await click('config-mode-scoped');
  expect(document.querySelector('[data-testid^="config-nozzle-icon-"]')).toBeNull();
  expect(document.querySelector('[data-testid^="config-nozzle-gutter-"]')).toBeNull();
});

it.each([[0,'SF'],[1,'HF'],[2,'Hybrid'],[3,'TPU HF'],[5,'E3D HF'],[6,'XHF'],[4,'Unknown native variant']] as const)
  ('formats native flow %s as %s',async(flowType,label)=>{
    const h=await setup();const snapshot=await readConfigurationEditor(()=>h.platform.runtime.getPrintConfigEditor());if(!snapshot.ok)throw Error(snapshot.error);
    expect(printChoiceFlow({...snapshot.editorSelection.choices[0],flowType,variant:'Unknown native variant'})).toBe(label);
  });

it('keeps a many-choice strip in one row with keyboard focus and selected visibility on resize',async()=>{
  let resized:()=>void=()=>{};
  vi.stubGlobal('ResizeObserver',class {
    constructor(private callback:()=>void){}
    observe(target:Element){if(target.getAttribute('data-testid')==='print-editor-selection-scroll')resized=this.callback;}
    disconnect(){}
  });
  const h=await setup();
  h.project(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,choices:Array.from({length:12},(_,index)=>({
    ...snapshot.editorSelection.choices[0],id:`many-${index}`,extruderIndex:index,label:`Nozzle ${index+1}`,variant:`Variant ${index}`,
  })),firstChoiceId:'many-0',fieldBindings:Object.fromEntries(Object.entries(snapshot.editorSelection.fieldBindings).map(([key,binding])=>[key,
    binding.kind==='shared'?binding:{...binding,bindings:Array.from({length:12},(_,index)=>binding.bindings[index]??{kind:'unavailable' as const})}]))}}));
  await h.refresh();await click('config-page-Speed');
  const scroller=document.querySelector<HTMLElement>('[data-testid="print-editor-selection-scroll"]')!;
  const buttons=[...scroller.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons).toHaveLength(12);
  vi.spyOn(scroller,'getBoundingClientRect').mockReturnValue({left:0,right:120} as DOMRect);
  vi.spyOn(buttons[11],'getBoundingClientRect').mockReturnValue({left:180,right:240} as DOMRect);
  await choose('Nozzle 12');expect(selectedChoice()).toBe('Nozzle 12');expect(scroller.scrollLeft).toBe(120);
  scroller.scrollLeft=0;await act(async()=>resized());expect(scroller.scrollLeft).toBe(120);
  vi.spyOn(buttons[0],'getBoundingClientRect').mockReturnValue({left:-60,right:0} as DOMRect);
  await act(async()=>buttons[0].focus());expect(scroller.scrollLeft).toBe(60);
  await act(async()=>buttons[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
  expect(document.activeElement).toBe(buttons[1]);expect(h.mutate).not.toHaveBeenCalled();
});

it.each([
  ['float','1.25',1.25],['int','4',4],['percent','95%',95],
  ['float_or_percent','52%',{value:52,percent:true}],['float_or_percent','0.3',{value:0.3,percent:false}],
  ['bool','1',true],['enum','top',2],['string','a\nb','a\nb'],
  ['point','1, 2',{x:1,y:2}],['points','1, 2\n3, 4',[{x:1,y:2},{x:3,y:4}]],
] as const)('round-trips native %s element input without changing its index or type',async(scalarType,text,value)=>{
  const h=await setup();const snapshot=await readConfigurationEditor(()=>h.platform.runtime.getPrintConfigEditor());if(!snapshot.ok)throw Error(snapshot.error);
  const vector={...snapshot.editorVectors.outer_wall_speed,scalarType,enumOptions:[{name:'top',label:'Top',value:2}]};
  const element={target:{kind:'indexed' as const,index:2},vector,source:value,effective:value,revision:snapshot.revision};
  expect(parsePrintElement(element,text)).toEqual(value);
  expect(parsePrintElement({...element,vector:{...vector,nullable:true}},text)).toEqual(value);
  if(['float','int','percent','float_or_percent'].includes(scalarType))expect(()=>parsePrintElement({...element,vector:{...vector,nullable:true}},'')).toThrow(/valid number/);
  expect(()=>parsePrintElement({...element,target:{kind:'unavailable'}},text)).toThrow(/mapping/);
  if(['float','int','percent','float_or_percent','point'].includes(scalarType))expect(()=>parsePrintElement(element,'invalid')).toThrow();
});

it('holds a read behind mutation publication',async()=>{
  const h=await setup();const source=await h.runtime.getPrintConfigEditor();if(!source.ok)throw Error(source.error);
  const nativeRead=h.read.getMockImplementation()!;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  h.read.mockImplementationOnce(async()=>{await gate;return nativeRead();});
  const commit=commitPrintConfigurationMutation(h.platform,{version:1,operation:'set-element',targets:[{scope:'project'}],
    expectedRevision:source.revision,key:'outer_wall_speed',index:2,scalarType:'float',value:233});
  let readDone=false;const read=readConfigurationEditor(()=>h.platform.runtime.getPrintConfigEditor()).then(result=>{readDone=true;return result;});
  await act(async()=>{await Promise.resolve();});expect(readDone).toBe(false);
  await act(async()=>release());await commit;expect(await read).toMatchObject({editorVectors:{outer_wall_speed:{effectiveValues:[200,220,233]}}});
});

it('ignores a completed stale read after explicit Print preset entry',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  const nativeRead=h.read.getMockImplementation()!;
  let finish!:(value:Awaited<ReturnType<typeof h.runtime.getPrintConfigEditor>>)=>void;
  h.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  await h.refresh();
  await act(async()=>useSettingsStore.getState().enterPrintPreset());
  const stale=await nativeRead();if(!stale.ok)throw Error(stale.error);
  const vector=stale.editorVectors.outer_wall_speed;
  await act(async()=>finish({...stale,editorVectors:{...stale.editorVectors,outer_wall_speed:{...vector,effectiveValues:[999,999,999]}}}));
  expect(document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')?.value).toBe('200');
  expect(selectedChoice()).toBe('T1 SF');
});

it('discards field-local errors when a removed variant ordinal is reused for another semantic choice',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  await type('invalid');expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).not.toBeNull();
  h.project(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,firstChoiceId:'ordinal-1',
    choices:[{...snapshot.editorSelection.choices[1],variant:'Replacement variant',label:'Replacement variant'}],
    fieldBindings:Object.fromEntries(Object.entries(snapshot.editorSelection.fieldBindings).map(([key,binding])=>[key,
      binding.kind==='shared'?binding:{...binding,bindings:[binding.bindings[1]]}]))}}));
  await h.refresh();
  expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')?.value).toBe('220');
});

it('edits Object native elements independently from the Project element',async()=>{
  const h=await setup(true);await click('config-page-Speed');await choose('T1 HF');await type('230');
  const project=await h.runtime.getPrintConfigEditor();
  await click('config-mode-scoped');await click('config-page-Speed');
  const field=document.querySelector('[data-testid="config-field-outer_wall_speed"]')!;
  expect(field.getAttribute('data-native-index')).toBe('0');
  await type('205');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set-element',targets:[{scope:'object',id:expect.any(String)}],key:'outer_wall_speed',index:0,value:205}));
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:(project as ConfigEditorSnapshot).editorVectors});
});

const targetDirty=()=>document.querySelector('[data-testid="scoped-target-label"]')?.getAttribute('data-dirty');
const speedInput=()=>document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]');
async function scopedEdit(h:Awaited<ReturnType<typeof setup>>,indices:number[],index:number,value:number|null,scope:'object'|'part'='object'){
  const targets=indices.map(i=>({scope,id:String(scope==='object'?h.objects[i].id:h.objects[i].volumes[0].id)}));
  await act(async()=>{
    const read=await h.nativeScopedRead({version:1,targets});if(!read.ok)throw Error(read.error);
    await commitScopedEditorMutation(h.platform,{version:1,operation:'set-element',targets,expectedRevision:read.revision,
      key:'outer_wall_speed',index,scalarType:'float',value},targets);
  });
}

it('unions selected owners only, preserves global dirty across nozzles/search/pages, and atomically resets current elements',async()=>{
  const h=await setup(true);
  await act(async()=>{const read=await h.runtime.getPrintConfigEditor();if(!read.ok)throw Error(read.error);
    await commitPrintConfigurationMutation(h.platform,{version:1,operation:'set-element',targets:[{scope:'project'}],expectedRevision:read.revision,key:'outer_wall_speed',index:1,scalarType:'float',value:220});});
  await click('config-mode-scoped');await click('config-page-Speed');await choose('T1 HF');
  expect(targetDirty()).toBe('false');expect(dirtyChoices()).toEqual([]);
  await type('220',false); // unchanged value needs an explicit ownership operation
  await scopedEdit(h,[0],1,220);await scopedEdit(h,[1],2,260);
  await h.select([0,1]);expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T1 HF','T2 SF']);
  await choose('T2 SF');expect(speedInput()?.placeholder).toBe('Mixed');expect(speedInput()?.value).toBe('');
  expect(document.querySelector('[data-testid="config-nozzle-icon-outer_wall_speed"]')).not.toBeNull();
  await choose('T1 SF');expect(speedInput()?.value).toBe('200');expect(targetDirty()).toBe('true');
  const reads=h.scopedRead.mock.calls.length,history=await h.runtime.getHistoryStatus();await choose('T1 HF');
  expect(h.scopedRead).toHaveBeenCalledTimes(reads);expect(await h.runtime.getHistoryStatus()).toEqual(history);
  await click('config-page-Quality');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();expect(targetDirty()).toBe('true');
  await click('config-page-Speed');expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Search settings"]')!.click());
  await act(async()=>{const search=document.querySelector<HTMLInputElement>('[data-testid="scoped-config-search"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'Overhang');search.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(speedInput()).toBeNull();expect(dirtyChoices()).toEqual(['T1 HF','T2 SF']);
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Search settings"]')!.click());
  await act(async()=>document.querySelector<HTMLElement>('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10})));
  await click('config-reset-category-Other layers speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',targets:h.objects.map(o=>({scope:'object',id:String(o.id)})),
    fields:expect.arrayContaining([{key:'outer_wall_speed',kind:'indexed',index:1}])}));
  expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T2 SF']);
  await choose('T2 SF');await click('config-reset-outer_wall_speed');expect(targetDirty()).toBe('false');
  await act(async()=>{const restored=await h.runtime.undoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});
  expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T2 SF']);expect(selectedChoice()).toBe('T2 SF');
  await act(async()=>{const restored=await h.runtime.redoHistory();if(restored.ok)useSettingsStore.getState().applyNativeScopedConfigTransport(restored.nativeScopedConfig);useHistoryRestoreStore.getState().advanceRevision();});expect(targetDirty()).toBe('false');
  await scopedEdit(h,[0],0,205);await scopedEdit(h,[1],2,265);await h.select([0]);await click('config-reset-all');
  expect(targetDirty()).toBe('false');await h.select([1]);expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual(['T2 SF']);
});

it('uses per-element Part provenance and separates mixed values from mixed inherited sources',async()=>{
  const h=await setup(true);await scopedEdit(h,[0],0,200);
  await click('config-mode-scoped');await h.select([0],'part');await click('config-page-Speed');
  const target={scope:'part' as const,id:String(h.objects[0].volumes[0].id)};
  const read=await h.runtime.getScopedConfigEditor({version:1,targets:[target]});if(!read.ok)throw Error(read.error);
  const field={key:'outer_wall_speed',label:'Outer wall',category:'Speed',meta:{type:'floats' as const},value:null,mixed:false,source:'preset' as const,local:false,resettable:true};
  expect(scopedPrintField(field,read,'ordinal-0')).toMatchObject({source:'object',local:false,editor:{inheritedSource:'object',source:200}});
  expect(scopedPrintField(field,read,'ordinal-1')).toMatchObject({source:'preset',local:false,editor:{inheritedSource:'preset',source:220}});
  expect(targetDirty()).toBe('false');await choose('T1 HF');await type('225');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({targets:[target],operation:'set-element',index:1}));
  expect(targetDirty()).toBe('true');await click('config-reset-outer_wall_speed');expect(targetDirty()).toBe('false');
  await h.selectParts([0,1]);await type('226');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({targets:h.objects[0].volumes.slice(0,2).map(volume=>({scope:'part',id:String(volume.id)})),index:1,value:226}));
  await click('config-reset-all');expect(targetDirty()).toBe('false');
  const parent=await h.nativeScopedRead({version:1,targets:[{scope:'object',id:String(h.objects[0].id)}]});
  expect(parent).toMatchObject({targets:[{editorVectors:{outer_wall_speed:{overrideValues:[{value:200},null,null]}}}]});
  const inherited=read.targets[0];
  const sameValuesDifferentSources={...read,targets:[inherited,{...inherited,target:{scope:'part' as const,id:'another'},sourceScopes:{...inherited.sourceScopes,indexed:{...inherited.sourceScopes.indexed,outer_wall_speed:['preset','preset','preset'] as const}}}]};
  expect(scopedPrintField(field,sameValuesDifferentSources,'ordinal-0')).toMatchObject({value:'200',mixed:false,source:'mixed',editor:{sourceMixed:false,inheritedSource:'mixed'}});
  const mixedValues={...sameValuesDifferentSources,targets:[inherited,{...inherited,editorVectors:{...inherited.editorVectors,outer_wall_speed:{...inherited.editorVectors.outer_wall_speed,effectiveValues:[201,220,240]}}}]};
  expect(scopedPrintField(field,mixedValues,'ordinal-0')).toMatchObject({value:null,mixed:true,source:'object'});
});

it('keeps whole-target ownership with unavailable/short native mappings and excludes them from category reset',async()=>{
  const h=await setup(true);await scopedEdit(h,[0],1,225);
  h.scoped(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,fieldBindings:{...snapshot.editorSelection.fieldBindings,
    outer_wall_speed:{kind:'per_selection',bindings:[{kind:'indexed',index:0},{kind:'unavailable'},{kind:'indexed',index:2}]}}},
    targets:snapshot.targets.map(target=>({...target,editorVectors:{...target.editorVectors,outer_wall_speed:{...target.editorVectors.outer_wall_speed,
      sourceValues:[200],effectiveValues:[200]}}}))}));
  await click('config-mode-scoped');await click('config-page-Speed');await choose('T1 HF');
  expect(speedInput()?.textContent).toBe('Unavailable');expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);
  expect(document.querySelector('[data-testid="config-nozzle-icon-outer_wall_speed"]')).not.toBeNull();
  await choose('T2 SF');expect(speedInput()?.value).toBe('200');expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);
  await choose('T1 HF');
  await act(async()=>{const targets=[{scope:'object' as const,id:String(h.objects[0].id)}];await commitScopedEditorMutation(h.platform,{version:1,operation:'set',targets,key:'layer_height',value:'0.17'},targets);});
  await click('config-page-Quality');
  await act(async()=>document.querySelector<HTMLElement>('[data-testid="config-category-toggle-Layer height"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10})));
  await click('config-reset-category-Layer height');
  const category=h.mutate.mock.calls.at(-1)![0];expect(category.operation).toBe('reset-fields');
  if(category.operation==='reset-fields')expect(category.fields.some(field=>field.key==='outer_wall_speed')).toBe(false);
  expect(targetDirty()).toBe('true');
  await click('config-reset-all');expect(targetDirty()).toBe('false');
  expect(h.mutate).toHaveBeenLastCalledWith({version:1,operation:'reset-all',targets:[{scope:'object',id:String(h.objects[0].id)}]});
});

it('keeps native shared ownership out of nozzle markers and all-nil legacy vectors out of whole-target dirtiness',async()=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');
  await act(async()=>{const targets=[{scope:'object' as const,id:String(h.objects[0].id)}];await commitScopedEditorMutation(h.platform,
    {version:1,operation:'set',targets,key:'layer_height',value:'0.17'},targets);});
  expect(targetDirty()).toBe('true');expect(dirtyChoices()).toEqual([]);expect(document.querySelector('[data-testid="config-nozzle-icon-layer_height"]')).toBeNull();
  await click('config-reset-all');await act(async()=>{const targets=[{scope:'object' as const,id:String(h.objects[0].id)}];await commitScopedEditorMutation(h.platform,
    {version:1,operation:'set',targets,key:'outer_wall_speed',value:'[null,null,null]'},targets);});
  expect(targetDirty()).toBe('false');expect(dirtyChoices()).toEqual([]);
});

it('edits a mixed native boolean through its actual value checkbox without nullable controls',async()=>{
  vi.stubGlobal('PointerEvent',MouseEvent);
  const h=await setup(true);const target={scope:'object' as const,id:String(h.objects[1].id)};
  await act(async()=>{const read=await h.nativeScopedRead({version:1,targets:[target]});if(!read.ok)throw Error(read.error);
    await commitScopedEditorMutation(h.platform,{version:1,operation:'set-element',targets:[target],expectedRevision:read.revision,
      key:'enable_overhang_speed',scalarType:'bool',index:0,value:false},[target]);});
  await click('config-mode-scoped');await h.select([0,1]);await click('config-page-Speed');
  const checkbox=document.querySelector<HTMLElement>('[data-testid="config-input-enable_overhang_speed"]')!;
  expect(checkbox.getAttribute('aria-checked')).toBe('mixed');
  await act(async()=>checkbox.click());
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set-element',targets:h.objects.map(o=>({scope:'object',id:String(o.id)})),key:'enable_overhang_speed',value:true,index:0}));
  expect(document.querySelector('[data-testid^="config-null-"]')).toBeNull();
});

it('retains semantic selection through target loading, mode changes and reordered ordinals without old-target fields',async()=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');await choose('T2 SF');
  const original=h.scopedRead.getMockImplementation()!;let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  h.scopedRead.mockImplementationOnce(async request=>{const result=await original(request);await held;return result;});
  await h.select([1]);expect(speedInput()).toBeNull();expect(selectedChoice()).toBe('T2 SF');
  await choose('T1 HF');expect(selectedChoice()).toBe('T1 HF');await h.select([0]);
  await act(async()=>release());expect(speedInput()?.value).toBe('220');expect(selectedChoice()).toBe('T1 HF');
  await click('config-mode-project');await click('config-mode-scoped');expect(selectedChoice()).toBe('T1 HF');
  h.scoped(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,choices:[...snapshot.editorSelection.choices].reverse().map((choice,i)=>({...choice,id:`new-${i}`})),firstChoiceId:'new-0',
    fieldBindings:Object.fromEntries(Object.entries(snapshot.editorSelection.fieldBindings).map(([key,binding])=>[key,binding.kind==='shared'?binding:{...binding,bindings:[...binding.bindings].reverse()}]))}}));
  await h.refresh();expect(selectedChoice()).toBe('T1 HF');expect(speedInput()?.value).toBe('220');
  await h.select([],'empty');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();expect(document.querySelector('[data-testid="scoped-invalid-selection"]')).not.toBeNull();
  await h.select([0]);expect(selectedChoice()).toBe('T1 HF');
});

it.each(['project-change','new-entry'] as const)('disables reused target fields until a fresh read after %s while hidden',async change=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');await choose('T2 SF');
  await click('config-mode-project');const scopedReads=h.scopedRead.mock.calls.length;
  if(change==='project-change')await act(async()=>{const read=await h.runtime.getPrintConfigEditor();if(!read.ok)throw Error(read.error);
    await commitPrintConfigurationMutation(h.platform,{version:1,operation:'set-element',targets:[{scope:'project'}],expectedRevision:read.revision,key:'outer_wall_speed',index:2,scalarType:'float',value:245});});
  else {await act(async()=>useSettingsStore.getState().enterPrintPreset());h.scoped(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,firstChoiceId:'ordinal-2',choices:[snapshot.editorSelection.choices[2],...snapshot.editorSelection.choices.slice(0,2)],fieldBindings:Object.fromEntries(Object.entries(snapshot.editorSelection.fieldBindings).map(([key,binding])=>[key,binding.kind==='shared'?binding:{...binding,bindings:[binding.bindings[2],...binding.bindings.slice(0,2)]}]))}}));}
  expect(h.scopedRead).toHaveBeenCalledTimes(scopedReads);
  const original=h.scopedRead.getMockImplementation()!;let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  h.scopedRead.mockImplementationOnce(async request=>{const result=await original(request);await held;return result;});
  await click('config-mode-scoped');
  if(change==='project-change')expect(speedInput()?.matches(':disabled')).toBe(true);else expect(speedInput()).toBeNull();
  expect(selectedChoice()).toBe(change==='project-change'?'T2 SF':undefined);
  await act(async()=>release());expect(selectedChoice()).toBe('T2 SF');expect(speedInput()?.value).toBe(change==='project-change'?'245':'240');
});

it.each([true,false])('navigates immediately with invalid/pending Scoped edits and isolates late receipts (success=%s)',async success=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');await choose('T1 HF');
  await type(''); // numeric invalid input cannot write nil
  expect(h.mutate).not.toHaveBeenCalled();expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).not.toBeNull();
  await choose('T2 SF');expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();await choose('T1 HF');
  // vi.spyOn's original implementation is retained separately to avoid recursion.
  const execute=h.nativeMutate;let release!:()=>void;let started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  h.mutate.mockImplementationOnce(async request=>{started();await held;if(!success)return {ok:false,version:1,error:'Rejected old Scoped edit'};return execute(request);});
  await type('229');await entered;await h.select([1]);await choose('T2 SF');expect(selectedChoice()).toBe('T2 SF');
  await act(async()=>release());await act(async()=>waitForConfigurationMutations());
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({targets:[{scope:'object',id:String(h.objects[0].id)}],index:1,value:229}));
  expect(selectedChoice()).toBe('T2 SF');expect(speedInput()?.value).toBe('240');expect(targetDirty()).toBe('false');
  await h.select([0]);await choose('T1 HF');expect(speedInput()?.value).toBe(success?'229':'220');expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();
});

it('does not relabel an old mutation read as fresh after the native Project context advances',async()=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');await choose('T1 HF');
  const original=h.scopedRead.getMockImplementation()!;let oldRead!:ScopedConfigEditorSnapshot;
  let releaseOld!:()=>void,releaseFresh!:()=>void,entered!:()=>void;
  const oldHeld=new Promise<void>(resolve=>{releaseOld=resolve;}),freshHeld=new Promise<void>(resolve=>{releaseFresh=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  h.scopedRead.mockImplementation(async request=>{const result=await original(request);await freshHeld;return result;});
  h.scopedRead.mockImplementationOnce(async request=>{const result=await original(request);if(!result.ok)throw Error(result.error);oldRead=result;entered();await oldHeld;return result;});
  await type('229');await started;await choose('T2 SF');
  await act(async()=>{
    const result=await h.nativeMutate({version:1,operation:'set-element',targets:[{scope:'project'}],expectedRevision:oldRead.revision,
      key:'outer_wall_speed',scalarType:'float',index:2,value:245});if(!result.ok)throw Error(result.error);
    if(result.profileSnapshot)useSettingsStore.getState().hydrateProfileSnapshot(result.profileSnapshot);
    useSettingsStore.getState().setConfigurationMode('scoped');
    const outcome=useSettingsStore.getState().applyNativeScopedConfigTransport(result.nativeScopedConfig);
    if(outcome==='refresh-required') {
      const full=await h.runtime.getNativeScopedConfig();if(!full.ok)throw Error(full.error);
      useSettingsStore.getState().applyNativeScopedConfigTransport(full.nativeScopedConfig);
    }
  });
  await act(async()=>releaseOld());await act(async()=>waitForConfigurationMutations());
  expect(speedInput()?.matches(':disabled')).toBe(true); // old revision is display-only until the fresh read
  await act(async()=>releaseFresh());expect(selectedChoice()).toBe('T2 SF');expect(speedInput()?.value).toBe('245');
});

it('uses native first-choice fallback and hides the Scoped strip for one choice or shared-only pages',async()=>{
  const h=await setup(true);await click('config-mode-scoped');await click('config-page-Speed');await choose('T2 SF');
  h.scoped(snapshot=>({...snapshot,editorSelection:{...snapshot.editorSelection,choices:snapshot.editorSelection.choices.slice(0,1),firstChoiceId:'ordinal-0',
    fieldBindings:Object.fromEntries(Object.entries(snapshot.editorSelection.fieldBindings).map(([key,binding])=>[key,binding.kind==='shared'?binding:{...binding,bindings:binding.bindings.slice(0,1)}]))}}));
  await h.refresh();expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();expect(speedInput()?.value).toBe('200');
  h.scoped(undefined);await h.refresh();expect(selectedChoice()).toBe('T1 SF');
  await choose('T2 SF');await click('config-page-Quality');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  await click('config-page-Speed');expect(selectedChoice()).toBe('T2 SF');
  h.scoped(snapshot=>({...snapshot,targets:snapshot.targets.map(target=>({...target,editorVectors:{...target.editorVectors,outer_wall_speed:{...target.editorVectors.outer_wall_speed,readOnly:true}}}))}));
  await h.refresh();expect(speedInput()?.textContent).toBe('240');expect(speedInput()?.tagName).toBe('SPAN');
});


it('keeps native Print shared settings on whole-option edit/reset and preserves other sections on mapped section reset',async()=>{
  const h=await setup();
  const snapshot=await h.runtime.getPrintConfigEditor();if(!snapshot.ok)throw Error(snapshot.error);
  expect(snapshot.editorSelection.fieldBindings.print_sequence).toEqual({kind:'shared'});
  expect(snapshot.sourceValues.print_sequence).toBe('by layer');
  await click('config-page-Other');
  expect(document.querySelector('[data-testid="config-field-print_sequence"]')?.hasAttribute('data-native-index')).toBe(false);
  const select=async()=>{
    await click('config-input-print_sequence');
    const option=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option=>option.textContent==='by object')!;
    await act(async()=>{option.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));option.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  };
  await select();
  expect(h.mutate).toHaveBeenLastCalledWith({version:1,operation:'set',targets:[{scope:'project'}],key:'print_sequence',value:'by object'});
  expect(useSettingsStore.getState().nativeScopedConfig.project.print_sequence).toBe('by object');
  await click('config-reset-print_sequence');
  expect(h.mutate).toHaveBeenLastCalledWith({version:1,operation:'reset',targets:[{scope:'project'}],key:'print_sequence'});
  expect(useSettingsStore.getState().nativeScopedConfig.project.print_sequence).toBeUndefined();
  await select();await click('config-page-Speed');await choose('T1 HF');
  await act(async()=>{document.querySelector('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  expect(document.querySelector('[data-testid="config-reset-category-Other layers speed"]')?.hasAttribute('data-disabled')).toBe(true);
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await type('227');
  const before=await h.runtime.getHistoryStatus();
  await act(async()=>{document.querySelector('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  await click('config-reset-category-Other layers speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:expect.arrayContaining([
    {key:'outer_wall_speed',kind:'indexed',index:1},
  ])}));
  const sectionReset = h.mutate.mock.calls.at(-1)![0];
  if(sectionReset.operation==='reset-fields') expect(sectionReset.fields.some(field=>field.key==='print_sequence')).toBe(false);
  expect((await h.runtime.getHistoryStatus()).undoEntries).toHaveLength(before.undoEntries.length+1);
  expect(useSettingsStore.getState().nativeScopedConfig.project.print_sequence).toBe('by object');
});

it('distinguishes external whole options from genuinely unavailable Print-owned mappings',async()=>{
  const h=await setup();const snapshot=await h.runtime.getPrintConfigEditor();if(!snapshot.ok)throw Error(snapshot.error);
  for(const key of ['curr_bed_type']) {
    const field={key,label:key,category:'Other',meta:{type:'string' as const},value:'original',mixed:false,source:'project' as const,local:true,resettable:true};
    expect(snapshot.sourceValues).not.toHaveProperty(key);expect(snapshot.effectiveValues).not.toHaveProperty(key);
    expect(snapshot.editorSelection.fieldBindings).not.toHaveProperty(key);
    expect(projectPrintField(field,snapshot,'ordinal-1')).toBe(field);
  }
  const field={key:'outer_wall_speed',label:'Speed',category:'Speed',meta:{type:'floats' as const},value:'200',mixed:false,source:'preset' as const,local:false,resettable:true};
  expect(projectPrintField(field,{...snapshot,editorSelection:{...snapshot.editorSelection,fieldBindings:{}}},'ordinal-0')).toMatchObject({value:'Unavailable',resettable:false,editor:{perSelection:false,target:{kind:'unavailable'}}});
  // A vector's existence/length alone must not manufacture a per-selection glyph.
  expect(projectPrintField(field,{...snapshot,editorSelection:{...snapshot.editorSelection,fieldBindings:{outer_wall_speed:{kind:'shared'}}}},'ordinal-0')).toBe(field);
});


it('shows ordinary numeric controls for nullable Print metadata, rejects blank input and keeps indexed edits/reset',async()=>{
  const h=await setup();
  h.project(snapshot=>({...snapshot,editorVectors:Object.fromEntries(Object.entries(snapshot.editorVectors).map(([key,vector])=>
    [key,{...vector,nullable:true}]))}));
  await h.refresh();await click('config-page-Speed');await choose('T1 HF');
  expect(document.querySelector('[data-testid^="config-null-"]')).toBeNull();
  expect([...document.querySelectorAll('label')].some(label=>label.textContent==='Null')).toBe(false);
  const field=document.querySelector('[data-testid="config-field-outer_wall_speed"]')!;
  expect(field.querySelector('[role="checkbox"]')).toBeNull();
  expect((await h.runtime.getPrintConfigEditor() as ConfigEditorSnapshot).editorVectors.outer_wall_speed.nullable).toBe(true);
  const before=await h.runtime.getHistoryStatus();
  await type('');expect(h.mutate).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')?.textContent).toContain('valid number');
  await type('invalid');expect(h.mutate).not.toHaveBeenCalled();
  expect(await h.runtime.getHistoryStatus()).toEqual(before);
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{effectiveValues:[200,220,240]}}});
  await type('227');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set-element',index:1,value:227}));
  await click('config-reset-outer_wall_speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:[{key:'outer_wall_speed',kind:'indexed',index:1}]}));
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{effectiveValues:[200,220,240]}}});
});

it('preserves an imported nullable Print element until valid numeric input and keeps its reset repairable',async()=>{
  const h=await setup();
  // Native-shaped imported Source has a nil at this selection. Ordinary
  // numeric mutation/history still executes through the actual typed client.
  h.project(snapshot=>{
    const vector=snapshot.editorVectors.outer_wall_speed;
    const sourceValues=[200,null,240];
    const effectiveValues=vector.effectiveValues.map((value,index)=>index===1 && vector.overrideValues[index]===null?null:value);
    return {...snapshot,sourceValues:{...snapshot.sourceValues,outer_wall_speed:'200,nil,240'},
      effectiveValues:{...snapshot.effectiveValues,outer_wall_speed:effectiveValues.map(value=>value===null?'nil':value).join(',')},
      editorVectors:{...snapshot.editorVectors,outer_wall_speed:{...vector,nullable:true,sourceValues,effectiveValues}}};
  });
  await h.refresh();await click('config-page-Speed');await choose('T1 HF');
  const input=()=>document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')!;
  expect(input().value).toBe('');expect(input().disabled).toBe(false);
  await type('');await type('invalid');await choose('T2 SF');await choose('T1 HF');
  expect(input().value).toBe('');expect(h.mutate).not.toHaveBeenCalled();
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{nullable:true,sourceValues:[200,null,240],effectiveValues:[200,null,240]}}});
  await type('229');expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set-element',index:1,value:229}));
  expect(input().value).toBe('229');
  await click('config-reset-outer_wall_speed');expect(input().value).toBe('');expect(input().disabled).toBe(false);
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:{outer_wall_speed:{effectiveValues:[200,null,240]}}});
  await type('230');expect(input().value).toBe('230');
});

it('combines per-object conditions and permits ordinary native commands for hidden/read-only fields',async()=>{
  const h=await setup(true,true);
  await click('config-mode-scoped');await click('config-page-Speed');
  const target=[{scope:'object' as const,id:String(h.objects[0].id)}];
  const setOverhang=async(value:boolean)=>act(async()=>{
    const read=await h.runtime.getScopedConfigEditor({version:1,targets:target});if(!read.ok)throw Error(read.error);
    await commitScopedEditorMutation(h.platform,{version:1,operation:'set-element',targets:target,expectedRevision:read.revision,
      key:'enable_overhang_speed',scalarType:'bool',index:0,value},target);
  });
  const dependent=document.querySelector<HTMLElement>('[data-testid="config-field-slowdown_for_curled_perimeters"]')!;
  expect(dependent.hidden).toBe(false);
  await setOverhang(false);
  expect(dependent.hidden).toBe(true);
  expect(document.querySelector('[data-testid="config-field-slowdown_for_curled_perimeters"]')).toBe(dependent);
  await act(async()=>{await commitScopedEditorMutation(h.platform,{version:1,operation:'set',targets:target,
    key:'slowdown_for_curled_perimeters',value:'1'},target);});
  await setOverhang(true);expect(dependent.hidden).toBe(false);
  expect(document.querySelector('[data-testid="config-input-slowdown_for_curled_perimeters"]')?.getAttribute('aria-checked')).toBe('true');
  await setOverhang(false);await h.select([0,1]);
  expect(document.querySelector<HTMLElement>('[data-testid="config-field-slowdown_for_curled_perimeters"]')!.hidden).toBe(false);
  const speed=speedInput();
  await act(async()=>{await commitScopedEditorMutation(h.platform,{version:1,operation:'set',targets:target,key:'wall_loops',value:'0'},target);});
  expect(speed?.matches(':disabled')).toBe(true); // One locked target locks the whole selected batch.
  expect(speedInput()).toBe(speed);
  await act(async()=>{
    const read=await h.runtime.getScopedConfigEditor({version:1,targets:target});if(!read.ok)throw Error(read.error);
    await commitScopedEditorMutation(h.platform,{version:1,operation:'set-element',targets:target,expectedRevision:read.revision,
      key:'outer_wall_speed',scalarType:'float',index:0,value:211},target);
  });
  const native=await h.runtime.getScopedConfigEditor({version:1,targets:target});if(!native.ok)throw Error(native.error);
  expect(native.targets[0].editorVectors.outer_wall_speed.effectiveValues[0]).toBe(211);
});

it.each([false,true])('reads the editor once for each accepted set/reset/category/reset-all (Objects=%s)',async scoped=>{
  const h=await setup(scoped);if(scoped)await click('config-mode-scoped');
  await click('config-page-Speed');await choose('T1 HF');
  const read=scoped?h.scopedRead:h.read;
  const once=async(action:()=>Promise<unknown>)=>{
    const before=read.mock.calls.length;
    await action();await act(async()=>waitForConfigurationMutations());
    expect(read.mock.calls.length-before).toBe(1);
    expect(speedInput()?.matches(':disabled')).toBe(false);
  };
  await once(()=>type('229'));
  await once(()=>click('config-reset-outer_wall_speed'));
  await once(()=>type('230'));
  await act(async()=>document.querySelector<HTMLElement>('[data-testid="config-category-toggle-Other layers speed"]')!
    .dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10})));
  await once(()=>click('config-reset-category-Other layers speed'));
  await once(()=>type('231'));
  await once(()=>click('config-reset-all'));
});

it('acknowledges a committed write whose editor refresh fails, locks stale controls and never resubmits',async()=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  const nativeRead=h.read.getMockImplementation()!;
  const reads=h.read.mock.calls.length,writes=h.mutate.mock.calls.length;
  h.read.mockResolvedValueOnce({ok:false,error:'Injected editor refresh failure'});
  await type('229');await act(async()=>waitForConfigurationMutations());
  expect(h.mutate.mock.calls.length-writes).toBe(1);
  expect(h.read.mock.calls.length-reads).toBe(1);
  expect(speedInput()?.matches(':disabled')).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('committed');
  expect(await nativeRead()).toMatchObject({editorVectors:{outer_wall_speed:{effectiveValues:[200,229,240]}}});
  await click('config-page-Quality');await click('config-page-Speed');
  expect(h.mutate.mock.calls.length-writes).toBe(1);expect(h.read.mock.calls.length-reads).toBe(1);
});

describe('editor snapshot publication', () => {
  const snapshot = (revision: number) => ({ ok: true as const, revision, value: revision });
  function harness() {
    let context = { owner: 'A', revision: 1, base: {} };
    const queued: Array<() => Promise<void>> = [];
    const read = vi.fn(async (stamp: typeof context) => snapshot(stamp.revision));
    const controller = new EditorSnapshotController({ context: () => context,
      same: (a, b) => a.owner === b.owner && a.revision === b.revision && a.base === b.base,
      sameOwner: (a, b) => a.owner === b.owner, readable: () => true, revision: stamp => stamp.revision,
      read, schedule: operation => new Promise<void>((resolve, reject) => queued.push(() => operation().then(resolve, reject))),
    });
    const advance = (owner = context.owner) => { context = { owner, revision: context.revision + 1, base: {} }; };
    const drain = async () => { const pending = controller.refresh(); await queued.shift()?.(); await pending; };
    return { controller, read, queued, advance, drain, context: () => context };
  }

  it('coalesces invalidations and reads the final context at FIFO execution', async () => {
    const h = harness(); h.controller.start();
    h.advance(); void h.controller.refresh(); h.advance(); void h.controller.refresh();
    expect(h.queued).toHaveLength(1); expect(h.read).not.toHaveBeenCalled();
    await h.drain();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.controller.get().loaded?.snapshot.revision).toBe(3);
    await h.controller.refresh(); expect(h.queued).toHaveLength(0);
  });

  it('publishes an owned receipt inside the mutation reservation without scheduling another read', async () => {
    const h = harness(); h.controller.start(); await h.drain();
    await h.controller.mutate(async publish => {
      h.advance(); void h.controller.refresh(); h.advance(); void h.controller.refresh();
      expect(h.queued).toHaveLength(0);
      publish(snapshot(h.context().revision));
      // Still inside the command: a subscribed caller already has the final stamp.
      expect(h.controller.get().loaded?.context).toBe(h.context());
      expect(h.controller.get().pending).toBe(true);
      return snapshot(h.context().revision);
    });
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.queued).toHaveLength(0);
    expect(h.controller.get().pending).toBe(false);
  });

  it('rejects late read publication after a target change and schedules the current owner once', async () => {
    const h = harness(); let finish!: (value: ReturnType<typeof snapshot>) => void;
    h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.controller.start(); const first = h.controller.refresh(); const executing = h.queued.shift()!();
    h.advance('B'); void h.controller.refresh(); finish(snapshot(1)); await executing; await first;
    expect(h.controller.get().loaded).toBeNull(); expect(h.queued).toHaveLength(1);
    await h.drain(); expect(h.controller.get().loaded?.context.owner).toBe('B');
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('keeps an accepted edit locked after refresh failure and does not retry the write or read automatically', async () => {
    const h = harness(); h.controller.start(); await h.drain();
    const operation = vi.fn(async () => { h.advance(); throw new CommittedEditorRefreshError(new Error('read failed')); });
    await expect(h.controller.mutate(operation)).rejects.toThrow('committed');
    await h.controller.refresh();
    expect(h.controller.get().error).toContain('read failed'); expect(h.queued).toHaveLength(0);
    expect(operation).toHaveBeenCalledTimes(1); expect(h.read).toHaveBeenCalledTimes(1);
    await expect(h.controller.mutate(operation)).rejects.toThrow('not ready'); expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not send queued native reads for an unmounted session', async () => {
    const h = harness(); h.controller.start(); const pending = h.controller.refresh(); h.controller.stop();
    await h.queued.shift()!(); await pending; expect(h.read).not.toHaveBeenCalled();
  });

  it('coalesces StrictMode effect replay without duplicating the native read', async () => {
    const h = harness(); h.controller.start(); h.controller.stop(); h.controller.start();
    expect(h.queued).toHaveLength(1); await h.drain(); expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('reports a failed FIFO reservation instead of leaving an empty editor silently loading', async () => {
    const context = { revision: 1 };
    const read = vi.fn(async () => snapshot(1));
    const controller = new EditorSnapshotController({ context: () => context, same: (a, b) => a === b,
      sameOwner: (a, b) => a === b, readable: () => true, revision: stamp => stamp.revision, read,
      schedule: async () => { throw new Error('reservation rejected'); },
    });
    controller.start(); await controller.refresh();
    expect(controller.get().error).toContain('reservation rejected');
    expect(controller.get().refreshing).toBe(false); expect(read).not.toHaveBeenCalled();
  });

  it('accepts a current external read after geometry advances history beyond the configuration mirror', async () => {
    const h = harness(); h.read.mockResolvedValueOnce(snapshot(9));
    h.controller.start(); await h.drain();
    expect(h.controller.get().loaded?.snapshot.revision).toBe(9);
    expect(h.controller.get().loaded?.context.revision).toBe(1);
    expect(h.controller.get().error).toBeNull();
    await h.controller.refresh(); expect(h.read).toHaveBeenCalledTimes(1);
  });
});
