// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type {
  OptionMeta,
  PresetDraftEditorBinding,
  PresetDraftEditorScalarType,
  PresetDraftEditorValue,
  PresetDraftKind,
  PresetDraftMutationRequest,
  PresetDraftMutationResult,
  PresetDraftSnapshot,
  PresetDraftVectorValue,
  PresetDraftEditorVector,
} from '@slicer/client';
import { PresetEditorDialog, PresetEditorDialogContent } from './PresetEditorDialog';
import { commitPresetDraftMutation, CommittedPresetDraftProjectionError } from './configurationActions';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { SceneInteractionController } from '../viewport/SceneInteractionController';
vi.mock('./configurationActions', async importOriginal => ({
  ...await importOriginal<typeof import('./configurationActions')>(), commitPresetDraftMutation: vi.fn(),
}));
import {
  FILAMENT_PRESET_EDITOR_MANIFEST,
  PRINTER_PRESET_EDITOR_MANIFEST,
  presetEditorFields,
} from './presetEditorManifests';

if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let roots: Root[] = [];

type TestVector = { scalarType: PresetDraftEditorScalarType; metadataType: OptionMeta['type']; values: PresetDraftEditorValue[]; guiType?: PresetDraftEditorBinding['guiType']; multiline?: boolean; isCode?: boolean; nullable?: boolean; enumOptions?: PresetDraftEditorBinding['enumOptions'] };

function bindingFor(vector: TestVector, value: PresetDraftEditorValue = vector.values[0] ?? null): PresetDraftEditorBinding {
  return {
    scalarType: vector.scalarType,
    index: 0,
    elementCount: vector.values.length,
    nullable: vector.nullable ?? false,
    guiType: vector.guiType ?? 'undefined',
    guiFlags: vector.guiType === 'f_enum_open' ? 'show_value' : '',
    multiline: vector.multiline ?? false,
    isCode: vector.isCode ?? false,
    readOnly: false,
    sourceValue: vector.values[0] ?? null,
    effectiveValue: value,
    ...(vector.enumOptions ? { enumOptions: vector.enumOptions } : {}),
  };
}

function snapshotFor(kind: PresetDraftKind, options: { modified?: boolean; draftExists?: boolean } = {}): PresetDraftSnapshot {
  const manifest = kind === 'printer' ? PRINTER_PRESET_EDITOR_MANIFEST : FILAMENT_PRESET_EDITOR_MANIFEST;
  const fields = presetEditorFields(manifest);
  const sourceValues = Object.fromEntries(fields.map(({ key }) => [key, `source:${key}`]));
  const effectiveValues = { ...sourceValues };
  const optionMetadata: Record<string, OptionMeta> = Object.fromEntries(fields.map(({ key }) => [key, {
    type: 'string',
    label: `Label ${key}`,
    tooltip: `Help ${key}`,
  }]));
  const editorBindings: Record<string, PresetDraftEditorBinding> = {};

  if (kind === 'printer') {
    sourceValues.extruders_count = '1';
    effectiveValues.extruders_count = '2';
    optionMetadata.extruders_count = { type: 'int', label: 'Extruders', min: 1, max: 64, readonly: false };
    sourceValues.single_extruder_multi_material = effectiveValues.single_extruder_multi_material = '0';
    optionMetadata.single_extruder_multi_material = { type: 'bool', label: 'Single extruder multi-material' };
    sourceValues.printable_height = '230';
    effectiveValues.printable_height = options.modified ? '245' : '230';
    const nozzleDiameter: TestVector = { scalarType: 'float', metadataType: 'floats', values: [0.4, 0.6] };
    sourceValues.nozzle_diameter = JSON.stringify([0.4]);
    effectiveValues.nozzle_diameter = JSON.stringify(nozzleDiameter.values);
    optionMetadata.nozzle_diameter = { type: 'floats', label: 'Nozzle diameter' };
    editorBindings.nozzle_diameter = { ...bindingFor(nozzleDiameter), elementCount: 2 };
    optionMetadata.printable_height = { type: 'float', label: 'Build height', tooltip: 'Height of the build volume', min: 1, max: 1000, tooltip_default: '230' };
    optionMetadata.printer_agent = { type: 'enum', label: 'Printer Agent', tooltip: 'Network agent selector', enum_values: ['default'] };
    optionMetadata.machine_start_gcode = { type: 'string', label: 'Machine start script', tooltip: 'Distinctive machine start help text' };
    optionMetadata.printer_notes = { type: 'string', label: 'Printer notes', tooltip: 'Notes tooltip' };
    optionMetadata.time_cost = { type: 'string', label: 'Time cost' };
    optionMetadata.support_multi_bed_types = { type: 'bool', label: 'Multiple beds' };
  } else {
    const vectors: Record<string, TestVector> = {
      filament_flow_ratio: { scalarType: 'float', metadataType: 'floats', values: [1, 0.98] },
      filament_type: { scalarType: 'string', metadataType: 'strings', values: ['PLA'], guiType: 'f_enum_open' },
      filament_soluble: { scalarType: 'bool', metadataType: 'bools', values: [false] },
      filament_adaptive_volumetric_speed: {
        scalarType: 'bool', metadataType: 'bools', values: [null], nullable: true,
      },
      default_filament_colour: { scalarType: 'string', metadataType: 'strings', values: ['#F2754E'], guiType: 'color' },
      filament_diameter: { scalarType: 'float', metadataType: 'floats', values: [1.75, 2.85] },
      filament_adhesiveness_category: { scalarType: 'int', metadataType: 'ints', values: [0] },
      filament_shrink: { scalarType: 'percent', metadataType: 'percents', values: [100] },
      overhang_fan_threshold: {
        scalarType: 'enum', metadataType: 'enums', values: [2],
        enumOptions: [
          { value: 0, name: '0%', label: '0%' },
          { value: 1, name: '10%', label: '10%' },
          { value: 2, name: '25%', label: '25%' },
          { value: 3, name: '50%', label: '50%' },
          { value: 4, name: '75%', label: '75%' },
          { value: 5, name: '95%', label: '95%' },
        ],
      },
      filament_start_gcode: { scalarType: 'string', metadataType: 'strings', values: ['G28\nM104 S220\n'], multiline: true, isCode: true },
      filament_change_extrusion_role_gcode: { scalarType: 'string', metadataType: 'strings', values: ['; role change\n'], multiline: true, isCode: true },
      filament_end_gcode: { scalarType: 'string', metadataType: 'strings', values: ['M104 S0\n'], multiline: true, isCode: true },
      filament_notes: { scalarType: 'string', metadataType: 'strings', values: [''], multiline: true },
    };
    for (const [key, vector] of Object.entries(vectors)) {
      const values = [...vector.values];
      if (options.modified && key === 'filament_flow_ratio') values[0] = 0.92;
      sourceValues[key] = JSON.stringify(vector.values);
      effectiveValues[key] = JSON.stringify(values);
      optionMetadata[key] = {
        type: vector.metadataType,
        label: key === 'filament_type' ? 'Filament type' : `Label ${key}`,
        ...(vector.enumOptions ? {
          enum_values: vector.enumOptions.map(({ name }) => name),
          enum_labels: vector.enumOptions.map(({ label }) => label),
        } : {}),
      };
      editorBindings[key] = bindingFor(vector, values[0] ?? null);
    }
    optionMetadata.filament_vendor = { type: 'string', label: 'Vendor' };
    optionMetadata.enable_pressure_advance = { type: 'bool', label: 'Pressure advance' };
  }
  const modifiedKey = kind === 'printer' ? 'printable_height' : 'filament_flow_ratio';
  if (options.modified && kind === 'printer') effectiveValues[modifiedKey] = '245';

  return {
    ok: true,
    kind,
    canonicalName: kind === 'printer' ? 'Printer Canonical' : 'Filament Canonical',
    editorCandidates: [{ canonicalName: kind === 'printer' ? 'Printer Canonical' : 'Filament Canonical', label: kind === 'printer' ? 'Printer Canonical' : 'Filament Canonical', isProjectEmbedded: false, isUser: false, compatible: true, modified: options.modified ?? false }],
    draftExists: options.draftExists ?? true,
    filamentOverrideContext: {},
    modified: options.modified ?? false,
    overrides: options.modified ? (kind === 'printer' ? { printable_height: '245' } : { filament_flow_ratio: [{value: 0.92}, null] }) : {},
    sourceValues,
    effectiveValues,
    editorSelection: { kind, activeSource: kind === 'printer', choices: [], firstChoiceId: null, nozzles: [],
      fieldBindings: Object.fromEntries(Object.keys(effectiveValues).map(key => [key, { kind: 'shared' as const }])) },
    optionMetadata,
    editorBindings,
    editorVectors: Object.fromEntries(Object.entries(editorBindings).map(([key, binding]) => [key, {
      ...binding, overrideValues: Array.from({length: binding.elementCount}, (_, index) => options.modified && key === 'filament_flow_ratio' && index === 0 ? {value: 0.92} : null), indexCount: binding.elementCount, sourceValues: JSON.parse(sourceValues[key]!), effectiveValues: JSON.parse(effectiveValues[key]!),
    }])),
    revision: 1,
  };
}

function mutationSuccess(snapshot: PresetDraftSnapshot, request: PresetDraftMutationRequest): PresetDraftMutationResult {
  const next = { ...snapshot };
  let overrides = { ...snapshot.overrides };
  let effectiveValues = { ...snapshot.effectiveValues };
  let editorBindings = { ...snapshot.editorBindings };
  const editorVectors = { ...snapshot.editorVectors };
  if (request.action === 'set-element') {
    const binding = snapshot.editorBindings[request.key];
    const vector = editorVectors[request.key];
    if (!binding && !vector) throw new Error('missing native element fixture');
    const rawValues = vector ? [...vector.effectiveValues] :
      JSON.parse(effectiveValues[request.key] ?? snapshot.sourceValues[request.key] ?? '[]') as PresetDraftVectorValue[];
    while (rawValues.length <= request.index) rawValues.push(rawValues[0] ?? []);
    rawValues[request.index] = request.value;
    const serialized = JSON.stringify(rawValues);
    const entries = [...vector.overrideValues];
    entries[request.index] = { value: request.value };
    overrides[request.key] = entries;
    effectiveValues[request.key] = serialized;
    if (request.scalarType !== 'point' && request.scalarType !== 'points')
      editorBindings[request.key] = { ...binding!, effectiveValue: rawValues[0] as PresetDraftEditorValue };
    if (vector) editorVectors[request.key] = { ...vector, effectiveValues: rawValues, overrideValues: entries };
  } else if (request.action === 'set') {
    overrides[request.key] = request.value;
    effectiveValues[request.key] = request.value;
  } else if (request.action === 'reset-field') {
    if (request.index !== undefined && editorVectors[request.key]) {
      const vector = editorVectors[request.key];
      const values = [...vector.effectiveValues];
      values[request.index] = vector.sourceValues[request.index < vector.sourceValues.length ? request.index : 0];
      const entries = [...vector.overrideValues];
      entries[request.index] = null;
      editorVectors[request.key] = { ...vector, effectiveValues: values, overrideValues: entries };
      effectiveValues[request.key] = JSON.stringify(values);
      if (!entries.some(entry => entry !== null)) delete overrides[request.key];
      else overrides[request.key] = entries;
    } else {
      delete overrides[request.key];
      effectiveValues[request.key] = snapshot.sourceValues[request.key] ?? '';
      const binding = snapshot.editorBindings[request.key];
      if (binding) editorBindings[request.key] = { ...binding, effectiveValue: binding.sourceValue };
    }
  } else if (request.action === 'reset-category') {
    for (const field of request.fields) {
      const {key} = field;
      if (field.kind === 'indexed' && editorVectors[key]) {
        const vector = editorVectors[key];
        const values = [...vector.effectiveValues];
        values[field.index] = vector.sourceValues[field.index < vector.sourceValues.length ? field.index : 0] ?? [];
        const entries = [...vector.overrideValues];
        entries[field.index] = null;
        editorVectors[key] = { ...vector, effectiveValues: values, overrideValues: entries };
        if (editorBindings[key]) editorBindings[key] = { ...editorBindings[key], effectiveValue: values[0] as PresetDraftEditorValue };
        effectiveValues[key] = JSON.stringify(values);
        if (!entries.some(entry => entry !== null)) delete overrides[key];
        else overrides[key] = entries;
        continue;
      }
      delete overrides[key];
      effectiveValues[key] = snapshot.sourceValues[key] ?? '';
      if (snapshot.editorBindings[key]) editorBindings[key] = snapshot.editorBindings[key];
    }
  } else {
    overrides = {};
    effectiveValues = { ...snapshot.sourceValues };
    editorBindings = { ...snapshot.editorBindings };
  }
  return {
    ...next,
    projectionKind: 'full',
    editorCandidates: { kind: 'replace', items: next.editorCandidates },
    overrides,
    effectiveValues,
    editorBindings,
    editorVectors,
    draftExists: request.action === 'reset-preset' ? false : true,
    modified: Object.keys(overrides).length > 0,
    revision: snapshot.revision + 1,
    historyEntryDelta: 1,
    revisionBefore: snapshot.revision,
    revisionAfter: snapshot.revision + 1,
    dirty: true,
    affectedPlateIds: ['plate-1'],
    allPlateResultsInvalidated: true,
    plateSession: {} as never,
    filamentSession: {} as never,
    historyStatus: {} as never,
    nativeScopedConfig: {} as never,
    profileSnapshot: {} as never,
  } as PresetDraftMutationResult;
}

function physicalFixture(snapshot: PresetDraftSnapshot): PresetDraftSnapshot {
  if (snapshot.kind !== 'printer' || snapshot.editorSelection.choices.some(choice => !choice.id.startsWith('fixture-head-'))) return snapshot;
  const count = snapshot.editorVectors.nozzle_diameter?.indexCount ?? 0;
  const choices = Array.from({length:count},(_,index) => ({id:`fixture-head-${index}`,label:`Extruder ${index+1} Standard`,
    extruderIndex:index,variant:'Direct Drive Standard',extruderType:0,flowType:0}));
  return {...snapshot,editorSelection:{kind:'printer',activeSource:true,choices,firstChoiceId:choices[0]?.id??null,
    nozzles:choices.map(choice => ({extruderIndex:choice.extruderIndex,defaultChoiceId:choice.id,initialChoiceId:choice.id})),
    fieldBindings:Object.fromEntries(Object.keys(snapshot.effectiveValues).map(key => [key,snapshot.editorVectors[key] ? {
      kind:'per_selection',bindings:choices.map((_,index) => index < snapshot.editorVectors[key].indexCount ? {kind:'indexed',index} : {kind:'unavailable'}),
    } : {kind:'shared'}])),
  }};
}

// Explicit native-shaped U1 oracle: physical 2, SF/HF variants 4/5, normal motion 8/10.
function u1Fixture({name='Active U1',active=true,count=4,flows=[0,1],initial=[0,1,0,0],defaults=[0,0,0,0]}: {
  name?:string;active?:boolean;count?:number;flows?:number[];initial?:number[];defaults?:number[];
} = {}): PresetDraftSnapshot {
  const base=snapshotFor('printer');
  const positions=[{head:0,flow:0,variant:0,motion:0},{head:0,flow:1,variant:1,motion:2},
    {head:1,flow:0,variant:2,motion:4},{head:1,flow:1,variant:3,motion:6},
    {head:2,flow:0,variant:4,motion:8},{head:2,flow:1,variant:5,motion:10},
    {head:3,flow:0,variant:6,motion:12},{head:3,flow:1,variant:7,motion:14}].filter(p => p.head<count && flows.includes(p.flow));
  const choices=positions.map(p => ({id:`head-${p.head}-${p.flow}`,label:`Extruder ${p.head+1} ${p.flow?'High Flow':'Standard'}`,
    extruderIndex:p.head,flowType:p.flow,extruderType:0,variant:p.flow?'Direct Drive High Flow':'Direct Drive Standard'}));
  const vector=(values:number[]):PresetDraftEditorVector => ({...base.editorVectors.nozzle_diameter,scalarType:'float',
    indexCount:values.length,sourceValues:values,effectiveValues:[...values],overrideValues:values.map(()=>null)});
  const editorVectors={nozzle_diameter:vector([0.4,0.4,0.6,0.6].slice(0,count)),
    min_layer_height:vector([0.08,0.08,0.12,0.12].slice(0,count)),
    retraction_length:vector([0.8,0.9,1,1.1,1.2,1.3,1.4,1.5]),
    machine_max_speed_e:vector([100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115])};
  const sourceValues={...base.sourceValues,...Object.fromEntries(Object.entries(editorVectors).map(([k,v])=>[k,JSON.stringify(v.sourceValues)])),emit_machine_limits_to_gcode:'1'};
  const fieldBindings={...Object.fromEntries(Object.keys(sourceValues).map(key=>[key,{kind:'shared' as const}])),
    ...Object.fromEntries(Object.keys(editorVectors).map(key=>[key,{kind:'per_selection' as const,bindings:positions.map(p=>({kind:'indexed' as const,
      index:key==='retraction_length'?p.variant:key==='machine_max_speed_e'?p.motion:p.head}))}]))};
  return {...base,canonicalName:name,sourceValues,effectiveValues:{...sourceValues},editorVectors,
    editorCandidates:[{...base.editorCandidates[0],canonicalName:name,label:name}],
    optionMetadata:{...base.optionMetadata,retraction_length:{type:'floats',label:'Retraction length',tooltip_default:'0.8,0.9,1,1.1,1.2,1.3,1.4,1.5'},
      machine_max_speed_e:{type:'floats',label:'Maximum E speed'},emit_machine_limits_to_gcode:{type:'bool',label:'Emit limits'}},
    editorSelection:{kind:'printer',activeSource:active,choices,firstChoiceId:choices[0]?.id??null,fieldBindings,
      nozzles:Array.from({length:count},(_,head)=>({extruderIndex:head,defaultChoiceId:`head-${head}-${flows.includes(defaults[head])?defaults[head]:flows[0]}`,
        initialChoiceId:`head-${head}-${flows.includes(initial[head])?initial[head]:flows[0]}`}))},
  };
}
function filamentVariantsFixture(): PresetDraftSnapshot {
  const base=snapshotFor('filament');
  const variants=['Direct Drive Standard','Direct Drive High Flow','Direct Drive Extra High Flow','Bowden Standard','Bowden High Flow','Bowden Extra High Flow'];
  const choices=variants.map((variant,index)=>({id:`variant-${index}`,label:variant,variant,extruderIndex:null,extruderType:index<3?0:1,flowType:[0,1,2,0,1,2][index]}));
  const editorVectors=Object.fromEntries(Object.entries(base.editorVectors).map(([key,vector])=>{
    const values=key==='filament_flow_ratio'?[1,1.1,1.2,1.3,1.4,1.5]:Array.from({length:6},()=>vector.sourceValues[0]);
    return [key,{...vector,indexCount:6,sourceValues:values,effectiveValues:[...values],overrideValues:values.map(()=>null)}];
  }));
  const values={...base.sourceValues,...Object.fromEntries(Object.entries(editorVectors).map(([key,vector])=>[key,JSON.stringify(vector.sourceValues)]))};
  return {...base,sourceValues:values,effectiveValues:{...values},editorVectors,
    optionMetadata:{...base.optionMetadata,filament_flow_ratio:{...base.optionMetadata.filament_flow_ratio,tooltip_default:'1,1.1,1.2,1.3,1.4,1.5'}},
    editorSelection:{kind:'filament',activeSource:false,choices,nozzles:[],firstChoiceId:choices[0].id,
      fieldBindings:Object.fromEntries(Object.keys(values).map(key=>[key,editorVectors[key]?{kind:'per_selection',bindings:choices.map((_,index)=>({kind:'indexed',index}))}:{kind:'shared'}]))}};
}
async function controlledPrinter(initial: PresetDraftSnapshot, handler?: (request:PresetDraftMutationRequest)=>Promise<PresetDraftMutationResult>) {
  const container=document.createElement('div');document.body.append(container);
  const root=createRoot(container);roots.push(root);
  const platform={preferences:{load:async()=>structuredClone(DEFAULT_USER_PREFERENCES),save:async()=>{}}} as unknown as PlatformCapabilities;
  let snapshot:PresetDraftSnapshot|null=initial,entry=0,pending=false;
  const onMutate=vi.fn(async(request:PresetDraftMutationRequest)=>{
    pending=true; render();
    const result=handler?await handler(request):mutationSuccess(snapshot!,request);
    if(result.ok) snapshot={...result,editorCandidates:snapshot!.editorCandidates};
    pending=false; render(); return result;
  });
  const render=()=>root.render(<PlatformProvider value={platform}><PresetEditorDialogContent
    sourceEntry={entry} target={snapshot?{kind:snapshot.kind,canonicalName:snapshot.canonicalName}:null}
    snapshot={snapshot} mutationPending={pending} onMutate={onMutate} onSelectPreset={async()=>{}} onClose={()=>{}} /></PlatformProvider>);
  await act(async()=>render());
  return {onMutate,getSnapshot:()=>snapshot!,update:async(next:PresetDraftSnapshot|null,nextEntry=entry)=>{snapshot=next;entry=nextEntry;await act(async()=>render());}};
}
async function selectFlow(head:number,label:string) {
  await click(document.querySelector(`[data-testid="preset-editor-flow-${head}"]`));
  await click([...document.querySelectorAll(`[data-testid^="preset-editor-flow-option-${head}-"]`)].find(option=>option.textContent===label)??null);
}

async function selectExtruder(number: number) {
  await click(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]'));
  await click(document.querySelector(`[data-testid="preset-editor-extruder-${number}"]`));
}

async function mount(
  snapshot: PresetDraftSnapshot | null,
  onClose = vi.fn(),
  referencedFilamentSlots?: readonly number[],
  onMutate: (request: PresetDraftMutationRequest) => Promise<PresetDraftMutationResult> = async () => ({
    ok: false, error: 'mutation fixture not configured',
  }),
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  function Harness() {
    const [current, setCurrent] = useState(snapshot ? physicalFixture(snapshot) : null);
    const mutate = async (request: PresetDraftMutationRequest) => {
      const result = await onMutate(request);
      if (result.ok) setCurrent(previous => physicalFixture({ ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : previous!.editorCandidates }));
      return result;
    };
      const target = current ? { kind: current.kind, canonicalName: current.canonicalName } : null;
    return <PresetEditorDialogContent
      target={target}
      snapshot={current}
      referencedFilamentSlots={referencedFilamentSlots}
      onSelectPreset={async () => {}}
      onClose={onClose}
      onMutate={mutate}
    />;
  }
  await act(async () => {
    const platform = { preferences: { load: async () => structuredClone(DEFAULT_USER_PREFERENCES), save: async () => {} } } as unknown as PlatformCapabilities;
    root.render(<PlatformProvider value={platform}><Harness /></PlatformProvider>);
  });
  return { container, root, onClose };
}

async function click(element: Element | null) {
  if (!element) throw new Error('expected a clickable element');
  await act(async () => {
    if (element.getAttribute('data-slot') === 'select-item') {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    } else (element as HTMLElement).click();
  });
}

async function changeInput(input: HTMLInputElement, value: string) {
  if (!input) throw new Error(`missing input; visible controls: ${[...document.querySelectorAll('[data-testid^="preset-editor-input-"]')].map((node) => node.getAttribute('data-testid')).join(', ')}`);
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    textarea.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function press(input: HTMLElement, key: string, modifiers:KeyboardEventInit={}) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
  });
}

async function enterSearch(value: string) {
  const input = document.querySelector('[data-testid="preset-editor-search"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function groupHeadings(pageId: string): string[] {
  return [...document.querySelectorAll(`[data-testid="preset-editor-page-${pageId}"] section h3`)]
    .map((heading) => heading.textContent ?? '');
}

function visibleFieldKeys(pageId: string): string[] {
  return [...document.querySelectorAll(`[data-testid="preset-editor-page-${pageId}"] [data-testid^="preset-editor-field-"]`)]
    .map((field) => field.getAttribute('data-field-key') ?? '');
}

beforeEach(() => {
  if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, configurable: true });
});

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  document.body.innerHTML = '';
});

describe('PresetEditorDialogContent', () => {
  it('edits the complete native Filament list without Printer filtering, with indexed ownership and atomic shared reset',async()=>{
    const source=filamentVariantsFixture();const h=await controlledPrinter(source);
    await click(document.querySelector('[data-testid="preset-editor-variant"]'));
    expect([...document.querySelectorAll('[role="option"]')].map(option=>option.textContent)).toEqual(source.editorSelection.choices.map(choice=>choice.label));
    await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent==='Bowden Extra High Flow')!);
    const input=()=>document.querySelector('[data-testid="preset-editor-input-filament_flow_ratio"]') as HTMLInputElement;
    expect(input().value).toBe('1.5');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_flow_ratio"]')?.textContent).toBe('1.5');
    expect(document.querySelector('[data-testid="preset-editor-field-filament_flow_ratio"]')?.getAttribute('title')).toContain('filament_flow_ratio[5]');
    await changeInput(input(),'1.45');await press(input(),'Enter');
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({kind:'filament',key:'filament_flow_ratio',index:5,value:1.45}));
    await changeInput(input(),'1.5');await press(input(),'Enter');
    expect(document.querySelector('[data-testid="preset-editor-option-label-filament_flow_ratio"]')?.getAttribute('data-draft-override-highlight')).toBe('true');
    await enterSearch('filament_flow_ratio');
    expect(input().value).toBe('1.5');await enterSearch('');
    await click(document.querySelector('[data-testid="preset-editor-reset-category-filament"]'));
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-category',fields:expect.arrayContaining([
      {key:'filament_flow_ratio',kind:'indexed',index:5},{key:'filament_vendor',kind:'shared'},
    ])}));
    expect(h.getSnapshot().editorVectors.filament_flow_ratio.overrideValues[5]).toBeNull();
  });

  it('retains semantic Filament identity on reordered history, defaults on removal/entry, and navigates during pending/invalid edits',async()=>{
    const source=filamentVariantsFixture();let finish!:(result:PresetDraftMutationResult)=>void;
    const h=await controlledPrinter(source,()=>new Promise(resolve=>{finish=resolve;}));
    const select=async(label:string)=>{await click(document.querySelector('[data-testid="preset-editor-variant"]'));await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent===label)!);};
    await select('Bowden Extra High Flow');
    const choices=[source.editorSelection.choices[5],...source.editorSelection.choices.slice(0,5)].map((choice,index)=>({...choice,id:`variant-${index}`}));
    await h.update({...source,revision:2,editorSelection:{...source.editorSelection,choices}});
    expect(document.querySelector('[data-testid="preset-editor-variant"]')?.textContent).toContain('Bowden Extra High Flow');
    await click(document.querySelector('[data-testid="preset-editor-page-tab-dependencies"]'));
    expect(document.querySelector('[data-testid="preset-editor-variant"]')).toBeNull();
    await click(document.querySelector('[data-testid="preset-editor-page-tab-cooling"]'));
    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    let input=document.querySelector('[data-testid="preset-editor-input-filament_flow_ratio"]') as HTMLInputElement;
    await changeInput(input,'bad');await press(input,'Enter');
    await select('Direct Drive High Flow');
    expect(document.querySelector('[data-testid="preset-editor-error-filament_flow_ratio"]')).toBeNull();
    input=document.querySelector('[data-testid="preset-editor-input-filament_flow_ratio"]') as HTMLInputElement;
    await changeInput(input,'1.22');await act(async()=>input.blur());
    const captured=h.onMutate.mock.calls[0][0];expect(captured).toMatchObject({index:2,value:1.22});
    await select('Bowden High Flow');
    await act(async()=>finish(mutationSuccess(source,captured)));
    expect(document.querySelector('[data-testid="preset-editor-variant"]')?.textContent).toContain('Bowden High Flow');
    expect(document.querySelector('[data-testid="preset-editor-input-filament_flow_ratio"]')).toHaveProperty('value','1.4');
    await h.update({...source,editorSelection:{...source.editorSelection,choices:source.editorSelection.choices.slice(0,2),
      fieldBindings:Object.fromEntries(Object.entries(source.editorSelection.fieldBindings).map(([key,binding])=>[key,
        binding.kind==='shared'?binding:{...binding,bindings:binding.bindings.slice(0,2)}]))}});
    expect(document.querySelector('[data-testid="preset-editor-variant"]')?.textContent).toContain('Direct Drive Standard');
    await select('Direct Drive High Flow');await h.update(source,1);
    expect(document.querySelector('[data-testid="preset-editor-variant"]')?.textContent).toContain('Direct Drive Standard');
    await select('Bowden High Flow');await h.update(null);await h.update(source,2);
    expect(document.querySelector('[data-testid="preset-editor-variant"]')?.textContent).toContain('Direct Drive Standard');
  });

  it('uses valid short Filament vectors while leaving missing variant mappings unavailable and out of reset',async()=>{
    const source=filamentVariantsFixture();const diameter=source.editorSelection.fieldBindings.filament_diameter;
    if(diameter.kind!=='per_selection')throw Error('mapping');
    const h=await controlledPrinter({...source,
      editorVectors:{...source.editorVectors,filament_flow_ratio:{...source.editorVectors.filament_flow_ratio,sourceValues:[1],effectiveValues:[1],overrideValues:[null,null,null,null,null,{value:1}]}},
      editorSelection:{...source.editorSelection,fieldBindings:{...source.editorSelection.fieldBindings,
        filament_diameter:{kind:'per_selection',bindings:diameter.bindings.map((binding,index)=>index===5?{kind:'unavailable'}:binding)}}}});
    await click(document.querySelector('[data-testid="preset-editor-variant"]'));
    await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent==='Bowden Extra High Flow')!);
    expect(document.querySelector('[data-testid="preset-editor-input-filament_flow_ratio"]')).toHaveProperty('value','1');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_diameter"]')?.textContent).toBe('Unavailable');
    expect(document.querySelector('[data-testid="preset-editor-input-filament_diameter"]')).toBeNull();
    await click(document.querySelector('[data-testid="preset-editor-reset-category-filament"]'));
    const request=h.onMutate.mock.calls.at(-1)![0];if(request.action!=='reset-category')throw Error('reset');
    expect(request.fields.map(field=>field.key)).not.toContain('filament_diameter');
    expect(request.fields).toContainEqual({key:'filament_flow_ratio',kind:'indexed',index:5});
  });
  it('shows two selectable Filament sections with modified candidates highlighted', async () => {
    const base = snapshotFor('filament');
    const snapshot: PresetDraftSnapshot = { ...base, editorCandidates: [
      { canonicalName: 'Modified supported', label: 'Modified supported', isProjectEmbedded: false, isUser: false, compatible: true, modified: true },
      { canonicalName: base.canonicalName, label: base.canonicalName, isProjectEmbedded: false, isUser: false, compatible: true, modified: false },
      { canonicalName: 'Modified unsupported', label: 'Modified unsupported', isProjectEmbedded: false, isUser: false, compatible: false, modified: true },
      { canonicalName: 'Unsupported', label: 'Unsupported', isProjectEmbedded: false, isUser: false, compatible: false, modified: false },
    ] };
    const onSelectPreset = vi.fn(async () => {});
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const platform = { preferences: { load: async () => structuredClone(DEFAULT_USER_PREFERENCES), save: async () => {} } } as unknown as PlatformCapabilities;
    await act(async () => root.render(<PlatformProvider value={platform}><PresetEditorDialogContent target={snapshot} snapshot={snapshot}
      onClose={vi.fn()} onMutate={vi.fn()} onSelectPreset={onSelectPreset} /></PlatformProvider>));
    await click(document.querySelector('[data-testid="preset-editor-preset"]'));
    const groups = [...document.querySelectorAll('[data-slot="select-group"]')].filter(group =>
      group.querySelector(':scope > [data-slot="select-label"]')?.textContent !== 'System presets');
    expect(groups.map(group => group.querySelector('[data-slot="select-label"]')?.textContent)).toEqual([
      'Compatible with project printer', 'Not compatible with project printer',
    ]);
    expect(groups.map(group => group.querySelector('[role="option"]')?.textContent)).toEqual([
      'Modified supported', 'Modified unsupported',
    ]);
    expect(document.querySelector('[title="Modified unsupported"] .config-override-label')).not.toBeNull();
    expect(document.querySelector('[role="option"][title="Modified unsupported"]')?.textContent).toBe('Modified unsupported');
    expect(document.body.textContent).not.toContain('Short alias');
    await click(document.querySelector('[role="option"][title="Unsupported"]'));
    expect(onSelectPreset).toHaveBeenCalledWith('Unsupported');
  });

  it('uses native physical/variant/motion bindings for SF/HF values, edits, resets, tooltips and search', async()=>{
    const source=u1Fixture(); const h=await controlledPrinter(source);
    await selectExtruder(3);
    expect(document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]')).toHaveProperty('value','0.6');
    let input=document.querySelector('[data-testid="preset-editor-input-retraction_length"]') as HTMLInputElement;
    expect(input.value).toBe('1.2');
    expect(document.querySelector('[data-testid="preset-editor-source-retraction_length"]')?.textContent).toBe('1.2');
    expect(document.querySelector('[data-testid="preset-editor-field-retraction_length"]')?.getAttribute('title')).toContain('retraction_length[4]');
    await changeInput(input,'2.4');await press(input,'Enter');
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'set-element',key:'retraction_length',index:4,value:2.4}));
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('true');
    await selectFlow(3,'HF');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value','1.3');
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('false');
    await enterSearch('retraction_length');
    expect(document.querySelectorAll('[data-testid="preset-editor-input-retraction_length"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-field-retraction_length"]')?.getAttribute('title')).toContain('retraction_length[5]');
    await enterSearch('');
    await click(document.querySelector('[data-testid="preset-editor-page-tab-motion-ability"]'));
    input=document.querySelector('[data-testid="preset-editor-input-machine_max_speed_e"]') as HTMLInputElement;
    expect(input.value).toBe('110');
    await changeInput(input,'210');await press(input,'Enter');
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({key:'machine_max_speed_e',index:10,value:210}));
    await click(document.querySelector('[data-testid="preset-editor-reset-field-machine_max_speed_e"]'));
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-field',key:'machine_max_speed_e',index:10}));
    await selectFlow(3,'SF');
    expect(document.querySelector('[data-testid="preset-editor-input-machine_max_speed_e"]')).toHaveProperty('value','108');
    expect(document.body.textContent).not.toMatch(/Silent/);
    await selectExtruder(3);await click(document.querySelector('[data-testid="preset-editor-reset-field-retraction_length"]'));
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-field',key:'retraction_length',index:4}));
  });

  it('keeps per-nozzle flows local, hides shared-only categories and opens an unselected popup without selecting it',async()=>{
    const source=u1Fixture();const h=await controlledPrinter(source);
    expect(document.querySelector('[data-testid="preset-editor-field-nozzle_type"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-extruder-switch"]')).toBeNull();
    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    expect(document.querySelector('[data-testid="preset-editor-group-multimaterial-material-defaults"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-field-default_filament_profile"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-extruder-switch"]')).toBeNull();
    await selectExtruder(3);
    expect(document.querySelector('[data-testid="preset-editor-field-nozzle_type"]')).not.toBeNull();
    await click(document.querySelector('[data-testid="preset-editor-flow-2"]'));
    expect(document.querySelector('[data-testid="preset-editor-extruder-3"]')?.getAttribute('aria-pressed')).toBe('true');
    await press(document.querySelector('[data-testid="preset-editor-flow-2"]')!,'Escape');
    await selectFlow(2,'SF');
    expect(document.querySelector('[data-testid="preset-editor-extruder-2"]')?.getAttribute('aria-pressed')).toBe('true');
    await selectFlow(3,'HF');await click(document.querySelector('[data-testid="preset-editor-extruder-2"]'));
    expect(document.querySelector('[data-testid="preset-editor-flow-2"]')?.textContent).toContain('SF');
    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    expect(document.querySelector('[data-testid="preset-editor-extruder-switch"]')).toBeNull();
    await click(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]'));
    await click(document.querySelector('[data-testid="preset-editor-extruder-3"]'));
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    expect(h.onMutate).not.toHaveBeenCalled();expect(h.getSnapshot()).toEqual(source);
  });

  it('initializes active entries from native hints, carries inactive choices, and preserves valid view on receipts/history',async()=>{
    const source=u1Fixture();const h=await controlledPrinter(source);
    await selectExtruder(2);
    expect(document.querySelector('[data-testid="preset-editor-flow-2"]')?.textContent).toContain('HF');
    // Head 3's native initial hint is SF even when the project flow was Hybrid.
    await selectFlow(3,'HF');
    await h.update({...source,revision:2,editorSelection:{...source.editorSelection,nozzles:source.editorSelection.nozzles.map(n=>({...n,initialChoiceId:`head-${n.extruderIndex}-0`}))}});
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    await h.update(u1Fixture({name:'Other U1',active:false,defaults:[0,0,0,0]}),1);
    expect(document.querySelector('[data-testid="preset-editor-extruder-3"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    await h.update(u1Fixture({name:'SF only',active:false,flows:[0]}),2);
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('SF');
    await h.update(u1Fixture({name:'HF default',active:false,flows:[1],defaults:[1,1,1,1]}),3);
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    await h.update(source,4);
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('SF');
    expect(document.querySelector('[data-testid="preset-editor-flow-2"]')?.textContent).toContain('HF');
    await selectFlow(3,'HF');await h.update({...source,revision:3});
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    await h.update(u1Fixture({name:'Single',active:false,count:1,flows:[0]}),5);
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.textContent).toBe('Extruder');
    expect(document.querySelector('[data-testid="preset-editor-extruder-switch"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value','0.8');
    await h.update(u1Fixture({name:'Single dual',active:false,count:1}),6);
    expect(document.querySelector('[data-testid="preset-editor-flow-1"]')?.getAttribute('aria-label')).toBe('Printer editing flow');
    expect(document.querySelector('[data-testid="preset-editor-extruder-1"]')).toBeNull();
    await selectFlow(1,'High Flow');
    await h.update(null);await h.update(source,7);
    await click(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]'));
    expect(document.querySelector('[data-testid="preset-editor-extruder-1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(h.onMutate).not.toHaveBeenCalled();
  });

  it('keeps unavailable mappings read-only and excludes them from atomic reset while valid short vectors use Source fallback',async()=>{
    const source=u1Fixture();
    const ret=source.editorSelection.fieldBindings.retraction_length;
    if(ret.kind!=='per_selection')throw Error('mapping');
    const snapshot:PresetDraftSnapshot={...source,overrides:{emit_machine_limits_to_gcode:'0'},
      effectiveValues:{...source.effectiveValues,emit_machine_limits_to_gcode:'0'},
      editorVectors:{...source.editorVectors,nozzle_diameter:{...source.editorVectors.nozzle_diameter,sourceValues:[0.4],effectiveValues:[0.5],
          overrideValues:[null,null,{value:0.5},null]},
        machine_max_speed_e:{...source.editorVectors.machine_max_speed_e,overrideValues:Array.from({length:16},(_,i)=>i===10?{value:110}:null)}},
      editorSelection:{...source.editorSelection,fieldBindings:{...source.editorSelection.fieldBindings,
        retraction_length:{kind:'per_selection',bindings:ret.bindings.map((b,i)=>i===5?{kind:'unavailable'}:b)}}}};
    const h=await controlledPrinter(snapshot);await selectExtruder(3);await selectFlow(3,'HF');
    expect(document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]')).toHaveProperty('value','0.5');
    expect(document.querySelector('[data-testid="preset-editor-source-nozzle_diameter"]')?.textContent).toBe('0.4');
    expect(document.querySelector('[data-testid="preset-editor-effective-retraction_length"]')?.textContent).toBe('Unavailable');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-field-retraction_length"]')?.getAttribute('title')).not.toContain('Default:');
    await click(document.querySelector('[data-testid="preset-editor-reset-category-extruder"]'));
    const reset=h.onMutate.mock.calls.at(-1)![0];
    expect(reset).toMatchObject({action:'reset-category',fields:expect.arrayContaining([{key:'nozzle_diameter',kind:'indexed',index:2}])});
    if(reset.action!=='reset-category')throw Error('expected category');
    expect(reset.fields.map(field=>field.key)).not.toContain('retraction_length');
    await click(document.querySelector('[data-testid="preset-editor-page-tab-motion-ability"]'));
    // The explicit motion value equals Source; ownership, rather than value
    // inequality, drives all three levels of highlighting.
    for(const id of ['preset-editor-option-label-machine_max_speed_e','preset-editor-group-title-motion-ability-speed-limitation','preset-editor-page-tab-motion-ability']) {
      const element=document.querySelector(`[data-testid="${id}"]`)??document.getElementById(id);
      expect(element?.getAttribute('data-draft-override-highlight')).toBe('true');
    }
    await click(document.querySelector('[data-testid="preset-editor-reset-category-motion-ability"]'));
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-category',fields:expect.arrayContaining([
      {key:'machine_max_speed_e',kind:'indexed',index:10},{key:'emit_machine_limits_to_gcode',kind:'shared'},
    ])}));
    expect(h.getSnapshot().editorVectors.machine_max_speed_e.overrideValues[10]).toBeNull();
  });

  it.each([true,false])('navigates once during invalid/pending edits and keeps delayed receipt feedback on its captured binding (success=%s)',async success=>{
    const source=u1Fixture();let complete!:(result:PresetDraftMutationResult)=>void;
    const h=await controlledPrinter(source,()=>new Promise(resolve=>{complete=resolve;}));
    await selectExtruder(3);
    let input=document.querySelector('[data-testid="preset-editor-input-retraction_length"]') as HTMLInputElement;
    await changeInput(input,'bad');await press(input,'Enter');
    expect(document.querySelector('[data-testid="preset-editor-error-retraction_length"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-preset"]')).toHaveProperty('disabled',true);
    await selectFlow(3,'HF');
    expect(h.onMutate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="preset-editor-error-retraction_length"]')).toBeNull();
    await selectFlow(3,'SF');
    input=document.querySelector('[data-testid="preset-editor-input-retraction_length"]') as HTMLInputElement;
    expect(input.value).toBe('1.2');await changeInput(input,'2.4');
    await act(async()=>input.blur());
    expect(h.onMutate).toHaveBeenCalledOnce();
    const captured=h.onMutate.mock.calls[0][0];
    expect(captured).toMatchObject({canonicalName:source.canonicalName,key:'retraction_length',index:4,value:2.4});
    await click(document.querySelector('[data-testid="preset-editor-extruder-1"]'));
    await selectFlow(1,'HF');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value','0.9');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('disabled',true);
    await act(async()=>complete(success?mutationSuccess(source,captured):{ok:false,error:'Rejected old binding'}));
    expect(document.querySelector('[data-testid="preset-editor-extruder-1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value','0.9');
    expect(document.querySelector('[data-testid="preset-editor-error-retraction_length"]')).toBeNull();
    await selectFlow(3,'SF');
    expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value',success?'2.4':'1.2');
  });

  it('reads and edits each Extruder index, preserving other values and indexing search/tooltips', async () => {
    const base = snapshotFor('printer');
    const makeVector = (values: number[]): PresetDraftEditorVector => ({ ...base.editorBindings.nozzle_diameter!, indexCount: values.length, overrideValues: values.map(() => null), sourceValues: values, effectiveValues: values });
    let current: PresetDraftSnapshot = { ...base,
      sourceValues: { ...base.sourceValues, nozzle_diameter: '[0.4,0.4,0.6,0.6]', min_layer_height: '[0.08,0.08,0.12,0.12]' },
      effectiveValues: { ...base.effectiveValues, nozzle_diameter: '[0.4,0.4,0.6,0.6]', min_layer_height: '[0.08,0.08,0.12,0.12]' },
      editorBindings: { ...base.editorBindings, nozzle_diameter: { ...base.editorBindings.nozzle_diameter!, elementCount: 4 } },
      optionMetadata: { ...base.optionMetadata, min_layer_height: { type: 'floats', label: 'Minimum layer height', tooltip_default: '0.08,0.08,0.12,0.12' } },
      editorVectors: { nozzle_diameter: makeVector([0.4, 0.4, 0.6, 0.6]), min_layer_height: makeVector([0.08, 0.08, 0.12, 0.12]) },
    };
    const requests: PresetDraftMutationRequest[] = [];
    await mount(current, vi.fn(), undefined, async request => {
      requests.push(request); const result = mutationSuccess(current, request); if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates }; return result;
    });
    await selectExtruder(3);
    expect(document.querySelector('[data-testid="preset-editor-effective-nozzle_diameter"]')?.textContent).toBe('0.6');
    expect(document.querySelector('[data-testid="preset-editor-effective-min_layer_height"]')?.textContent).toBe('0.12');
    expect(document.querySelector('[data-testid="preset-editor-field-min_layer_height"]')?.getAttribute('title')).toContain('min_layer_height[2]');
    expect(document.querySelector('[data-testid="preset-editor-field-min_layer_height"]')?.getAttribute('title')).toContain('Default: 0.12');
    const input = document.querySelector('[data-testid="preset-editor-input-min_layer_height"]') as HTMLInputElement;
    await changeInput(input, '0.15'); await press(input, 'Enter');
    expect(requests.at(-1)).toMatchObject({ action: 'set-element', key: 'min_layer_height', index: 2, value: 0.15 });
    expect(current.editorVectors?.min_layer_height.effectiveValues).toEqual([0.08, 0.08, 0.15, 0.12]);
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('true');
    await selectExtruder(1);
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('false');
    await selectExtruder(3);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-min_layer_height"]'));
    expect(requests.at(-1)).toMatchObject({ action: 'reset-field', key: 'min_layer_height', index: 2 });
    expect(current.editorVectors?.min_layer_height.effectiveValues).toEqual([0.08, 0.08, 0.12, 0.12]);
    await enterSearch('nozzle_diameter');
    expect([...document.querySelectorAll('[data-testid="preset-editor-effective-nozzle_diameter"]')].map(node => node.textContent)).toEqual(['0.6']);
  });

  it.each(['reset-field', 'reset-category'] as const)('highlights explicit equal-value vector overrides until %s', async action => {
    const base = snapshotFor('printer');
    const nozzles = [0.4, 0.6];
    let current: PresetDraftSnapshot = { ...base, modified: true,
      overrides: { nozzle_diameter: [null, {value: 0.6}] },
      sourceValues: { ...base.sourceValues, nozzle_diameter: JSON.stringify(nozzles) },
      editorVectors: { ...base.editorVectors,
        nozzle_diameter: { ...base.editorVectors.nozzle_diameter!, sourceValues: nozzles, overrideValues: [null, {value: 0.6}] } },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates };
      return result;
    });
    await mount(current, vi.fn(), undefined, onMutate);
    await selectExtruder(2);
    expect((document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]') as HTMLInputElement).value).toBe('0.6');
    expect(document.querySelector('[data-testid="preset-editor-option-label-nozzle_diameter"]')?.getAttribute('data-draft-override-highlight')).toBe('true');
    for (const index of [2])
      expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('true');
    const reset = document.querySelector('[data-testid="preset-editor-reset-category-extruder"]') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    await click(action === 'reset-field' ? document.querySelector('[data-testid="preset-editor-reset-field-nozzle_diameter"]') : reset);
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action,
      ...(action === 'reset-field' ? { key: 'nozzle_diameter', index: 1 } : { fields: expect.arrayContaining([{key: 'nozzle_diameter', kind: 'indexed', index: 1}]) }) }));
    expect(current).toMatchObject({ modified: false, draftExists: true, overrides: {} });
    expect(document.querySelector('[data-testid="preset-editor-option-label-nozzle_diameter"]')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(document.querySelector('[data-testid="preset-editor-reset-field-nozzle_diameter"]')).toBeNull();
    expect(reset.disabled).toBe(true);
    expect((document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]') as HTMLInputElement).value).toBe('0.6');
  });

  it('disables the current page Reset while another index remains explicitly overridden', async () => {
    const base = snapshotFor('printer');
    let current: PresetDraftSnapshot = {...base, modified: true,
      overrides: {nozzle_diameter: [{value: 0.4}, {value: 0.6}]},
      sourceValues: {...base.sourceValues, nozzle_diameter: '[0.4,0.6]'},
      editorVectors: {...base.editorVectors, nozzle_diameter: {...base.editorVectors.nozzle_diameter,
        sourceValues: [0.4,0.6], overrideValues: [{value: 0.4}, {value: 0.6}]}}};
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request); if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates }; return result;
    });
    await mount(current, vi.fn(), undefined, onMutate);
    await selectExtruder(2);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-nozzle_diameter"]'));
    expect(current.overrides.nozzle_diameter).toEqual([{value: 0.4}, null]);
    expect(current.modified).toBe(true);
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(document.querySelector('[data-testid="preset-editor-reset-field-nozzle_diameter"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-category-extruder"]') as HTMLButtonElement).disabled).toBe(true);
    await selectExtruder(1);
    expect((document.querySelector('[data-testid="preset-editor-reset-category-extruder"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the selected Extruder page when a mutation resolves a new canonical Printer source', async () => {
    let current = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = { ...result, canonicalName: 'Printer Resolved', editorCandidates: [
        ...(result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates).filter(candidate => candidate.canonicalName !== 'Printer Resolved'),
        { canonicalName: 'Printer Resolved', label: 'Printer Resolved', isProjectEmbedded: false, isUser: false, compatible: true, modified: true },
      ] };
      return result.ok ? { ...result, ...current, editorCandidates: { kind: 'replace' as const, items: current.editorCandidates } } : result;
    });
    await mount(current, vi.fn(), undefined, onMutate);
    await selectExtruder(2);
    const input = document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]') as HTMLInputElement;
    await changeInput(input, '0.4'); await press(input, 'Enter');
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Resolved');
    expect(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]')?.getAttribute('aria-selected')).toBe('true');
    const resolvedInput = document.querySelector('[data-testid="preset-editor-input-nozzle_diameter"]') as HTMLInputElement;
    expect(resolvedInput.value).toBe('0.4');
    await changeInput(resolvedInput, '0.5'); await press(resolvedInput, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ canonicalName: 'Printer Resolved', index: 1, value: 0.5 }));
  });

  it('uses first-element fallback and submits one coordinate or polygon at the selected index', async () => {
    const base = snapshotFor('printer');
    const coords = { ...base.editorBindings.nozzle_diameter!, scalarType: 'point' as const, indexCount: 2, overrideValues: [null, null],
      sourceValues: [{ x: 1, y: 2 }], effectiveValues: [{ x: 1, y: 2 }] };
    const polygon = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 200 }];
    let current: PresetDraftSnapshot = { ...base, editorVectors: { ...base.editorVectors, extruder_offset: coords,
      extruder_printable_area: { ...coords, scalarType: 'points', indexCount: 2, sourceValues: [], effectiveValues: [] } } };
    const requests: PresetDraftMutationRequest[] = [];
    await mount(current, vi.fn(), undefined, async request => {
      requests.push(request); const result = mutationSuccess(current, request); if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates }; return result;
    });
    await selectExtruder(2);
    const input = document.querySelector('[data-testid="preset-editor-input-extruder_offset"]') as HTMLInputElement;
    expect(input.value).toBe('1, 2');
    await changeInput(input, '3, 4'); await press(input, 'Enter');
    expect(requests.at(-1)).toMatchObject({ action: 'set-element', scalarType: 'point', index: 1, value: { x: 3, y: 4 } });
    const area = document.querySelector('[data-testid="preset-editor-input-extruder_printable_area"]') as HTMLTextAreaElement;
    await changeTextarea(area, polygon.map(point => `${point.x}, ${point.y}`).join('\n'));
    await act(async () => area.blur());
    expect(requests.at(-1)).toMatchObject({ action: 'set-element', scalarType: 'points', index: 1, value: polygon });
    await click(document.querySelector('[data-testid="preset-editor-reset-category-extruder"]'));
    expect(requests.at(-1)).toMatchObject({ action: 'reset-category', fields: expect.arrayContaining([{key: 'extruder_offset', kind: 'indexed', index: 1}]) });
  });

  it.each([FILAMENT_PRESET_EDITOR_MANIFEST, PRINTER_PRESET_EDITOR_MANIFEST])(
    'renders the declared page, group, and field order for $kind',
    async (manifest) => {
      await mount(snapshotFor(manifest.kind));
      const pageTabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
        .map((tab) => tab.textContent ?? '');
      expect(pageTabs).toEqual(manifest.pages.map(page => manifest.kind === 'printer' && page.id === 'extruder' ? 'Extruders' : page.title));

      for (const [pageIndex, page] of manifest.pages.entries()) {
        const pageId = page.id;
        if (pageIndex > 0 || page.id === 'extruder')
          await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        expect(groupHeadings(pageId)).toEqual(page.groups.map((optionGroup) => optionGroup.title));
        expect(visibleFieldKeys(pageId)).toEqual(page.groups.flatMap((optionGroup) => optionGroup.fields.map((field) => field.key)));
      }
    },
  );

  it('keeps one Printer Extruder page and selects native physical choices', async () => {
    const source = snapshotFor('printer');
    const template = PRINTER_PRESET_EDITOR_MANIFEST.pages.find((page) => page.id === 'extruder');
    if (!template) throw new Error('expected the explicit Printer Extruder page template');

    await mount(source);
    const pageTabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')]
      .map((tab) => tab.textContent ?? '');
    expect(pageTabs).toEqual(PRINTER_PRESET_EDITOR_MANIFEST.pages.map(page => page.id === 'extruder' ? 'Extruders' : page.title));

    for (const index of [1, 2]) {
      const pageId = 'extruder';
      await selectExtruder(index);
      expect(groupHeadings(pageId)).toEqual(template.groups.map((optionGroup) => optionGroup.title));
      expect(visibleFieldKeys(pageId)).toEqual(template.groups.flatMap((optionGroup) =>
        optionGroup.fields.map((field) => field.key)));
      expect(document.querySelector('[data-testid="preset-editor-context-nozzle_diameter"]')?.textContent)
        .toContain('Extruders / Basic information');
      expect(document.querySelector('[data-testid="preset-editor-field-nozzle_diameter"]')?.getAttribute('data-field-access'))
        .toBe('editable');
    }
  });

  it('shows source and effective values while only showing the draft marker for modified state', async () => {
    await mount(snapshotFor('printer', { draftExists: true, modified: false }));
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Canonical');
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-source-printable_height"]')?.textContent).toBe('230');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');
    expect(document.querySelector('[data-testid="preset-editor-field-printable_height"]')?.getAttribute('data-native-min')).toBe('1');
    expect(document.querySelector('[data-testid="preset-editor-field-printable_height"]')?.getAttribute('data-native-max')).toBe('1000');
    expect(document.querySelector('[data-testid="preset-editor-field-printable_height"]')?.getAttribute('title'))
      .toBe('Height of the build volume\n\nparameter name: printable_height\n\nDefault: 230\nRange: [1, 1000]');
  });

  it('highlights overridden options, groups, and page tabs and clears only the reset category', async () => {
    const base = snapshotFor('printer', { modified: true });
    const source: PresetDraftSnapshot = {
      ...base,
      overrides: { ...base.overrides, printer_plugin_config_overrides: 'custom-plugin-config', machine_start_gcode: 'G28' },
      effectiveValues: { ...base.effectiveValues, printer_plugin_config_overrides: 'custom-plugin-config', machine_start_gcode: 'G28' },
    };
    let current = source;
    await mount(source, vi.fn(), undefined, async (request) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates };
      return result;
    });

    const label = (key: string) => document.querySelector(`[data-testid="preset-editor-option-label-${key}"]`);
    for (const key of ['printable_height', 'printer_plugin_config_overrides']) {
      expect(label(key)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(label(key)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(label('printer_agent')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(label('printer_agent')?.classList.contains('config-override-label')).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-control-printable_height"]')?.classList.contains('config-override-label')).toBe(false);

    const tab = (page: string) => document.querySelector(`[data-testid="preset-editor-page-tab-${page}"]`);
    const group = (page: string, id: string) => document.querySelector(`[data-testid="preset-editor-group-title-${page}-${id}"]`);
    for (const page of ['basic-information', 'machine-gcode']) {
      expect(tab(page)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(tab(page)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(tab('motion-ability')?.getAttribute('data-draft-override-highlight')).toBe('false');
    for (const id of ['plugin-configuration', 'printable-space']) {
      expect(group('basic-information', id)?.getAttribute('data-draft-override-highlight')).toBe('true');
      expect(group('basic-information', id)?.classList.contains('config-override-label')).toBe(true);
    }
    expect(group('basic-information', 'advanced')?.getAttribute('data-draft-override-highlight')).toBe('false');

    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(label('printable_height')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(group('basic-information', 'printable-space')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(group('basic-information', 'plugin-configuration')?.getAttribute('data-draft-override-highlight')).toBe('true');
    expect(tab('basic-information')?.getAttribute('data-draft-override-highlight')).toBe('true');

    await click(document.querySelector('[data-testid="preset-editor-reset-category-basic-information"]'));
    for (const key of ['printable_height', 'printer_plugin_config_overrides']) {
      expect(label(key)?.getAttribute('data-draft-override-highlight')).toBe('false');
      expect(label(key)?.classList.contains('config-override-label')).toBe(false);
    }
    expect(tab('basic-information')?.getAttribute('data-draft-override-highlight')).toBe('false');
    expect(tab('machine-gcode')?.getAttribute('data-draft-override-highlight')).toBe('true');
    for (const id of ['plugin-configuration', 'printable-space']) {
      expect(group('basic-information', id)?.getAttribute('data-draft-override-highlight')).toBe('false');
    }

    await click(tab('machine-gcode'));
    expect(group('machine-gcode', 'machine-start-gcode')?.getAttribute('data-draft-override-highlight')).toBe('true');
    expect(group('machine-gcode', 'file-header-gcode')?.getAttribute('data-draft-override-highlight')).toBe('false');
  });

  it('marks a modified draft and lists the numbered slots sharing its Filament source', async () => {
    await mount(snapshotFor('filament', { modified: true }), vi.fn(), [3, 1, 3]);
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')?.textContent).toBe('Project draft');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_flow_ratio"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_flow_ratio"]')?.textContent).toBe('0.92');
    expect(document.querySelector('[data-testid="preset-editor-slot-reference"]')?.textContent)
      .toBe('Used by slot 1 and slot 3. Editing this source affects those slots.');
  });

  it('searches keys, native labels, and tooltips across pages while retaining their context', async () => {
    await mount(snapshotFor('printer'));

    await enterSearch('printer_notes');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-printer_notes"]')?.textContent)
      .toContain('Notes / Notes');

    await enterSearch('Printer Agent');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-printer_agent"]')?.textContent)
      .toContain('Basic information / Advanced');

    await enterSearch('Distinctive machine start help text');
    expect(document.querySelectorAll('[data-testid^="preset-editor-field-"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-context-machine_start_gcode"]')?.textContent)
      .toContain('Machine G-code / Machine start G-code');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click());
    expect(document.querySelector<HTMLInputElement>('[data-testid="preset-editor-search"]')!.value).toBe('');
    expect(document.activeElement).toBe(document.querySelector('[data-testid="preset-editor-search"]'));
    expect(document.querySelector('[aria-label="Clear search"]')).toBeNull();
    expect(document.querySelector('[role="tablist"][aria-label="Preset setting pages"]')).toBeTruthy();
  });

  it.each([
    { key: 'bed_temperature_formula', page: 'multimaterial', values: ['by_highest_temp', 'by_first_filament'], labels: ['By Highest Temp', 'By First filament'] },
    { key: 'gcode_flavor', page: 'basic-information', values: ['marlin', 'klipper'], labels: ['Marlin', 'Klipper'] },
  ])('shows scalar enum labels before opening and writes raw values for $key', async ({ key, page, values, labels }) => {
    const base = snapshotFor('printer');
    const source: PresetDraftSnapshot = { ...base,
      sourceValues: { ...base.sourceValues, [key]: values[0] },
      effectiveValues: { ...base.effectiveValues, [key]: values[0] },
      optionMetadata: { ...base.optionMetadata, [key]: { type: 'enum', label: key,
        enum_values: values, enum_labels: labels } },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector(`[data-testid="preset-editor-page-tab-${page}"]`));
    const trigger = () => document.querySelector(`[data-testid="preset-editor-input-${key}"]`);
    expect(trigger()?.textContent).toContain(labels[0]);
    expect(trigger()?.textContent).not.toContain(values[0]);
    expect(document.querySelector(`[data-testid="preset-editor-source-${key}"]`)?.textContent).toBe(labels[0]);
    expect(document.querySelector(`[data-testid="preset-editor-effective-${key}"]`)?.textContent).toBe(labels[0]);
    await click(trigger());
    await click([...document.querySelectorAll('[data-slot="select-item"]')].find(item => item.textContent === labels[1]) ?? null);
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set', key, value: values[1] }));
    expect(trigger()?.textContent).toContain(labels[1]);
    expect(document.querySelector(`[data-testid="preset-editor-effective-${key}"]`)?.textContent).toBe(labels[1]);
  });

  it('keeps specialized Printer fields visibly read-only', async () => {
    await mount(snapshotFor('printer'));
    expect(document.querySelector('[data-testid="preset-editor-group-basic-information-identity"]')).toBeNull();
    for (const key of ['printer_technology', 'printer_model', 'printer_variant'])
      expect(document.querySelector(`[data-testid="preset-editor-field-${key}"]`)).toBeNull();
    const cases = [
      ['printer_structure', 'basic-information'],
      ['printable_area', 'basic-information'],
    ] as const;
  let activePage = 'basic-information';
    for (const [key, pageId] of cases) {
      if (pageId !== activePage) {
        await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        activePage = pageId;
      }
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-field-access')).toBe('read-only');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
    }
  });

  it('keeps genuine lists and specialized controls visibly read-only', async () => {
    await mount(snapshotFor('filament'));
    const cases = [
      ['adaptive_pressure_advance_model', 'filament'],
      ['filament_ramming_parameters', 'multimaterial'],
      ['compatible_printers', 'dependencies'],
    ] as const;
    let activePage = 'filament';
    for (const [key, pageId] of cases) {
      if (pageId !== activePage) {
        await click(document.querySelector(`[data-testid="preset-editor-page-tab-${pageId}"]`));
        activePage = pageId;
      }
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-field-access')).toBe('read-only');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
    }
  });

  it('marks every unbound native vector type read-only, including percent, enum, float-or-percent, and colour vectors', async () => {
    const base = snapshotFor('filament');
    const vectorTypes: Record<string, OptionMeta['type']> = {
      filament_flow_ratio: 'floats',
      filament_adhesiveness_category: 'ints',
      filament_type: 'strings',
      filament_soluble: 'bools',
      filament_shrink: 'percents',
      overhang_fan_threshold: 'enums',
      filament_diameter: 'floats_or_percents',
      default_filament_colour: 'strings',
    };
    const editorBindings = { ...base.editorBindings };
    const optionMetadata = { ...base.optionMetadata };
    for (const [key, type] of Object.entries(vectorTypes)) {
      delete editorBindings[key];
      optionMetadata[key] = { ...optionMetadata[key], type };
    }
    await mount({ ...base, editorBindings, optionMetadata });

    for (const [key, type] of Object.entries(vectorTypes)) {
      await enterSearch(key);
      const field = document.querySelector(`[data-testid="preset-editor-field-${key}"]`);
      expect(field?.getAttribute('data-native-type')).toBe(type);
      expect(field?.getAttribute('aria-disabled')).toBe('true');
      expect(document.querySelector(`[data-testid="preset-editor-readonly-${key}"]`)?.textContent).toBe('Read only');
      expect(document.querySelector(`[data-testid="preset-editor-input-${key}"]`)).toBeNull();
    }
  });

  it('keeps one modal and one active source when the single target changes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const printerSnapshot = snapshotFor('printer');
    await act(async () => { root.render(<PresetEditorDialogContent target={{ kind: 'printer', canonicalName: printerSnapshot.canonicalName }} snapshot={printerSnapshot} onSelectPreset={async () => {}} onClose={vi.fn()} onMutate={vi.fn()} />); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Printer Canonical');

    const filamentSnapshot = snapshotFor('filament');
    const platform = { preferences: { load: async () => structuredClone(DEFAULT_USER_PREFERENCES), save: async () => {} } } as unknown as PlatformCapabilities;
    await act(async () => { root.render(<PlatformProvider value={platform}><PresetEditorDialogContent target={{ kind: 'filament', canonicalName: filamentSnapshot.canonicalName }} snapshot={filamentSnapshot} onSelectPreset={async () => {}} onClose={vi.fn()} onMutate={vi.fn()} /></PlatformProvider>); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Filament Canonical');
    expect(document.querySelectorAll('[data-testid="preset-editor-close"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="preset-editor-close"]')?.getAttribute('aria-label')).toBe('Close preset editor');
    expect(document.querySelector('[data-testid="preset-editor-close"] svg')).not.toBeNull();
    const visibleActions = [...document.querySelectorAll('[role="dialog"] button')].map((button) => button.textContent?.trim());
    expect(visibleActions).not.toContain('Close');
    expect(visibleActions).not.toEqual(expect.arrayContaining(['Save', 'Apply', 'Cancel']));
    expect(document.querySelector('[data-testid="preset-editor-search"]')?.getAttribute('type')).toBe('search');
  });

  it('closes through the sole dialog action', async () => {
    const onClose = vi.fn();
    await mount(snapshotFor('printer'), onClose);
    await click(document.querySelector('[data-testid="preset-editor-close"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('commits numeric and text controls only on Enter or blur and restores local text on Escape', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '250');
    expect(onMutate).not.toHaveBeenCalled();
    await press(height, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set', key: 'printable_height', value: '250' }));

    const notes = document.querySelector('[data-testid="preset-editor-input-time_cost"]') as HTMLInputElement;
    await changeInput(notes, 'local edit');
    expect(onMutate).toHaveBeenCalledOnce();
    await press(notes, 'Escape');
    expect(onMutate).toHaveBeenCalledOnce();
    expect(notes.value).toBe('source:time_cost');

    await changeInput(notes, 'blur commit');
    await act(async () => { notes.blur(); });
    expect(onMutate).toHaveBeenCalledTimes(2);
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set', key: 'time_cost', value: 'blur commit' }));
  });

  it('commits a bound float element and preserves the rest of the raw native vector', async () => {
    const source = snapshotFor('filament');
    let receipt: PresetDraftMutationResult | undefined;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      receipt = mutationSuccess(source, request);
      return receipt;
    });
    await mount(source, vi.fn(), undefined, onMutate);
    const diameter = document.querySelector('[data-testid="preset-editor-input-filament_diameter"]') as HTMLInputElement;
    await changeInput(diameter, '2.1');
    await press(diameter, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_diameter', scalarType: 'float', index: 0, value: 2.1 }));
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_diameter"]')?.textContent).toBe('2.1');
    expect(receipt?.ok && receipt.effectiveValues.filament_diameter).toBe(JSON.stringify([2.1, 2.85]));
  });

  it('rejects malformed scalar text locally and clamps a numeric value to native metadata bounds', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;

    await changeInput(height, '1.2junk');
    await press(height, 'Enter');
    expect(onMutate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="preset-editor-error-printable_height"]')?.textContent)
      .toBe('Enter a valid number.');

    await changeInput(height, '-5');
    await press(height, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'set', key: 'printable_height', value: '1',
    }));
    expect(height.value).toBe('1');
  });

  it('commits open enum text, native boolean, and colour vector elements', async () => {
    const source = snapshotFor('filament');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    const type = document.querySelector('[data-testid="preset-editor-input-filament_type"]') as HTMLInputElement;
    await changeInput(type, 'Custom PETG blend');
    await press(type, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_type', scalarType: 'string', index: 0, value: 'Custom PETG blend' }));

    await click(document.querySelector('[data-testid="preset-editor-input-filament_soluble"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_soluble', scalarType: 'bool', index: 0, value: true }));

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    await click(document.querySelector('[data-testid="preset-editor-input-default_filament_colour"]'));
    await changeInput(document.querySelector('input[aria-label="HEX color"]') as HTMLInputElement, '#223344');
    await act(async () => document.querySelector('input[aria-label="HEX color"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    const beforeColor = onMutate.mock.calls.length;
    await click([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Confirm')!);
    expect(onMutate.mock.calls.length).toBe(beforeColor + 1);
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'default_filament_colour', scalarType: 'string', index: 0, value: '#223344' }));
  });

  it('uses numeric native enum options, integer and percent element values, and a distinct nullable empty string', async () => {
    const sourceBase = snapshotFor('filament');
    const nullableNotes: PresetDraftEditorBinding = {
      ...sourceBase.editorBindings.filament_notes!, nullable: true, sourceValue: null, effectiveValue: null,
    };
    const source: PresetDraftSnapshot = {
      ...sourceBase,
      editorBindings: { ...sourceBase.editorBindings, filament_notes: nullableNotes },
      sourceValues: { ...sourceBase.sourceValues, filament_notes: JSON.stringify([null]) },
      effectiveValues: { ...sourceBase.effectiveValues, filament_notes: JSON.stringify([null]) },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-cooling"]'));
    const threshold = document.querySelector('[data-testid="preset-editor-input-overhang_fan_threshold"]');
    await click(threshold);
    const fiftyPercent = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === '50%');
    if (!fiftyPercent) throw new Error('expected native closed-enum option 50%');
    await act(async () => {
      fiftyPercent.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      fiftyPercent.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'overhang_fan_threshold', scalarType: 'enum', value: 3 }));

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    const adaptive=document.querySelector('[data-testid="preset-editor-input-filament_adaptive_volumetric_speed"]')!;
    expect(adaptive.getAttribute('role')).toBe('checkbox');expect(adaptive.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-testid^="preset-editor-null-"]')).toBeNull();
    const category = document.querySelector('[data-testid="preset-editor-input-filament_adhesiveness_category"]') as HTMLInputElement;
    await changeInput(category, '3');
    await press(category, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_adhesiveness_category', scalarType: 'int', value: 3 }));

    const shrink = document.querySelector('[data-testid="preset-editor-input-filament_shrink"]') as HTMLInputElement;
    await changeInput(shrink, '95');
    await press(shrink, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_shrink', scalarType: 'percent', value: 95 }));
    expect(document.querySelector('[data-testid="preset-editor-input-filament_shrink"]')?.parentElement?.textContent)
      .toContain('%');

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    expect(document.querySelector('[data-testid="preset-editor-source-filament_notes"]')?.textContent).toBe('(null)');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(null)');
    const notes=document.querySelector('[data-testid="preset-editor-input-filament_notes"]') as HTMLTextAreaElement;
    expect(notes.disabled).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-null-filament_notes"]')).toBeNull();
    await changeTextarea(notes,'temporary');await changeTextarea(notes,'');await press(notes,'Enter',{ctrlKey:true});
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_notes', scalarType: 'string', value: '' }));
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(empty)');
  });

  it.each(['printer','filament'] as const)('keeps ordinary nullable %s numbers editable without nil toggles or blank-to-nil writes',async kind=>{
    const base=kind==='printer'?u1Fixture():filamentVariantsFixture();
    const key=kind==='printer'?'retraction_length':'filament_flow_ratio';
    const index=kind==='printer'?4:1;
    const vector=base.editorVectors[key];
    const values=vector.sourceValues.map((value,i)=>i===index?null:value);
    const snapshot={...base,sourceValues:{...base.sourceValues,[key]:JSON.stringify(values)},effectiveValues:{...base.effectiveValues,[key]:JSON.stringify(values)},
      editorVectors:{...base.editorVectors,[key]:{...vector,nullable:true,sourceValues:values,effectiveValues:values}}};
    const h=await controlledPrinter(snapshot);
    if(kind==='printer'){await click(document.querySelector('[data-testid="preset-editor-page-tab-extruder"]'));await selectExtruder(3);}
    else {await click(document.querySelector('[data-testid="preset-editor-variant"]'));await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent==='Direct Drive High Flow')!);}
    const input=()=>document.querySelector(`[data-testid="preset-editor-input-${key}"]`) as HTMLInputElement;
    expect(input().disabled).toBe(false);expect(input().value).toBe('');
    expect(document.querySelector('[data-testid^="preset-editor-null-"]')).toBeNull();
    expect([...document.querySelectorAll('label')].some(label=>label.textContent==='Null')).toBe(false);
    await act(async()=>{input().focus();input().blur();});expect(h.onMutate).not.toHaveBeenCalled();
    await changeInput(input(),'bad');await press(input(),'Enter');expect(h.onMutate).not.toHaveBeenCalled();
    await changeInput(input(),' ');await press(input(),'Enter');expect(h.onMutate).not.toHaveBeenCalled();
    expect(document.querySelector(`[data-testid="preset-editor-error-${key}"]`)?.textContent).toContain('valid number');
    expect(h.getSnapshot().editorVectors[key].effectiveValues).toEqual(values);
    await changeInput(input(),'1.8');await press(input(),'Enter');
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'set-element',key,index,value:1.8}));
    await click(document.querySelector(`[data-testid="preset-editor-reset-field-${key}"]`));
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-field',key,index}));
    expect(input().value).toBe('');expect(input().disabled).toBe(false);
    expect(h.getSnapshot().editorVectors[key].effectiveValues).toEqual(values);
  });

  it('retains boolean value checkboxes and native enum options without synthetic Not set choices',async()=>{
    const base=snapshotFor('filament');
    const enumBinding={...base.editorBindings.overhang_fan_threshold,nullable:true,sourceValue:null,effectiveValue:null};
    const snapshot={...base,editorBindings:{...base.editorBindings,overhang_fan_threshold:enumBinding}};
    const h=await controlledPrinter(snapshot);
    const checkbox=document.querySelector('[data-testid="preset-editor-input-filament_adaptive_volumetric_speed"]')!;
    expect(checkbox.getAttribute('role')).toBe('checkbox');expect(h.onMutate).not.toHaveBeenCalled();
    await click(checkbox);expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({key:'filament_adaptive_volumetric_speed',value:true}));
    await click(document.querySelector('[data-testid="preset-editor-page-tab-cooling"]'));
    await click(document.querySelector('[data-testid="preset-editor-input-overhang_fan_threshold"]'));
    expect([...document.querySelectorAll('[role="option"]')].map(option=>option.textContent)).toEqual(['0%','10%','25%','50%','75%','95%']);
    await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent==='50%')!);
    expect(h.onMutate).toHaveBeenLastCalledWith(expect.objectContaining({key:'overhang_fan_threshold',value:3}));
  });

  it('requires native context before unlocking dedicated Filament override fields',async()=>{
    const source=filamentVariantsFixture();const vector={...source.editorVectors.filament_flow_ratio,nullable:true,sourceValues:[null,null,null,null,null,null],effectiveValues:[null,null,null,null,null,null]};
    const h=await controlledPrinter({...source,sourceValues:{...source.sourceValues,filament_retraction_length:'nil'},effectiveValues:{...source.effectiveValues,filament_retraction_length:'nil'},
      optionMetadata:{...source.optionMetadata,filament_retraction_length:{type:'floats',label:'Retraction length'}},
      editorVectors:{...source.editorVectors,filament_retraction_length:vector},
      editorSelection:{...source.editorSelection,fieldBindings:{...source.editorSelection.fieldBindings,filament_retraction_length:source.editorSelection.fieldBindings.filament_flow_ratio}}});
    await click(document.querySelector('[data-testid="preset-editor-page-tab-setting-overrides"]'));
    const page=FILAMENT_PRESET_EDITOR_MANIFEST.pages.find(page=>page.id==='setting-overrides')!;
    expect(page.groups.flatMap(group=>group.fields).every(field=>field.filamentOverride)).toBe(true);
    expect(document.querySelector('[data-testid="preset-editor-readonly-filament_retraction_length"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="preset-editor-input-filament_retraction_length"]')).toBeNull();
    expect(document.querySelector('[data-testid^="preset-editor-null-"]')).toBeNull();expect(h.onMutate).not.toHaveBeenCalled();
  });

  it('keeps a native float-or-percent object distinct from a percent scalar', async () => {
    const base = snapshotFor('filament');
    // No currently loaded preset source exposes this vector type; this isolated
    // projection fixture exercises the generic binding contract itself.
    const floatOrPercent: PresetDraftEditorBinding = {
      ...base.editorBindings.filament_diameter!,
      scalarType: 'float_or_percent',
      elementCount: 1,
      sourceValue: { value: 0.5, percent: true },
      effectiveValue: { value: 0.5, percent: true },
    };
    const snapshot: PresetDraftSnapshot = {
      ...base,
      sourceValues: { ...base.sourceValues, filament_diameter: JSON.stringify([{ value: 0.5, percent: true }]) },
      effectiveValues: { ...base.effectiveValues, filament_diameter: JSON.stringify([{ value: 0.5, percent: true }]) },
      optionMetadata: { ...base.optionMetadata, filament_diameter: { type: 'float_or_percent' } },
      editorBindings: { ...base.editorBindings, filament_diameter: floatOrPercent },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(snapshot, request));
    await mount(snapshot, vi.fn(), undefined, onMutate);
    const input = document.querySelector('[data-testid="preset-editor-input-filament_diameter"]') as HTMLInputElement;
    expect(input.value).toBe('0.5');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_diameter"]')?.textContent).toBe('0.5%');
    expect(document.querySelector('[data-testid="preset-editor-unit-filament_diameter"]')?.textContent?.toLowerCase()).toContain('percent');
    await changeInput(input, '1.25');
    await press(input, 'Enter');
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_diameter', scalarType: 'float_or_percent', value: { value: 1.25, percent: true } }));
  });

  it('edits Filament scripts in a multiline control and keeps the full source script visible', async () => {
    const source = snapshotFor('filament');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-page-tab-advanced"]'));
    const startGcode = document.querySelector('[data-testid="preset-editor-input-filament_start_gcode"]') as HTMLTextAreaElement;
    expect(startGcode.tagName).toBe('TEXTAREA');
    expect(startGcode.value).toBe('G28\nM104 S220\n');
    expect(document.querySelector('[data-testid="preset-editor-source-filament_start_gcode"]')?.textContent)
      .toBe('G28\nM104 S220\n');
    await changeTextarea(startGcode, 'G28\nM104 S205\nM140 S60\n');
    await act(async () => { startGcode.blur(); });
    expect(onMutate).toHaveBeenCalledWith(expect.objectContaining({ action: 'set-element',
      key: 'filament_start_gcode', scalarType: 'string', index: 0, value: 'G28\nM104 S205\nM140 S60\n' }));
  });

  it('sends explicit field and category reset scopes and a title reset-preset command', async () => {
    const sourceBase = snapshotFor('printer', { modified: true });
    const source: PresetDraftSnapshot = {
      ...sourceBase,
      overrides: { ...sourceBase.overrides, printer_plugin_config_overrides: 'custom-plugin-config' },
      effectiveValues: { ...sourceBase.effectiveValues, printer_plugin_config_overrides: 'custom-plugin-config' },
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reset-field', key: 'printable_height' }));
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).not.toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');

    const activePage = PRINTER_PRESET_EDITOR_MANIFEST.pages[0]!;
    await click(document.querySelector(`[data-testid="preset-editor-reset-category-${activePage.id}"]`));
    expect(onMutate).toHaveBeenLastCalledWith({
      kind: 'printer', canonicalName: 'Printer Canonical', expectedRevision: 2,
      action: 'reset-category', fields: activePage.groups.flatMap((optionGroup) => optionGroup.fields.map((field) => ({key: field.key, kind: source.editorBindings[field.key] ? 'indexed' : 'shared', ...(source.editorBindings[field.key] ? {index: 0} : {})}))),
    });
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);

    await click(document.querySelector('[data-testid="preset-editor-reset-preset"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reset-preset' }));
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets quoted multiline Filament notes from the typed source binding without a follow-up set', async () => {
    const base = snapshotFor('filament');
    const sourceNotes = 'Source "notes" with quotes\nand a second line\n';
    const source: PresetDraftSnapshot = {
      ...base,
      sourceValues: { ...base.sourceValues, filament_notes: JSON.stringify([sourceNotes]) },
      effectiveValues: { ...base.effectiveValues, filament_notes: JSON.stringify([sourceNotes]) },
      editorBindings: {
        ...base.editorBindings,
        filament_notes: { ...base.editorBindings.filament_notes!, sourceValue: sourceNotes, effectiveValue: sourceNotes },
      },
    };
    let current = source;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates };
      return result;
    });
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    const notes = document.querySelector('[data-testid="preset-editor-input-filament_notes"]') as HTMLTextAreaElement;
    await changeTextarea(notes, 'Edited "notes"\nwith another line\n');
    await act(async () => { notes.blur(); });
    expect(notes.value).toBe('Edited "notes"\nwith another line\n');
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_notes"]'));

    expect(notes.value).toBe(sourceNotes);
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe(sourceNotes);
    expect(onMutate.mock.calls.map(([request]) => request.action)).toEqual(['set-element', 'reset-field']);
  });

  it('restores nullable text and percent controls from typed field reset bindings without extra sets', async () => {
    const base = snapshotFor('filament');
    const nullableNotes: PresetDraftEditorBinding = {
      ...base.editorBindings.filament_notes!, nullable: true, sourceValue: null, effectiveValue: null,
    };
    const source: PresetDraftSnapshot = {
      ...base,
      editorBindings: { ...base.editorBindings, filament_notes: nullableNotes },
      sourceValues: { ...base.sourceValues, filament_notes: JSON.stringify([null]) },
      effectiveValues: { ...base.effectiveValues, filament_notes: JSON.stringify([null]) },
    };
    let current = source;
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => {
      const result = mutationSuccess(current, request);
      if (result.ok) current = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : current.editorCandidates };
      return result;
    });
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-notes"]'));
    const notes = document.querySelector('[data-testid="preset-editor-input-filament_notes"]') as HTMLTextAreaElement;
    expect(notes.disabled).toBe(false);
    await changeTextarea(notes,'temporary');await changeTextarea(notes,'');await press(notes,'Enter',{ctrlKey:true});
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_notes"]'));
    expect(notes.value).toBe('');
    expect(document.querySelector('[data-testid="preset-editor-null-filament_notes"]')).toBeNull();
    expect(notes.disabled).toBe(false);
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_notes"]')?.textContent).toBe('(null)');

    await click(document.querySelector('[data-testid="preset-editor-page-tab-filament"]'));
    const shrink = document.querySelector('[data-testid="preset-editor-input-filament_shrink"]') as HTMLInputElement;
    await changeInput(shrink, '95');
    await press(shrink, 'Enter');
    await click(document.querySelector('[data-testid="preset-editor-reset-field-filament_shrink"]'));
    expect(shrink.value).toBe('100');
    expect(document.querySelector('[data-testid="preset-editor-effective-filament_shrink"]')?.textContent).toBe('100%');
    expect(onMutate.mock.calls.map(([request]) => request.action)).toEqual([
      'set-element', 'reset-field', 'set-element', 'reset-field',
    ]);
  });

  it.each([1, 2, 4])('edits the native virtual Extruders count %i', async (count) => {
    const base = snapshotFor('printer');
    const sourceValues = { ...base.sourceValues };
    const effectiveValues = { ...base.effectiveValues };
    const optionMetadata = { ...base.optionMetadata };
    sourceValues.extruders_count = '1';
    effectiveValues.extruders_count = String(count);
    await mount({
      ...base, sourceValues, effectiveValues, optionMetadata,
      editorVectors: {
        ...base.editorVectors,
        nozzle_diameter: {
          ...base.editorVectors.nozzle_diameter!,
          sourceValues: [0.4], effectiveValues: Array.from({ length: count }, () => 0.4),
          indexCount: count, overrideValues: Array.from({ length: count }, () => null),
        },
      },
    }, vi.fn());
    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    const label = document.querySelector('[data-testid="preset-editor-option-label-extruders_count"]');
    expect(label?.textContent).toBe('Extruders');
    expect(label?.getAttribute('title')).toContain('Number of extruders of the printer.');
    expect(document.querySelector('[data-testid="preset-editor-source-extruders_count"]')?.textContent).toBe('1');
    expect(document.querySelector('[data-testid="preset-editor-effective-extruders_count"]')?.textContent).toBe(String(count));
    expect((document.querySelector('[data-testid="preset-editor-input-extruders_count"]') as HTMLInputElement).value).toBe(String(count));
    const search = document.querySelector('[data-testid="preset-editor-search"]') as HTMLInputElement;
    await changeInput(search, 'Extruders');
    expect(document.querySelector('[data-testid="preset-editor-option-label-extruders_count"]')?.textContent).toBe('Extruders');
  });

  it('includes the native virtual count and capability-locked fields in one category reset', async () => {
    const base = snapshotFor('printer');
    const sourceValues: Record<string, string> = { ...base.sourceValues };
    const effectiveValues: Record<string, string> = { ...base.effectiveValues, manual_filament_change: '1' };
    const optionMetadata: Record<string, OptionMeta> = { ...base.optionMetadata };
    optionMetadata.extruders_count = { ...optionMetadata.extruders_count, readonly: true };
    const source: PresetDraftSnapshot = {
      ...base,
      sourceValues,
      effectiveValues,
      optionMetadata,
      overrides: { manual_filament_change: '1' },
      modified: true,
    };
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);

    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    await click(document.querySelector('[data-testid="preset-editor-reset-category-multimaterial"]'));
    const request = onMutate.mock.calls.at(-1)?.[0] as Extract<PresetDraftMutationRequest, { action: 'reset-category' }>;
    expect(request.action).toBe('reset-category');
    expect(request.fields.map(field => field.key)).toContain('single_extruder_multi_material');
    expect(request.fields.map(field => field.key)).toContain('manual_filament_change');
    expect(request.fields).toContainEqual({ key: 'extruders_count', kind: 'shared' });
  });

  it.each([true, false])('uses the native count lock %s independently of SEMM and head count', async (locked) => {
    const base = snapshotFor('printer');
    await mount({ ...base,
      effectiveValues: { ...base.effectiveValues, single_extruder_multi_material: '1' },
      optionMetadata: { ...base.optionMetadata, extruders_count: { ...base.optionMetadata.extruders_count, readonly: locked } },
    });
    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    expect(document.querySelector('[data-testid="preset-editor-input-single_extruder_multi_material"]')).not.toBeNull();
    const input = document.querySelector('[data-testid="preset-editor-input-extruders_count"]');
    expect(input === null).toBe(locked);
    expect(document.querySelector('[data-testid="preset-editor-field-extruders_count"]')?.getAttribute('data-field-access')).toBe(locked ? 'read-only' : 'editable');
    if (locked) expect(document.querySelector('[data-testid="preset-editor-field-extruders_count"]')?.textContent).toContain('Disable SEMM');
  });

  it('submits count edits and resets as one native structural command each', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-page-tab-multimaterial"]'));
    const input = document.querySelector('[data-testid="preset-editor-input-extruders_count"]') as HTMLInputElement;
    await changeInput(input, '4'); await press(input, 'Enter');
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'set',key:'extruders_count',value:'4'}));
    expect(input.value).toBe('4');
    await click(document.querySelector('[data-testid="preset-editor-reset-field-extruders_count"]'));
    expect(onMutate).toHaveBeenLastCalledWith(expect.objectContaining({action:'reset-field',key:'extruders_count'}));
    expect(input.value).toBe('1');
  });

  it('retains an empty draft after resetting its last field override', async () => {
    const source = snapshotFor('printer', { modified: true });
    const onMutate = vi.fn(async (request: PresetDraftMutationRequest) => mutationSuccess(source, request));
    await mount(source, vi.fn(), undefined, onMutate);
    await click(document.querySelector('[data-testid="preset-editor-reset-field-printable_height"]'));
    expect(document.querySelector('[data-testid="preset-editor-project-draft"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps rejected text visible with the native error and leaves effective state untouched', async () => {
    const source = snapshotFor('printer');
    const onMutate = vi.fn(async () => ({ ok: false as const, errorCode: 'stale_revision', error: 'stale native draft' }));
    await mount(source, vi.fn(), undefined, onMutate);
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '240');
    await press(height, 'Enter');
    expect(height.value).toBe('240');
    expect(document.querySelector('[data-testid="preset-editor-error-printable_height"]')?.textContent).toBe('stale native draft');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('230');
  });
});


describe('PresetEditorDialog session ownership', () => {
  beforeEach(() => {
    useHistoryRestoreStore.setState({ phase: 'idle', revision: 0, error: null });
    vi.mocked(commitPresetDraftMutation).mockReset();
  });

  async function mountSession(getPresetDraft: ReturnType<typeof vi.fn>, onClose = vi.fn()) {
    const base = snapshotFor('printer');
    const platform = {
      preferences: { load: async () => structuredClone(DEFAULT_USER_PREFERENCES), save: async () => {} },
      runtime: { getPresetDraft },
    } as unknown as PlatformCapabilities;
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const initialTarget = { kind: base.kind, canonicalName: base.canonicalName };
    const sceneInteraction = new SceneInteractionController(() => []);
    const render = () => act(async () => root.render(<PlatformProvider value={platform}>
      <PresetEditorDialog sceneInteraction={sceneInteraction} initialTarget={initialTarget} onClose={onClose} />
    </PlatformProvider>));
    await render();
    return { root, render, platform, onClose, base, sceneInteraction };
  }

  async function choose(name: string) {
    await click(document.querySelector('[data-testid="preset-editor-preset"]'));
    await click(document.querySelector(`[role="option"][title="${name}"]`));
  }

  it('retains nozzle and independent flows across Undo/Redo refresh, and reinitializes only when entering the active source', async()=>{
    const source=u1Fixture();
    const other=u1Fixture({name:'Other U1',active:false});
    const candidates=[source.editorCandidates[0],other.editorCandidates[0]];
    let current=source;
    const getDraft=vi.fn(async(_kind,name)=>({...current,...(name===other.canonicalName?other:{}),editorCandidates:candidates}));
    await mountSession(getDraft);
    await selectExtruder(3);await selectFlow(3,'HF');await selectFlow(1,'HF');
    await click(document.querySelector('[data-testid="preset-editor-extruder-3"]'));
    const redo=mutationSuccess(source,{kind:'printer',canonicalName:source.canonicalName,expectedRevision:1,
      action:'set-element',key:'retraction_length',index:5,scalarType:'float',value:2.5});
    if(!redo.ok)throw Error('receipt');
    current={...redo,editorCandidates:candidates};
    for(const next of [current,source,current]) {
      current=next;
      await act(async()=>{
        useHistoryRestoreStore.getState().setPhase('restoring');
        useHistoryRestoreStore.getState().advanceRevision();
      });
      await act(async()=>useHistoryRestoreStore.getState().setPhase('idle'));
      expect(document.querySelector('[data-testid="preset-editor-extruder-3"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector('[data-testid="preset-editor-flow-1"]')?.textContent).toContain('HF');
      expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
      expect(document.querySelector('[data-testid="preset-editor-input-retraction_length"]')).toHaveProperty('value',next===source?'1.3':'2.5');
    }
    await choose(other.canonicalName);
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('HF');
    await choose(source.canonicalName);
    expect(document.querySelector('[data-testid="preset-editor-extruder-3"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-testid="preset-editor-flow-3"]')?.textContent).toContain('SF');
    expect(document.querySelector('[data-testid="preset-editor-flow-1"]')?.textContent).toContain('SF');
    expect(commitPresetDraftMutation).not.toHaveBeenCalled();
  });

  it('acknowledges a committed edit after recovery fails and blocks resubmission while allowing close', async () => {
    const base = snapshotFor('printer');
    const getDraft = vi.fn().mockResolvedValue(base);
    const { onClose } = await mountSession(getDraft);
    vi.mocked(commitPresetDraftMutation).mockImplementation(async (_platform, request) => {
      const receipt = mutationSuccess(base, request);
      if (!receipt.ok) throw new Error('expected success');
      throw new CommittedPresetDraftProjectionError(receipt, new Error('refresh unavailable'));
    });
    await enterSearch('printable_height');
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '245'); await press(height, 'Enter');
    expect(document.querySelector('[data-testid="preset-editor-load-error"]')?.textContent).toContain('The edit was committed');
    expect(document.querySelector('[data-testid="preset-editor-input-printable_height"]')).toBeNull();
    expect((document.querySelector('[data-testid="preset-editor-reset-preset"]') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('[data-testid="preset-editor-preset"]') as HTMLButtonElement).disabled).toBe(true);
    expect(getDraft).toHaveBeenCalledOnce(); expect(commitPresetDraftMutation).toHaveBeenCalledOnce();
    await click(document.querySelector('[data-testid="preset-editor-close"]')); expect(onClose).toHaveBeenCalledOnce();
  });

  it('retains the candidate list on unchanged and replaces it without extra reads', async () => {
    const base = snapshotFor('printer', { modified: true });
    const candidates = [base.editorCandidates[0], { ...base.editorCandidates[0], canonicalName: 'Other Printer', label: 'Other Printer' }];
    const getDraft = vi.fn().mockResolvedValue({ ...base, editorCandidates: candidates });
    await mountSession(getDraft);
    vi.mocked(commitPresetDraftMutation).mockImplementation(async (_platform, request) => {
      const result = mutationSuccess(base, request);
      if (!result.ok) throw new Error('expected success');
      return { ...result, editorCandidates: { kind: 'unchanged' } };
    });
    await enterSearch('printable_height');
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '245'); await press(height, 'Enter');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('245');
    expect(getDraft).toHaveBeenCalledTimes(1);
    await click(document.querySelector('[data-testid="preset-editor-preset"]'));
    expect(document.querySelector('[role="option"][title="Other Printer"]')).not.toBeNull();
    await press(document.querySelector('[data-testid="preset-editor-preset"]') as HTMLElement, 'Escape');
    vi.mocked(commitPresetDraftMutation).mockImplementation(async (_platform, request) => {
      const result = mutationSuccess(base, request);
      if (!result.ok) throw new Error('expected success');
      return { ...result, editorCandidates: { kind: 'replace', items: [base.editorCandidates[0]] } };
    });
    await click(document.querySelector('[data-testid="preset-editor-reset-preset"]'));
    expect(getDraft).toHaveBeenCalledTimes(1);
    await click(document.querySelector('[data-testid="preset-editor-preset"]'));
    expect(document.querySelector('[role="option"][title="Other Printer"]')).toBeNull();
  });

  it('refreshes the browsed source after history restore without following the opening source', async () => {
    const base = snapshotFor('printer');
    const candidates = [base.canonicalName, 'Other Printer'].map(canonicalName => ({
      canonicalName, label: canonicalName, isProjectEmbedded: false, isUser: false, compatible: true, modified: false,
    }));
    let height = '230';
    const getDraft = vi.fn(async (_kind, canonicalName) => ({ ...base, canonicalName,
      editorCandidates: candidates, effectiveValues: { ...base.effectiveValues, printable_height: height } }));
    await mountSession(getDraft);
    await choose('Other Printer');
    height = '245';
    await act(async () => {
      useHistoryRestoreStore.getState().setPhase('restoring');
      useHistoryRestoreStore.getState().advanceRevision();
    });
    expect(getDraft).toHaveBeenCalledTimes(2);
    await act(async () => useHistoryRestoreStore.getState().setPhase('idle'));
    expect(getDraft).toHaveBeenLastCalledWith('printer', 'Other Printer');
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Other Printer');
    expect(document.querySelector('[data-testid="preset-editor-effective-printable_height"]')?.textContent).toBe('245');
  });

  it('retries history refresh after an in-flight target read and ignores a closed session result', async () => {
    const base = snapshotFor('printer');
    const candidates = [base.canonicalName, 'Other Printer'].map(canonicalName => ({
      canonicalName, label: canonicalName, isProjectEmbedded: false, isUser: false, compatible: true, modified: false,
    }));
    let resolveRead!: (value: unknown) => void;
    const getDraft = vi.fn().mockResolvedValue({ ...base, editorCandidates: candidates });
    const { root, render } = await mountSession(getDraft);
    getDraft.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    await choose('Other Printer');
    await act(async () => { useHistoryRestoreStore.getState().advanceRevision(); });
    expect(getDraft).toHaveBeenCalledTimes(2);
    getDraft.mockResolvedValue({ ...base, canonicalName: 'Other Printer', editorCandidates: candidates, revision: 2 });
    await act(async () => resolveRead({ ...base, canonicalName: 'Other Printer', editorCandidates: candidates }));
    expect(getDraft).toHaveBeenCalledTimes(3);
    expect(getDraft).toHaveBeenLastCalledWith('printer', 'Other Printer');

    getDraft.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    await choose(base.canonicalName);
    await act(async () => root.render(null));
    getDraft.mockResolvedValue({ ...base, editorCandidates: candidates });
    await render();
    await act(async () => resolveRead({ ok: false, error: 'obsolete read failed' }));
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe(base.canonicalName);
    expect(document.body.textContent).not.toContain('obsolete read failed');
  });

  it('owns mutation locks, canonical target resolution and deferred history refresh', async () => {
    const base = snapshotFor('printer');
    const getDraft = vi.fn().mockResolvedValue({ ...base });
    const { onClose, platform, sceneInteraction } = await mountSession(getDraft);
    let resolveMutation!: (value: PresetDraftMutationResult) => void;
    let submitted!: PresetDraftMutationRequest;
    vi.mocked(commitPresetDraftMutation).mockImplementation(async (_platform, request) => {
      submitted = request;
      return new Promise(resolve => { resolveMutation = resolve; });
    });
    await enterSearch('printable_height');
    const height = document.querySelector('[data-testid="preset-editor-input-printable_height"]') as HTMLInputElement;
    await changeInput(height, '245'); await press(height, 'Enter');
    expect(commitPresetDraftMutation).toHaveBeenCalledWith(platform, expect.objectContaining({
      kind: 'printer', canonicalName: base.canonicalName, key: 'printable_height', value: '245',
    }), sceneInteraction);
    expect((document.querySelector('[data-testid="preset-editor-preset"]') as HTMLButtonElement).disabled).toBe(true);
    await click(document.querySelector('[data-testid="preset-editor-close"]'));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { useHistoryRestoreStore.getState().advanceRevision(); });
    expect(getDraft).toHaveBeenCalledTimes(1);
    const result = mutationSuccess(base, submitted);
    if (!result.ok) throw new Error('expected fixture mutation success');
    const resolved = { ...result, canonicalName: 'Resolved Printer' };
    getDraft.mockResolvedValue({ ...resolved, editorCandidates: resolved.editorCandidates.kind === 'replace' ? resolved.editorCandidates.items : base.editorCandidates, revision: 3 });
    await act(async () => resolveMutation(resolved));
    expect(getDraft).toHaveBeenLastCalledWith('printer', 'Resolved Printer');
    expect(document.querySelector('[data-testid="preset-editor-title"]')?.textContent).toBe('Resolved Printer');
    expect((document.querySelector('[data-testid="preset-editor-preset"]') as HTMLButtonElement).disabled).toBe(false);
    await click(document.querySelector('[data-testid="preset-editor-close"]'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
