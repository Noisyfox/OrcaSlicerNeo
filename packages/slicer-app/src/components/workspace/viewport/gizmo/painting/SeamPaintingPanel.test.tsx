// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PaintingState } from './PaintingController';
import { SeamPaintingPanel } from './SeamPaintingPanel';
const mocked = vi.hoisted(() => ({ state: null as PaintingState | null, controller: {setTool:vi.fn(),setSettings:vi.fn(),close:vi.fn(),apply:vi.fn()} }));
vi.mock('./PaintingProvider', () => ({usePaintingState:()=>mocked.state,usePaintingController:()=>mocked.controller}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,container:HTMLDivElement;
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('PointerEvent',MouseEvent);
  mocked.state={phase:'idle',channel:'seam',session:null,tool:'circle',settings:{state:1,erase:false,vertical:false,radius:2,height:1,angle:30,gapArea:0},error:null,display:null,epoch:0};
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const render=()=>act(async()=>root.render(<SeamPaintingPanel/>));
it('offers exactly circle/sphere with independent Enforce/Block/Erase and Vertical',async()=>{
  await render();expect(container.querySelectorAll('[aria-label="Painting tool"] [role="radio"]')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Painting filament"]')).toBeNull();
  await act(async()=> (container.querySelector('[data-testid="painting-action-2"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({state:2,erase:false});
  await act(async()=> (container.querySelector('[data-testid="painting-action-erase"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({erase:true});
  await act(async()=> (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  expect(mocked.controller.setSettings).toHaveBeenLastCalledWith({vertical:true});
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
