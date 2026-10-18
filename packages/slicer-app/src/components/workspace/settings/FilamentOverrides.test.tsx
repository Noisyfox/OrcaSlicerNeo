// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION, type PresetDraftSnapshot, type PresetDraftMutationRequest } from '@slicer/client';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { PresetEditorDialogContent } from './PresetEditorDialog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); });
const query = (id: string) => document.querySelector(`[data-testid="preset-editor-${id}"]`) as HTMLInputElement;
async function click(element: Element | null) {
  if (!element) throw new Error('Missing control');
  await act(async () => { if (element.getAttribute('role') === 'option') element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    (element as HTMLElement).click(); });
}
async function fill(key: string, value: string) {
  const input = query(`input-${key}`);
  await act(async () => { input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => input.blur());
}
async function mount() {
  const client = createClient(async () => createMockModule()); await client.init(MOCK_PROFILE_ACTIVATION);
  const name = 'Generic PLA @System';
  const read = async () => { const result = await client.getPresetDraft('filament', name); if (!result.ok) throw new Error(result.error); return result; };
  let snapshot: PresetDraftSnapshot = await read();
  const platform = { preferences: { load: async () => structuredClone(DEFAULT_USER_PREFERENCES), save: async () => {} } } as unknown as PlatformCapabilities;
  const mutate = vi.fn(async (request: PresetDraftMutationRequest) => {
    const result = await client.mutatePresetDraft(request, {selection:{mode:'object',objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}});
    if (result.ok) { snapshot = { ...result, editorCandidates: result.editorCandidates.kind === 'replace' ? result.editorCandidates.items : snapshot.editorCandidates }; render(); }
    return result;
  });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const render = () => root!.render(<PlatformProvider value={platform}><PresetEditorDialogContent target={{kind:'filament',canonicalName:name}}
    snapshot={snapshot} onClose={() => {}} onSelectPreset={async () => {}} onMutate={mutate} /></PlatformProvider>);
  await act(async () => render()); await click(query('page-tab-setting-overrides'));
  return { client, read, mutate, refresh: async () => {snapshot=await read(); await act(async()=>render());} };
}

it('edits a nullable override, displays the current reference and reseeds on re-enable', async () => {
  const h = await mount(), key = 'filament_retraction_length';
  expect(query(`input-${key}`).value).toBe('0.8'); expect(query(`input-${key}`).disabled).toBe(true);
  await click(query(`override-${key}`)); expect(query(`input-${key}`).disabled).toBe(false);
  await fill(key,'1.4'); expect((await h.read()).editorVectors[key].effectiveValues[0]).toBe(1.4);
  await click(query(`override-${key}`)); expect((await h.read()).editorVectors[key].effectiveValues[0]).toBeNull();
  expect(query(`input-${key}`).value).toBe('0.8');
  await click(query(`override-${key}`)); expect(query(`input-${key}`).value).toBe('0.8');
  await click(query('variant')); await click([...document.querySelectorAll('[role="option"]')].find(option => option.textContent === 'Variant 2')!);
  expect(query(`input-${key}`).disabled).toBe(true); await click(query(`override-${key}`)); await fill(key,'1.7');
  expect((await h.read()).editorVectors[key].effectiveValues).toEqual([0.8,1.7]);
});

it('keeps Reset available when inherited/dependent controls are disabled', async () => {
  const h=await mount(), length='filament_retraction_length', speed='filament_retraction_speed';
  await click(query(`override-${speed}`)); await fill(speed,'12');
  await click(query(`override-${length}`)); await fill(length,'0');
  expect(query(`input-${speed}`).disabled).toBe(true); expect(query(`override-${speed}`).getAttribute('aria-disabled')).toBe('true');
  expect(query(`reset-field-${speed}`).disabled).toBe(false); await click(query(`reset-field-${speed}`));
  expect((await h.read()).editorVectors[speed].overrideValues[0]).toBeNull();
  await fill(length,'1'); expect(query(`override-${speed}`).getAttribute('aria-disabled')).not.toBe('true');
  const long='filament_long_retractions_when_cut', distance='filament_retraction_distances_when_cut';
  expect(query(`field-${distance}`)).toBeNull(); await click(query(`override-${long}`));
  expect(query(`input-${long}`).getAttribute('aria-checked')).toBe('false'); await click(query(`input-${long}`));
  expect(query(`field-${distance}`)).not.toBeNull();
});

it('distinguishes boolean false and enum zero from disabled overrides', async () => {
  const h=await mount(), bool='filament_wipe', enumeration='filament_z_hop_types';
  await click(query(`override-${bool}`)); expect(query(`override-${bool}`).getAttribute('aria-checked')).toBe('true');
  expect(query(`input-${bool}`).getAttribute('aria-checked')).toBe('false');
  expect((await h.read()).editorVectors[bool].effectiveValues[0]).toBe(false);
  await click(query(`override-${enumeration}`)); expect((await h.read()).editorVectors[enumeration].effectiveValues[0]).toBe(0);
  expect(query(`input-${enumeration}`).textContent).toContain('Normal');
  await click(query(`input-${enumeration}`)); await click([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent==='Spiral')!);
  expect((await h.read()).editorVectors[enumeration].effectiveValues[0]).toBe(1);
});

it('retains invalid input and leaves native values and history unchanged', async () => {
  const h=await mount(), key='filament_retract_before_wipe'; await click(query(`override-${key}`));
  const before=await h.read(), history=await h.client.getHistoryStatus(); await fill(key,'101');
  expect(query(`input-${key}`).value).toBe('101'); expect(query(`error-${key}`)?.textContent).toContain('range');
  expect(await h.read()).toEqual(before); expect(await h.client.getHistoryStatus()).toEqual(history);
});

it('uses current Process ironing references through commits and Undo/Redo', async () => {
  const h=await mount(), speed='filament_ironing_speed';
  const historyContext={selection:{mode:'object' as const,objectIds:[],partIds:[],instanceIds:[]},activePlateId:null,gizmo:null,nativeScopedConfig:{}};
  const transaction=await h.client.beginHistory('Edit Process ironing','project',historyContext);
  const process=await h.client.mutateNativeScopedConfig({version:1,operation:'set',targets:[{scope:'project'}],key:'ironing_speed',value:'42'});
  await h.client.commitHistory(transaction,historyContext);
  expect(process.ok).toBe(true); await h.refresh();
  expect(query(`input-${speed}`).value).toBe('42'); expect(query(`input-${speed}`).disabled).toBe(true);
  await click(query(`override-${speed}`)); expect((await h.read()).editorVectors[speed].effectiveValues[0]).toBe(42);
  await h.client.undoHistory(); await h.refresh(); expect(query(`input-${speed}`).value).toBe('42');
  expect(query(`override-${speed}`).getAttribute('aria-checked')).toBe('false');
  await h.client.undoHistory(); await h.refresh(); expect(query(`input-${speed}`).value).toBe('30');
  await h.client.redoHistory(); await h.refresh(); expect(query(`input-${speed}`).value).toBe('42');
});

it('edits all four ironing values without ConfigManipulation correction', async () => {
  const h=await mount();
  for(const [key,value] of [['filament_ironing_flow','15'],['filament_ironing_spacing','0.03'],['filament_ironing_inset','0.2'],['filament_ironing_speed','35']]) {
    expect(query(`control-${key}`).textContent).toContain(key.endsWith('flow')?'%':key.endsWith('speed')?'mm/s':'mm');
    expect(query(`input-${key}`).disabled).toBe(true); await click(query(`override-${key}`)); await fill(key,value);
    expect((await h.read()).editorVectors[key].effectiveValues[0]).toBe(Number(value));
    await click(query(`reset-field-${key}`)); expect((await h.read()).editorVectors[key].effectiveValues[0]).toBeNull();
    expect(query(`input-${key}`).disabled).toBe(true);
  }
});
