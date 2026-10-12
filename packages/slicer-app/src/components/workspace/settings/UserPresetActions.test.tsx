// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { UserPresetActions } from './UserPresetActions';
import { commitUserPresetMutation, commitScopedConfigurationMutation, waitForConfigurationMutations } from './configurationActions';
vi.mock('./configurationActions', () => ({ commitUserPresetMutation: vi.fn(), commitScopedConfigurationMutation: vi.fn(), waitForConfigurationMutations: vi.fn(async () => {}) }));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
let root: Root;
afterEach(async () => { if (root) await act(async () => root.unmount()); document.body.innerHTML = ''; vi.clearAllMocks(); });
async function mount(deleted = false, kind: 'filament' | 'print' = 'filament') {
  const getUserPresetInfo = vi.fn(async () => ({ ok: true, kind: 'filament', canonicalName: 'P', label: deleted ? 'P (Deleted)' : 'P',
    defaultSaveAsName: 'P', canSave: !deleted, canDelete: !deleted, canReset: kind === 'print', deleted, revision: 7 }));
  const platform = { runtime: { getUserPresetInfo } } as unknown as PlatformCapabilities;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<PlatformProvider value={platform}><UserPresetActions kind={kind} canonicalName="P" /></PlatformProvider>));
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
  it('lets Process snapshots adopt the head even when the parameter diff is empty', async () => {
    await mount(false, 'print'); await click('Reset preset');
    expect(commitScopedConfigurationMutation).toHaveBeenCalledWith(expect.anything(), {
      version: 1, operation: 'reset-all', targets: [{ scope: 'project' }],
    });
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
  });
  it('only offers Save as for a deleted snapshot', async () => {
    await mount(true);
    expect(button('Save')).toBeUndefined(); expect(button('Delete')).toBeUndefined();
    expect(button('Save as…').disabled).toBe(false);
  });
  it('keeps an occupied name editable after rejection and submits a new name', async () => {
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
      action: 'save-as', kind: 'filament', canonicalName: 'P', expectedRevision: 7, name: 'New preset',
    });
    expect(document.querySelector('input')).toBeNull();
  });
  it('confirms deletion and waits for pending option edits before reading the revision', async () => {
    vi.mocked(commitUserPresetMutation).mockResolvedValue({ ok: true, canonicalName: 'System' } as never);
    const info = await mount(); await click('Delete');
    expect(commitUserPresetMutation).not.toHaveBeenCalled();
    await click('Delete preset');
    expect(waitForConfigurationMutations).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalled();
    expect(commitUserPresetMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'delete', expectedRevision: 7 }));
  });
});
