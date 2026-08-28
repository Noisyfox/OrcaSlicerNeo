// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type WebViewHost, type WebViewPanel, type WebViewPanelCapabilities } from '@orca/platform-contract';
import type { PrinterConfiguration, PrinterConfigurationDocument } from '@orca/printer-control';
import { Workspace } from './Workspace';

// The scene components are intentionally not part of this lifecycle test. A
// mocked scene keeps the test focused on tab ownership while still rendering
// the real Workspace and DevicePanel composition.
vi.mock('./objectList/ObjectList', () => ({ ObjectList: () => <div data-testid="mock-object-list" /> }));
vi.mock('./settings/SettingsPanel', () => ({ SettingsPanel: () => <div data-testid="mock-settings-panel" /> }));
vi.mock('./viewport/Viewport', () => ({ Viewport: () => <div data-testid="mock-viewport" /> }));

const capabilities: WebViewPanelCapabilities = {
  canInjectBuiltInScripts: true,
  canExposeHostApi: false,
  canExecuteJavaScript: false,
};

const printer: PrinterConfiguration = {
  id: 'p1',
  displayName: 'Workshop',
  driverId: 'moonraker',
  consoleUrl: 'http://printer.local/console',
  apiBaseUrl: 'http://printer.local:7125/',
  apiKey: 'test-key',
};

function makePlatform(calls: string[]) {
  let documentValue: PrinterConfigurationDocument = { version: 1, printers: [printer] };
  const configuration = {
    load: vi.fn(async () => documentValue),
    save: vi.fn(async (next: PrinterConfigurationDocument) => { documentValue = next; }),
  };
  const panel: WebViewPanel = {
    capabilities,
    state: { status: 'idle', url: null, error: null },
    load(url) { calls.push(`load:${url}`); },
    registerBuiltInScript(request) {
      calls.push(`register:${request.scriptId}`);
      return { status: 'ok' };
    },
    exposeHostApi() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    async executeJavaScript() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    dispose() { calls.push('dispose'); },
  };
  const webview: WebViewHost = {
    capabilities,
    mount(container) {
      calls.push('mount');
      const iframe = document.createElement('iframe');
      iframe.title = 'Printer console';
      container.append(iframe);
      return panel;
    },
  };
  return {
    platform: {
      preferences: {
        load: vi.fn(async () => ({ version: 1 as const, selected: {}, ui: { sidebarWidth: 288 } })),
        save: vi.fn(async () => undefined),
      },
      printers: { configuration, transport: {} },
      webview,
    } as unknown as PlatformCapabilities,
  };
}

async function renderWorkspace(root: Root, platform: PlatformCapabilities, activeTab: 'home' | 'prepare' | 'preview' | 'Device') {
  await act(async () => {
    root.render(
      <PlatformProvider value={platform}>
        <Workspace activeTab={activeTab} />
      </PlatformProvider>,
    );
  });
}

async function click(container: HTMLElement, testId: string) {
  await act(async () => {
    (container.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  });
}

describe('Workspace tab panel lifecycle', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
  });

  it('keeps Device state and its guest mounted across every workspace tab', async () => {
    const calls: string[] = [];
    const { platform } = makePlatform(calls);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await renderWorkspace(root, platform, 'Device');
    await click(container, 'device-select-p1');
    const devicePanel = container.querySelector('[data-testid="device-panel"]');
    const iframe = container.querySelector('iframe');
    expect(devicePanel).not.toBeNull();
    expect(iframe).not.toBeNull();
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', `load:${printer.consoleUrl}`]);

    await click(container, 'device-add-printer');
    const dialog = container.querySelector('[data-testid="device-config-dialog"]');
    expect(dialog).not.toBeNull();

    for (const activeTab of ['home', 'prepare', 'preview', 'Device'] as const) {
      await renderWorkspace(root, platform, activeTab);
      const homePanel = container.querySelector('#workspace-panel-home') as HTMLElement;
      const deviceTabPanel = container.querySelector('#workspace-panel-device') as HTMLElement;
      expect(homePanel.hidden).toBe(activeTab === 'Device');
      expect(deviceTabPanel.hidden).toBe(activeTab !== 'Device');
      const activePanel = activeTab === 'Device' ? deviceTabPanel : homePanel;
      const inactivePanel = activeTab === 'Device' ? homePanel : deviceTabPanel;
      expect(activePanel.getAttribute('aria-hidden')).toBe('false');
      expect(activePanel.hasAttribute('inert')).toBe(false);
      expect(inactivePanel.getAttribute('aria-hidden')).toBe('true');
      expect(inactivePanel.hasAttribute('inert')).toBe(true);
      expect(container.querySelector('[data-testid="device-panel"]')).toBe(devicePanel);
      expect(container.querySelector('[data-testid="device-config-dialog"]')).toBe(dialog);
      expect(container.querySelector('iframe')).toBe(iframe);
    }

    expect(calls.filter((call) => call === 'mount')).toHaveLength(1);
    expect(calls).not.toContain('dispose');
  });
});
