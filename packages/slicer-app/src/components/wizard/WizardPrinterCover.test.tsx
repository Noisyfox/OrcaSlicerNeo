// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardPrinterCover } from './WizardPrinterCover';
import { createWizardImageSession } from './setupWizardImages';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let reactRoot: Root;
const observers: Array<{ callback: IntersectionObserverCallback; options?: IntersectionObserverInit;
  observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) {
      observers.push(this);
    }
  });
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:cover'), revokeObjectURL: vi.fn() });
});
afterEach(async () => { await act(async () => reactRoot?.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
async function fixture(read = vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1]))) {
  const container = document.createElement('div'); document.body.append(container);
  const node = document.createElement('div'); container.append(node); reactRoot = createRoot(node);
  const session = createWizardImageSession({ readFilesystemFile: read });
  const render = (visible = true, path = '/profiles/vendor/cover.svg') => act(async () => reactRoot.render(
    <StrictMode>{visible && <div data-slot="card"><WizardPrinterCover path={path} root={container} session={session} /></div>}</StrictMode>,
  ));
  await render();
  const intersect = async (isIntersecting = true) => act(async () => {
    const observer = observers.at(-1)!;
    observer.callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  return { read, session, container, render, intersect };
}
describe('wizard cover visibility and session ownership', () => {
  it('observes the card in the actual scroll root and never reads an offscreen card', async () => {
    const f = await fixture();
    expect(observers.at(-1)!.options?.root).toBe(f.container);
    expect(observers.at(-1)!.observe).toHaveBeenCalledWith(document.querySelector('[data-slot="card"]'));
    expect(f.read).not.toHaveBeenCalled(); await f.intersect(false); expect(f.read).not.toHaveBeenCalled();
    await f.intersect(); expect(f.read).toHaveBeenCalledExactlyOnceWith('/profiles/vendor/cover.svg');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:cover');
    f.session.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:cover');
  });
  it('search/filter and Back remounts reuse reads within the session; reopen reads again', async () => {
    const f = await fixture(); await f.intersect();
    await f.render(false); await f.render(); await f.intersect();
    expect(f.read).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    f.session.dispose(); f.session.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    const reopened = createWizardImageSession({ readFilesystemFile: f.read });
    await reopened.load('/profiles/vendor/cover.svg'); expect(f.read).toHaveBeenCalledTimes(2); reopened.dispose();
  });
  it('failed and absent covers retain placeholders without repeated failed reads', async () => {
    const read = vi.fn(async (): Promise<Uint8Array> => { throw new Error('missing'); });
    const f = await fixture(read); await f.intersect();
    expect(document.querySelector('[data-setup-cover="failed"]')).not.toBeNull(); expect(document.querySelector('img')).toBeNull();
    await f.render(false); await f.render(); await f.intersect(); expect(read).toHaveBeenCalledTimes(1);
    await f.render(true, ''); expect(document.querySelector('img')).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled(); f.session.dispose();
  });
  it('closing/unmounting during a read cannot create a late URL or publish to a new card', async () => {
    let resolve!: (value: Uint8Array) => void;
    const f = await fixture(vi.fn(() => new Promise<Uint8Array>(done => { resolve = done; })));
    await f.intersect(); f.session.dispose(); await f.render(false);
    await act(async () => resolve(new Uint8Array([1])));
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(document.querySelector('img')).toBeNull();
    expect(await f.session.load('/profiles/vendor/cover.svg')).toBeNull(); expect(f.read).toHaveBeenCalledTimes(1);
  });
});
