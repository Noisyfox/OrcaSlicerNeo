// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_RECENT_PROJECTS, PlatformProvider, type PlatformCapabilities, type RecentProjectsCapability } from '@orca/platform-contract';
import { HomePage } from './HomePage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let dispose = () => {};
afterEach(() => { dispose(); });
async function render(recentProjects: RecentProjectsCapability = NO_RECENT_PROJECTS) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn(async () => {}), onCreate = vi.fn(async () => {}), onOpenRecent = vi.fn(async (_id: string) => {});
  const props = { active: true, canOpen: true, canCreate: true, onOpen, onCreate, onOpenRecent };
  const platform = { recentProjects } as PlatformCapabilities;
  const update = async (next = {}) => { await act(async () => root.render(<PlatformProvider value={platform}><HomePage {...props} {...next} /></PlatformProvider>)); };
  await update();
  dispose = () => { act(() => root.unmount()); container.remove(); };
  return { container, onOpen, onCreate, onOpenRecent, update };
}
async function click(button: Element | null) { expect(button).not.toBeNull(); await act(async () => (button as HTMLButtonElement).click()); }

describe('Home page', () => {
  it('offers New/Open and renders the Web empty state', async () => {
    const { container, onOpen, onCreate } = await render();
    expect(container.textContent).toContain('No recent projects');
    expect(container.querySelector('[data-testid="home-clear-recent"]')).toBeNull();
    await click(container.querySelector('[data-testid="home-new-project"]'));
    await click(container.querySelector('[data-testid="home-open-project"]'));
    expect(onCreate).toHaveBeenCalledOnce(); expect(onOpen).toHaveBeenCalledOnce();
  });
  it('opens a missing record by id and honors command availability', async () => {
    const { container, onOpenRecent, update } = await render({ ...NO_RECENT_PROJECTS,
      list: async () => [{ id: 'opaque', displayName: '<Robot>.3mf', modifiedAt: null, missing: true }],
    });
    expect(container.textContent).toContain('File is missing');
    const button = container.querySelector('button[aria-label="Open <Robot>.3mf"]');
    await click(button); expect(onOpenRecent).toHaveBeenCalledWith('opaque');
    await update({ canOpen: false, canCreate: false });
    await click(button); expect(onOpenRecent).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="home-new-project"]')?.hasAttribute('disabled')).toBe(true);
  });
  it('keeps history visible when clearing fails and can retry successfully', async () => {
    let entries = [{ id: 'opaque', displayName: 'Robot.3mf', modifiedAt: 1, missing: false }];
    const clear = vi.fn<() => Promise<void>>(async () => { throw new Error('disk full'); });
    const { container } = await render({ ...NO_RECENT_PROJECTS, list: async () => entries, clear });
    await click(container.querySelector('[data-testid="home-clear-recent"]'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Recent projects could not be cleared.');
    expect(container.textContent).toContain('Robot.3mf');
    clear.mockImplementation(async () => { entries = []; });
    await click(container.querySelector('[data-testid="home-clear-recent"]'));
    expect(container.textContent).toContain('No recent projects');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
