// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { UserPresetActions } from './UserPresetActions';
import { commitUserPresetMutation, waitForConfigurationMutations } from './configurationActions';
vi.mock('./configurationActions', () => ({ commitUserPresetMutation: vi.fn(), waitForConfigurationMutations: vi.fn(async () => {}) }));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.clearAllMocks(); });
async function mount(deleted = false, kind: 'filament' | 'print' = 'filament') {
  const getUserPresetInfo = vi.fn(async () => ({ ok: true, kind: 'filament', canonicalName: 'P', label: deleted ? 'P (Deleted)' : 'P',
    defaultSaveAsName: 'P', overwriteName: deleted ? null : 'P', compatible: true,
    canSave: !deleted, canDelete: !deleted, canReset: kind === 'print', deleted, revision: 7 }));
  const platform = { runtime: { getUserPresetInfo } } as unknown as PlatformCapabilities;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PlatformProvider value={platform}><UserPresetActions sceneInteraction={null} kind={kind} canonicalName="P" /></PlatformProvider>));
  return getUserPresetInfo;
}
const button = (label: string) => [...document.querySelectorAll('button')].find(node =>
  (node.getAttribute('aria-label') ?? node.textContent) === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function name(value: string) {
  const input = document.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('user preset actions', () => {
  it('does not add a separate Reset preset button for Process snapshots', async () => {
    await mount(false, 'print');
    expect(button('Reset preset')).toBeUndefined();
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
  });
  it('only offers Save as for a deleted snapshot', async () => {
    await mount(true);
    expect(button('Save')).toBeUndefined(); expect(button('Delete')).toBeUndefined();
    expect(button('Save as…').disabled).toBe(false);
  });
  it('keeps a rejected target editable and submits another name', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValueOnce({ ok: false, error: 'A preset with that name already exists' });
    await mount(); await click('Save as…');
    expect(document.querySelector('input')!.value).toBe('P');
    await name('Occupied'); await click('Save preset');
    expect(document.body.textContent).toContain('already exists');
    expect(document.querySelector('input')!.value).toBe('Occupied');
    await name('New preset');
    vi.mocked(commitUserPresetMutation).mockResolvedValueOnce({ ok: true, canonicalName: 'New preset' } as never);
    await click('Save preset');
    expect(commitUserPresetMutation).toHaveBeenLastCalledWith(expect.anything(), {
      action: 'save-as', kind: 'filament', canonicalName: 'P', expectedRevision: 7, name: 'New preset', confirmOverwrite: false,
    }, null);
    expect(document.querySelector('input')).toBeNull();
  });
  it('saves the original name through the dialog without a separate Save button', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValue({ ok: true, canonicalName: 'P' } as never);
    await mount(); expect(button('Save')).toBeUndefined();
    await click('Save as…'); await click('Save preset');
    expect(commitUserPresetMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'save-as', name: 'P', confirmOverwrite: false,
    }), null);
  });
  it('warns before overwriting another incompatible user preset', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValue({ ok: true, canonicalName: 'Q' } as never);
    const lookup = await mount();
    const source = await lookup();
    lookup.mockImplementation(async (_kind?: unknown, requested?: string) => requested === 'Q'
      ? { ...source, canonicalName: 'Q', overwriteName: 'Q', compatible: false } : source);
    await click('Save as…'); await name('Q');
    expect(document.body.textContent).toContain('incompatible with the current printer');
    expect(document.body.textContent).toContain('Saving will overwrite this preset');
    await click('Save preset');
    expect(commitUserPresetMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'save-as', name: 'Q', confirmOverwrite: true,
    }), null);
  });
  it('does not overwrite when Enter precedes the target warning', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValue({ ok: true, canonicalName: 'Q' } as never);
    const lookup = await mount(); const source = await lookup();
    let resolveDestination!: (value: typeof source) => void;
    const destination = new Promise<typeof source>(resolve => { resolveDestination = resolve; });
    lookup.mockImplementation(async (_kind?: unknown, requested?: string) => requested === 'Q' ? destination : source);
    await click('Save as…'); await name('Q'); await click('Save preset');
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
    await act(async () => { resolveDestination({ ...source, canonicalName: 'Q', overwriteName: 'Q' }); });
    expect(document.body.textContent).toContain('Saving will overwrite this preset');
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
    await click('Save preset');
    expect(commitUserPresetMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ confirmOverwrite: true }), null);
  });
  it('confirms deletion and waits for pending option edits before reading the revision', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValue({ ok: true, canonicalName: 'System' } as never);
    const info = await mount(); await click('Delete');
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
    await click('Delete preset');
    expect(waitForConfigurationMutations).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalled();
    expect(commitUserPresetMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'delete', expectedRevision: 7 }), null);
  });
});
