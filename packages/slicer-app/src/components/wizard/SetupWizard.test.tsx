// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_PREFERENCES, type PlatformCapabilities } from '@orca/platform-contract';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION } from '@slicer/client';
import { SetupWizard } from './SetupWizard';
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ''; });
const button = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function fixture(mandatory = false, electron = false) {
  const runtime = createClient(async () => createMockModule()); await runtime.init(mandatory ? null : MOCK_PROFILE_ACTIVATION);
  const prepare = vi.spyOn(runtime, 'prepareProfileActivation'), apply = vi.spyOn(runtime, 'applyProfileActivation');
  let saved = { ...structuredClone(DEFAULT_USER_PREFERENCES), profileActivation: mandatory ? undefined : MOCK_PROFILE_ACTIVATION };
  const preferences = { load: vi.fn(async () => saved), save: vi.fn(async next => { saved = next; }) };
  const quit = vi.fn(async () => {});
  const platform = { runtime, preferences, chrome: { kind: electron ? 'desktop' : 'web' }, menu: { execute: quit } } as unknown as PlatformCapabilities;
  const onApplied = vi.fn(async () => {}), onClose = vi.fn();
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<StrictMode><SetupWizard platform={platform} mandatory={mandatory} onApplied={onApplied} onClose={onClose} /></StrictMode>));
  return { runtime, preferences, prepare, apply, onApplied, onClose, quit };
}
describe('shared setup modal lifecycle', () => {
  it('shows only owned catalogue download progress, resets for native loading and unsubscribes on cleanup', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = createClient(async () => createMockModule(), undefined, undefined, undefined, undefined, async () => pending);
    await runtime.init(null);
    let listener: ((text: string, phase: 'startup' | 'catalogue') => void) | undefined;
    const stop = vi.fn();
    const onStartupProgress = vi.fn((next: typeof listener) => { listener = next; return stop; });
    const platform = { runtime: Object.assign(runtime, { onStartupProgress }), chrome: { kind: 'web' }, preferences: { load: async () => DEFAULT_USER_PREFERENCES } } as unknown as PlatformCapabilities;
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(<StrictMode><SetupWizard platform={platform} mandatory onApplied={vi.fn()} onClose={vi.fn()} /></StrictMode>));
    await act(async () => listener!('Downloading profiles 1/2', 'startup'));
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading profiles…');
    await act(async () => listener!('Downloading profiles 1/64', 'catalogue'));
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Downloading profiles 1/64');
    await act(async () => listener!('Downloading profiles 64/64', 'catalogue'));
    await act(async () => listener!('Loading profiles…', 'catalogue'));
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading profiles…');
    await act(async () => release()); expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => listener!('late download', 'catalogue')); expect(document.body.textContent).not.toContain('late download');
    await act(async () => root!.unmount()); root = undefined;
    expect(stop).toHaveBeenCalledTimes(2);
    await act(async () => listener!('after unmount', 'catalogue')); expect(document.body.textContent).toBe('');
  });
  it('mandatory Electron Exit quits the host without cancelling or completing setup', async () => {
    const f = await fixture(true, true);
    expect(button('Cancel')).toBeUndefined(); expect(button('Exit').disabled).toBe(false);
    await click('Exit');
    expect(f.quit).toHaveBeenCalledExactlyOnceWith('quit');
    expect(f.onClose).not.toHaveBeenCalled(); expect(f.onApplied).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.preferences.save).not.toHaveBeenCalled();
  });
  it('Web mandatory setup and later Electron setup have no app Exit action', async () => {
    await fixture(true); expect(button('Exit')).toBeUndefined();
    await act(async () => root!.unmount()); root = undefined;
    await fixture(false, true); expect(button('Exit')).toBeUndefined();
  });
  it('mandatory Electron Exit remains available while the catalogue is loading', async () => {
    const runtime = createClient(async () => createMockModule()); await runtime.init(null);
    let release!: () => void; const deferred = new Promise<void>(resolve => { release = resolve; });
    const open = runtime.openSetupWizardCatalogue.bind(runtime);
    vi.spyOn(runtime, 'openSetupWizardCatalogue').mockImplementation(async () => { await deferred; return open(); });
    const close = vi.spyOn(runtime, 'closeSetupWizardCatalogue'), quit = vi.fn(async () => {}), onClose = vi.fn();
    const platform = { runtime, chrome: { kind: 'desktop' }, menu: { execute: quit },
      preferences: { load: async () => DEFAULT_USER_PREFERENCES } } as unknown as PlatformCapabilities;
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(<SetupWizard platform={platform} mandatory onApplied={vi.fn()} onClose={onClose} />));
    expect(button('Next').disabled).toBe(true); expect(button('Exit').disabled).toBe(false);
    await click('Exit'); expect(quit).toHaveBeenCalledExactlyOnceWith('quit');
    expect(onClose).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    await act(async () => release());
  });
  it('mandatory setup cannot cancel and selects models, defaults and completes', async () => {
    const f = await fixture(true);
    expect(button('Cancel')).toBeUndefined(); expect(button('Next').disabled).toBe(true);
    const model = document.getElementById(`setup-model-${encodeURIComponent(JSON.stringify(['bambulab', 'X1 Carbon']))}`)!;
    await act(async () => model.click());
    await click('Next'); expect(button('Finish').disabled).toBe(false);
    await click('Finish'); expect(f.onApplied).toHaveBeenCalledTimes(1); expect(f.onClose).toHaveBeenCalledTimes(1);
  });
  it('later cancellation releases catalogue without preparing, saving or applying', async () => {
    const f = await fixture(); await click('Cancel');
    expect(f.onClose).toHaveBeenCalledTimes(1); expect(f.prepare).not.toHaveBeenCalled(); expect(f.preferences.save).not.toHaveBeenCalled();
    expect(await f.runtime.prepareProfileActivation({ activation: MOCK_PROFILE_ACTIVATION, rememberedBedTypes: {}, rememberedFilamentRacks: {} })).toMatchObject({ ok: false });
  });
  it('save failure remains editable; apply failure locks and retries the same prepared candidate', async () => {
    const f = await fixture(); await click('Next');
    f.preferences.save.mockRejectedValueOnce(new Error('disk full'));
    await click('Finish'); expect(document.body.textContent).toContain('disk full'); expect(button('Back').disabled).toBe(false); expect(f.apply).not.toHaveBeenCalled();
    f.apply.mockResolvedValueOnce({ ok: false, error: 'native failed' });
    await click('Finish'); expect(button('Back').disabled).toBe(true); expect(button('Cancel').disabled).toBe(true); expect(button('Retry Apply')).toBeDefined();
    const checkbox = document.querySelector('[role="checkbox"]') as HTMLElement;
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    const checked = checkbox.getAttribute('aria-checked');
    await act(async () => checkbox.click()); expect(checkbox.getAttribute('aria-checked')).toBe(checked);
    expect((document.querySelector('[aria-label="Models"]') as HTMLButtonElement).disabled).toBe(true);
    const preparations = f.prepare.mock.calls.length, saves = f.preferences.save.mock.calls.length;
    await click('Retry Apply'); expect(f.prepare).toHaveBeenCalledTimes(preparations); expect(f.preferences.save).toHaveBeenCalledTimes(saves); expect(f.onApplied).toHaveBeenCalledTimes(1);
  });
  it('loading disables cancellation and close never overtakes native open', async () => {
    const runtime = createClient(async () => createMockModule()); await runtime.init(MOCK_PROFILE_ACTIVATION);
    let release!: () => void; const deferred = new Promise<void>(resolve => { release = resolve; });
    const open = runtime.openSetupWizardCatalogue.bind(runtime); vi.spyOn(runtime, 'openSetupWizardCatalogue').mockImplementation(async () => { await deferred; return open(); });
    const close = vi.spyOn(runtime, 'closeSetupWizardCatalogue');
    const platform = { runtime, preferences: { load: async () => DEFAULT_USER_PREFERENCES } } as unknown as PlatformCapabilities;
    const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
    await act(async () => root!.render(<SetupWizard platform={platform} mandatory={false} onApplied={vi.fn()} onClose={vi.fn()} />));
    expect(button('Cancel').disabled).toBe(true); await click('Cancel'); expect(close).not.toHaveBeenCalled();
    await act(async () => release()); expect(button('Cancel').disabled).toBe(false);
  });
});
