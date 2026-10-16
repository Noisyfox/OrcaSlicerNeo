// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION, type ConfigEditorSnapshot } from '@slicer/client';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { useObjectListStore } from '../objectList/useObjectListStore';
import { Selection } from '../viewport/Selection';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { ScopedConfigurationPanel } from './ScopedConfigurationPanel';
import { printChoiceFlow } from './PrintEditorSelection';
import { elementText, parsePrintElement, projectPrintField } from './printEditorProjection';
import { commitPrintConfigurationMutation, readPrintConfigEditor, waitForConfigurationMutations } from './configurationActions';

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
async function type(value:string,enter=true){
  const input=document.querySelector<HTMLInputElement>('[data-testid="config-input-outer_wall_speed"]')!;
  await act(async()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
  if(enter)await act(async()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
  return input;
}
async function setup(scopedFixture=false){
  useProjectStore.getState().reset();useHistoryNavigationStore.getState().reset();useHistoryRestoreStore.setState({phase:'idle',revision:0});
  const module=createMockModule({metadataKeys:{
    layer_height:{type:'float',category:'Speed',scopes:['project','object']},
    print_sequence:{type:'enum',category:'Speed',scopes:['project','plate'],enum_values:['by layer','by object']},
    curr_bed_type:{type:'enum',category:'Speed',scopes:['project','plate'],enum_values:['High Temp Plate','Textured PEI Plate']},
    outer_wall_speed:{type:'floats',category:'Speed',scopes:['project','object'],min:0},
    enable_overhang_speed:{type:'bools',category:'Speed',scopes:['project','object']},
    small_perimeter_speed:{type:'floats_or_percents',category:'Speed',scopes:['project','object']},
  }});
  const runtime=createClient(async()=>module);await runtime.init(MOCK_PROFILE_ACTIVATION);await runtime.resetHistory(context);
  let controller:SceneInteractionController|null=null;
  if(scopedFixture){
    await runtime.addShape('Cube','Scoped object');
    const structure=await runtime.getModelStructure();const object=structure.objects[0];
    useObjectListStore.getState().setStructure(structure.objects);
    controller={selection:new Selection(),computeSelectionKind:()=> 'object',selectedVolumes:()=>[{buffer:{objectId:object.id,volumeId:object.volumes[0].id}}]} as unknown as SceneInteractionController;
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
  const mutate=vi.spyOn(runtime,'mutateNativeScopedConfig');
  const platform={runtime,preferences:{load:async()=>structuredClone(DEFAULT_USER_PREFERENCES),save:async()=>{}}} as unknown as PlatformCapabilities;
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(<PlatformProvider value={platform}><TooltipProvider><ScopedConfigurationPanel sceneInteraction={controller} /></TooltipProvider></PlatformProvider>));
  return {runtime,platform,read,mutate,project:(next:typeof project)=>{project=next;},refresh:async()=>act(async()=>{useHistoryRestoreStore.getState().advanceRevision();})};
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
  await click('config-reset-category-Speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:expect.arrayContaining([
    {key:'outer_wall_speed',kind:'indexed',index:1},{key:'enable_overhang_speed',kind:'indexed',index:1},{key:'layer_height',kind:'shared'},
  ])}));
  expect((await h.runtime.getHistoryStatus()).undoEntries).toHaveLength(history.undoEntries.length+1);
  await act(async()=>{await h.runtime.undoHistory();useHistoryRestoreStore.getState().advanceRevision();});
  expect(input().value).toBe('228');expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>{await h.runtime.redoHistory();useHistoryRestoreStore.getState().advanceRevision();});expect(input().value).toBe('220');
  await click('config-mode-scoped');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  await click('config-mode-plates');expect(document.querySelector('[data-testid="print-editor-selection"]')).toBeNull();
  await click('config-mode-project');expect(selectedChoice()).toBe('T1 HF');
  await act(async()=>useSettingsStore.getState().enterPrintPreset());
  expect(selectedChoice()).toBe('T1 SF');
});

it.each([true,false])('navigates invalid/pending Print fields immediately and confines late receipts (success=%s)',async success=>{
  const h=await setup();await click('config-page-Speed');await choose('T1 HF');
  await type('invalid');expect(h.mutate).not.toHaveBeenCalled();
  await choose('T2 SF');expect(document.querySelector('[data-testid="config-error-outer_wall_speed"]')).toBeNull();
  await choose('T1 HF');
  const native=h.mutate.getMockImplementation()??h.runtime.mutateNativeScopedConfig.bind(h.runtime);
  // Capture the original method before replacing the spy implementation.
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
  await act(async()=>{document.querySelector('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  await click('config-reset-category-Speed');
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
    const h=await setup();const snapshot=await readPrintConfigEditor(h.platform);if(!snapshot.ok)throw Error(snapshot.error);
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
  const h=await setup();const snapshot=await readPrintConfigEditor(h.platform);if(!snapshot.ok)throw Error(snapshot.error);
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
  let readDone=false;const read=readPrintConfigEditor(h.platform).then(result=>{readDone=true;return result;});
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

it('keeps Object whole-option edits on their existing scoped path instead of adopting the Project element',async()=>{
  const h=await setup(true);await click('config-page-Speed');await choose('T1 HF');await type('230');
  const project=await h.runtime.getPrintConfigEditor();
  await click('config-mode-scoped');await click('config-page-Speed');
  const field=document.querySelector('[data-testid="config-field-outer_wall_speed"]')!;
  expect(field.hasAttribute('data-native-index')).toBe(false);
  await type('205,235,245');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'set',targets:[{scope:'object',id:expect.any(String)}],key:'outer_wall_speed',value:'205,235,245'}));
  expect(await h.runtime.getPrintConfigEditor()).toMatchObject({editorVectors:(project as ConfigEditorSnapshot).editorVectors});
});


it('keeps native Print shared settings on whole-option edit/reset and includes them in one mapped category reset',async()=>{
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
  await select();await click('config-page-Speed');await choose('T1 HF');await type('227');
  const before=await h.runtime.getHistoryStatus();
  await act(async()=>{document.querySelector('[data-testid="config-category-toggle-Other layers speed"]')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,button:2,clientX:10,clientY:10}));});
  await click('config-reset-category-Speed');
  expect(h.mutate).toHaveBeenLastCalledWith(expect.objectContaining({operation:'reset-fields',fields:expect.arrayContaining([
    {key:'outer_wall_speed',kind:'indexed',index:1},{key:'print_sequence',kind:'shared'},
  ])}));
  expect((await h.runtime.getHistoryStatus()).undoEntries).toHaveLength(before.undoEntries.length+1);
  expect(useSettingsStore.getState().nativeScopedConfig.project.print_sequence).toBeUndefined();
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
