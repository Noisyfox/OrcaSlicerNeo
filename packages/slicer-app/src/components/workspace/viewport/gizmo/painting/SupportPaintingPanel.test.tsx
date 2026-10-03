// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PaintingState } from './PaintingController';
import { SupportPaintingPanel } from './SupportPaintingPanel';
const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, controller: {setTool:vi.fn(),setSettings:vi.fn(),close:vi.fn(),apply:vi.fn(),setHighlight:vi.fn()} }));
vi.mock('./PaintingProvider', () => ({usePaintingState:()=>mocked.state,usePaintingController:()=>mocked.controller}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('PointerEvent',MouseEvent);
  mocked.state={phase:'idle',channel:'support',session:null,tool:'circle',settings:{state:1,erase:false,vertical:false,radius:2,height:1,angle:30,gapArea:0,overhangAngle:0,restrictToOverhangs:false},error:null,display:null,epoch:0};
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const render=()=>act(async()=>root.render(<SupportPaintingPanel/>));
it('offers exactly Circle/Sphere/Smart Fill/Gap with explicit Enforce/Block/Erase and independent overhang controls',async()=>{
  await render();expect(container.querySelectorAll('[aria-label="Painting tool"] [role="radio"]')).toHaveLength(4);
  expect(container.querySelector('[aria-label="Painting filament"]')).toBeNull();
  await act(async()=> (container.querySelector('[data-testid="painting-action-2"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({state:2,erase:false});
  await act(async()=> (container.querySelector('[data-testid="painting-action-erase"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({erase:true});
  await act(async()=> (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  expect(mocked.controller.setHighlight).toHaveBeenLastCalledWith(true);
});
it('keeps live brush/action controls available while unfinished and retains explicit close recovery',async()=>{
  mocked.state!.phase='drawing';await render();
  expect(container.querySelector('[data-testid="painting-tool-sphere"]')?.getAttribute('aria-disabled')).toBe('true');
  expect(container.querySelector('[data-testid="painting-action-2"]')?.getAttribute('aria-disabled')).not.toBe('true');
  expect((container.querySelector('[aria-label="Radius (mm)"]') as HTMLInputElement).disabled).toBe(false);
  expect([...container.querySelectorAll('button')].every(button=>button.disabled)).toBe(true);
  mocked.state!.phase='error';mocked.state!.error='close failed';await render();
  const close=container.querySelector<HTMLButtonElement>('[aria-label="Close painting"]')!;expect(close.disabled).toBe(false);
  await act(async()=>close.click());expect(mocked.controller.close).toHaveBeenCalledOnce();
});

it('offers object-wide Apply only for Gap and no generation/configuration mutation',async()=>{
  mocked.state!.tool='gap';await render();
  expect(container.textContent).toContain('lowest neighboring native state');
  const apply=[...container.querySelectorAll('button')].find(b=>b.textContent==='Apply gaps')!;
  await act(async()=>apply.click());expect(mocked.controller.apply).toHaveBeenCalledWith('gap');
  expect(container.textContent).toContain('Painting does not enable support generation');
  expect(container.querySelector('[aria-label="Vertical"]')).toBeNull();
});
