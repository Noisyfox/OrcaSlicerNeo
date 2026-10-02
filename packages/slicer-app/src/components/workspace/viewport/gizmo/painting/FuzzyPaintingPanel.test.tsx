// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { PaintingState } from './PaintingController';
import { FuzzyPaintingPanel } from './FuzzyPaintingPanel';
vi.mock('@orca/platform-contract',()=>({usePlatform:()=>({runtime:{}})}));
const mutation=vi.hoisted(()=>vi.fn());
vi.mock('../../../settings/configurationActions',()=>({commitScopedConfigurationMutation:mutation}));
const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, controller: {setTool:vi.fn(),setSettings:vi.fn(),close:vi.fn(),apply:vi.fn()} }));
vi.mock('./PaintingProvider', () => ({usePaintingState:()=>mocked.state,usePaintingController:()=>mocked.controller}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('PointerEvent',MouseEvent);
  mocked.state={phase:'idle',channel:'fuzzy',session:null,tool:'circle',settings:{state:1,erase:true,vertical:false,radius:2,height:1,angle:30,gapArea:0,overhangAngle:0,restrictToOverhangs:false},error:null,display:null,epoch:0};
  useSettingsStore.setState({metadata:{fuzzy_skin:{type:'enum',scopes:['project','object','part']}},baseValues:{fuzzy_skin:'disabled_fuzzy'},nativeScopedConfigRefreshRequired:false,nativeScopedConfig:{project:{},objects:{},parts:{},plates:{}}});
  mocked.state!.session={objectId:10,parts:[{volumeId:20}]} as unknown as PaintingState['session'];
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const render=()=>act(async()=>root.render(<FuzzyPaintingPanel/>));
it('offers four native fuzzy tools and exactly Enable/Erase, with explicit independent object enable',async()=>{
  await render();expect(container.querySelectorAll('[aria-label="Painting tool"] [role="radio"]')).toHaveLength(4);
  expect(container.querySelectorAll('[aria-label="Fuzzy skin action"] [role="radio"]')).toHaveLength(2);
  expect(container.querySelector('[role="checkbox"]')).toBeNull();
  expect(container.querySelector('[data-testid="fuzzy-disabled-warning"]')).not.toBeNull();
  await act(async()=> (container.querySelector('[data-testid="painting-action-1"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({state:1,erase:false});expect(mutation).not.toHaveBeenCalled();
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Enable painted fuzzy skin')!.click());
  expect(mutation).toHaveBeenCalledWith(expect.anything(),{version:1,operation:'set',targets:[{scope:'object',id:10}],key:'fuzzy_skin',value:'none'});
  useSettingsStore.setState({nativeScopedConfig:{project:{},objects:{'10':{fuzzy_skin:'none'}},parts:{'20':{fuzzy_skin:'disabled_fuzzy'}},plates:{}}});await render();
  expect(container.querySelector('[data-testid="fuzzy-disabled-warning"]')).not.toBeNull();
});
it('keeps live brush/action controls available while unfinished and retains explicit close recovery',async()=>{
  mocked.state!.phase='drawing';await render();
  expect(container.querySelector('[data-testid="painting-tool-sphere"]')?.getAttribute('aria-disabled')).toBe('true');
  expect(container.querySelector('[data-testid="painting-action-1"]')?.getAttribute('aria-disabled')).not.toBe('true');
  expect((container.querySelector('[aria-label="Radius (mm)"]') as HTMLInputElement).disabled).toBe(false);
  expect([...container.querySelectorAll('button')].every(button=>button.disabled)).toBe(true);
  mocked.state!.phase='error';mocked.state!.error='close failed';await render();
  const close=container.querySelector<HTMLButtonElement>('[aria-label="Close painting"]')!;expect(close.disabled).toBe(false);
  await act(async()=>close.click());expect(mocked.controller.close).toHaveBeenCalledOnce();
});

it('keeps painting available but config status/action unavailable for stale or incomplete projections',async()=>{
  useSettingsStore.setState({nativeScopedConfigRefreshRequired:true});await render();
  expect(container.querySelector('[data-testid="fuzzy-effective-configuration"]')?.textContent).toBe('Unavailable');
  expect([...container.querySelectorAll('button')].find(b=>b.textContent==='Enable painted fuzzy skin')!.disabled).toBe(true);
  expect(container.querySelector('[data-testid="painting-action-1"]')?.getAttribute('aria-disabled')).not.toBe('true');
  useSettingsStore.setState({nativeScopedConfigRefreshRequired:false,baseValues:{}});await render();
  expect(container.querySelector('[data-testid="fuzzy-effective-configuration"]')?.textContent).toBe('Unavailable');
});

it('shows action failure and retries, ignores busy dispatch, and captures the original object across await',async()=>{
  mocked.state!.phase='drawing';await render();
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Enable painted fuzzy skin')!.click());expect(mutation).not.toHaveBeenCalled();
  mocked.state!.phase='idle';mutation.mockRejectedValueOnce(new Error('config failed'));await render();
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Enable painted fuzzy skin')!.click());expect(container.querySelector('[role="alert"]')?.textContent).toBe('config failed');
  let release!:()=>void;mutation.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Enable painted fuzzy skin')!.click());
  mocked.state!.session={...mocked.state!.session!,objectId:11};await render();
  expect(mutation).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({targets:[{scope:'object',id:10}]}));
  await act(async()=>release());expect(container.querySelector('[role="alert"]')).toBeNull();
});
