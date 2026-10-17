// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_RECENT_PROJECTS, PlatformProvider, type PlatformCapabilities, type RecentProjectsCapability } from '@orca/platform-contract';
import { HomePage } from './HomePage';
import { useRecentProjects } from '@/recentProjects';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let dispose = () => {};
afterEach(() => { dispose(); });
async function render(recentProjects: RecentProjectsCapability = NO_RECENT_PROJECTS) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn(async () => {}), onCreate = vi.fn(async () => {}), onOpenRecent = vi.fn(async (_id: string) => {});
  const props = { active: true, canOpen: true, canCreate: true, onOpen, onCreate, onOpenRecent };
  const platform = { recentProjects } as PlatformCapabilities;
  function TestHome(next: Partial<typeof props>) {
    const values = { ...props, ...next };
    const history = useRecentProjects(values.active ? 'home' : 'prepare');
    return <HomePage {...values} history={history} />;
  }
  const update = async (next = {}) => { await act(async () => root.render(<PlatformProvider value={platform}><TestHome {...next} /></PlatformProvider>)); };
  await update();
  dispose = () => { act(() => root.unmount()); container.remove(); };
  return { container, onOpen, onCreate, onOpenRecent, update };
}
async function click(button: Element | null) { expect(button).not.toBeNull(); await act(async () => (button as HTMLButtonElement).click()); }

describe('Home page', () => {
  it('renders the embedded PNG, falls back on decode failure and accepts a refreshed image', async () => {
    let thumbnailUrl = 'data:image/png;base64,first';
    const { container } = await render({ ...NO_RECENT_PROJECTS, thumbnail: async () => thumbnailUrl,
      list: async () => [{ id: 'opaque', displayName: 'Robot.3mf', displayPath: '/projects/Robot.3mf', modifiedAt: 1, missing: false }],
    });
    const button = container.querySelector('button[aria-label="Open Robot.3mf"]')!;
    expect(button.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
    await act(async () => { button.querySelector('img')!.dispatchEvent(new Event('error')); });
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    thumbnailUrl = 'data:image/png;base64,second';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(button.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
  });
  it('shows the list immediately, fills images independently, and keeps commands enabled while another image waits', async () => {
    const entries = ['slow', 'fast'].map(id => ({ id, displayName: `${id}.3mf`, displayPath: `/projects/${id}.3mf`, modifiedAt: 1, missing: false }));
    const releases = new Map<string, (url: string) => void>();
    const thumbnail = vi.fn((id: string) => new Promise<string>(resolve => releases.set(id, resolve)));
    const { container, onOpenRecent, onCreate } = await render({ ...NO_RECENT_PROJECTS, list: async () => entries, thumbnail });
    expect(container.querySelectorAll('[data-testid="home-recent-list"] li')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    await act(async () => { releases.get('fast')!('data:image/png;base64,fast'); });
    expect(container.querySelector('button[aria-label="Open fast.3mf"] img')?.getAttribute('src')).toBe('data:image/png;base64,fast');
    expect(container.querySelector('button[aria-label="Open slow.3mf"] img')).toBeNull();
    await click(container.querySelector('button[aria-label="Open slow.3mf"]'));
    expect(onOpenRecent).toHaveBeenCalledWith('slow');
    await click(container.querySelector('[data-testid="home-new-project"]'));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="home-open-project"]')?.hasAttribute('disabled')).toBe(false);
  });
  it('ignores old thumbnail responses after a refresh, tab change and removal', async () => {
    const project = { id: 'opaque', displayName: 'Robot.3mf', displayPath: '/projects/Robot.3mf', modifiedAt: 1, missing: false };
    let entries = [project];
    const releases: Array<(url: string) => void> = [];
    const { container, update } = await render({ ...NO_RECENT_PROJECTS,
      list: async () => entries,
      thumbnail: () => new Promise<string>(resolve => releases.push(resolve)),
    });
    entries = [{ ...project, modifiedAt: 2 }];
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { releases[0]('data:image/png;base64,stale'); });
    expect(container.querySelector('img')).toBeNull();
    await update({ active: false });
    await act(async () => { releases[1]('data:image/png;base64,hidden'); });
    expect(container.querySelector('img')).toBeNull();
    await update({ active: true });
    entries = [];
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await act(async () => { for (const release of releases) release('data:image/png;base64,removed'); });
    expect(container.querySelector('[data-testid="home-recent-empty"]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
  it('contains a thumbnail failure without failing the list or disabling actions', async () => {
    const { container } = await render({ ...NO_RECENT_PROJECTS,
      list: async () => [{ id: 'opaque', displayName: 'Robot.3mf', displayPath: '/projects/Robot.3mf', modifiedAt: 1, missing: false }],
      thumbnail: async () => { throw new Error('worker gone'); },
    });
    expect(container.textContent).toContain('Robot.3mf');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="home-open-project"]')?.hasAttribute('disabled')).toBe(false);
  });
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
      list: async () => [{ id: 'opaque', displayName: '<Robot>.3mf', displayPath: '/projects/<Robot>.3mf', modifiedAt: null, missing: true }],
    });
    expect(container.textContent).toContain('File is missing');
    const button = container.querySelector('button[aria-label="Open <Robot>.3mf"]');
    await click(button); expect(onOpenRecent).toHaveBeenCalledWith('opaque');
    await update({ canOpen: false, canCreate: false });
    await click(button); expect(onOpenRecent).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="home-new-project"]')?.hasAttribute('disabled')).toBe(true);
  });
  it('keeps history visible when clearing fails and can retry successfully', async () => {
    let entries = [{ id: 'opaque', displayName: 'Robot.3mf', displayPath: '/projects/Robot.3mf', modifiedAt: 1, missing: false }];
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
