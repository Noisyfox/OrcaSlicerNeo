// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import type { AppTab } from './appTabs';

function StatefulPage({ label }: { label: string }) {
  return <button type="button" data-testid={`${label}-state`} onClick={(event) => { event.currentTarget.dataset.value = 'changed'; }}>{label}</button>;
}

describe('AppShell top-level pages', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
  });

  async function renderPage(container: HTMLElement, activeTab: AppTab, prewarmWorkspace = false) {
    await act(async () => {
      root?.render(
        <AppShell
          titleBar={<div />}
          toolbar={<div />}
          activeTab={activeTab}
          prewarmWorkspace={prewarmWorkspace}
          home={<StatefulPage label="home" />}
          workspace={<StatefulPage label="workspace" />}
          device={<StatefulPage label="device" />}
          status={<div />}
        />,
      );
    });
  }

  it('keeps all top-level page trees mounted and applies stable ARIA/inert semantics', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await renderPage(container, 'prepare');
    const home = container.querySelector('#app-panel-home') as HTMLElement;
    const workspace = container.querySelector('#app-panel-workspace') as HTMLElement;
    const device = container.querySelector('#app-panel-device') as HTMLElement;
    const homeState = container.querySelector('[data-testid="home-state"]') as HTMLButtonElement;
    const workspaceState = container.querySelector('[data-testid="workspace-state"]') as HTMLButtonElement;
    const deviceState = container.querySelector('[data-testid="device-state"]') as HTMLButtonElement;
    expect(homeState).not.toBeNull();
    expect(workspaceState).not.toBeNull();
    expect(deviceState).not.toBeNull();
    expect(home.hidden).toBe(true);
    expect(workspace.hidden).toBe(false);
    expect(device.hidden).toBe(true);
    expect(home.getAttribute('aria-labelledby')).toBe('app-tab-home');
    expect(workspace.getAttribute('aria-labelledby')).toBe('app-tab-prepare');
    expect(device.getAttribute('aria-labelledby')).toBe('app-tab-device');
    expect(home.hasAttribute('inert')).toBe(true);
    expect(workspace.hasAttribute('inert')).toBe(false);
    expect(device.hasAttribute('inert')).toBe(true);

    await act(async () => { deviceState.click(); });
    expect(deviceState.dataset.value).toBe('changed');
    await renderPage(container, 'device');
    expect(container.querySelector('[data-testid="workspace-state"]')).toBe(workspaceState);
    expect(container.querySelector('[data-testid="device-state"]')).toBe(deviceState);
    expect(workspace.hidden).toBe(true);
    expect(device.hidden).toBe(false);
    expect(workspace.hasAttribute('inert')).toBe(true);
    expect(device.hasAttribute('inert')).toBe(false);
    expect(deviceState.dataset.value).toBe('changed');

    await renderPage(container, 'home');
    expect(container.querySelector('[data-testid="home-state"]')).toBe(homeState);
    expect(home.hidden).toBe(false);
    expect(home.hasAttribute('inert')).toBe(false);
    expect(workspace.hidden).toBe(true);
    expect(device.hidden).toBe(true);
  });

  it('keeps a prewarming Workspace laid out but visually inaccessible', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await renderPage(container, 'home', true);
    const workspace = container.querySelector('#app-panel-workspace') as HTMLElement;
    expect(workspace.hidden).toBe(false);
    expect(workspace.hasAttribute('inert')).toBe(true);
    expect(workspace.classList.contains('invisible')).toBe(true);
  });
});
