// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities, type WebViewPanel, type WebViewPanelCapabilities, type WebViewHost } from '@orca/platform-contract';
import { DevicePanel } from '../../../packages/slicer-app/src/components/device/DevicePanel';
import type { PrinterConfiguration, PrinterConfigurationDocument } from '@orca/printer-control';

const printer: PrinterConfiguration = {
  id: 'p1', displayName: 'Workshop', driverId: 'moonraker',
  consoleUrl: 'http://printer.local/console', apiBaseUrl: 'http://printer.local:7125/', apiKey: 'do-not-display-this-key',
};

const capabilities: WebViewPanelCapabilities = {
  canInjectBuiltInScripts: true, canExposeHostApi: false, canExecuteJavaScript: false,
};

function makePlatform(calls: string[]) {
  let documentValue: PrinterConfigurationDocument = { version: 1, printers: [printer] };
  let preferences = { version: 1 as const, selectedProfiles: {}, ui: { sidebarWidth: 244, deviceSidebarWidth: 320 } };
  const configuration = {
    load: vi.fn(async () => documentValue),
    save: vi.fn(async (next: PrinterConfigurationDocument) => { documentValue = next; }),
  };
  const panel: WebViewPanel = {
    capabilities,
    state: { status: 'idle', url: null, error: null },
    load(url) { calls.push(`load:${url}`); },
    registerBuiltInScript(request) { calls.push(`register:${request.scriptId}`); return { status: 'ok' }; },
    exposeHostApi() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    async executeJavaScript() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    dispose() { calls.push('dispose'); },
  };
  const webview: WebViewHost = {
    capabilities,
    mount() { calls.push('mount'); return panel; },
  };
  const userPreferences = {
    load: vi.fn(async () => preferences),
    save: vi.fn(async (next: typeof preferences) => { preferences = next; }),
  };
  // DevicePanel consumes only these injected capabilities; the remaining
  // fields are inert typed seams for this component-level test.
  return {
    platform: {
      printers: { configuration, transport: {} },
      webview,
      preferences: userPreferences,
    } as unknown as PlatformCapabilities,
    configuration,
    preferences: userPreferences,
  };
}

function setInput(testId: string, value: string) {
  const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function click(testId: string) {
  await act(async () => {
    (document.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
  });
}

describe('DevicePanel component', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount();
    document.body.innerHTML = '';
  });

  it('renders, keeps Add unselected, masks the key, and saves edits', async () => {
    const calls: string[] = [];
    const { platform, configuration } = makePlatform(calls);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>);
    });
    expect(container.querySelector('[data-testid="device-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="device-select-p1"]')?.getAttribute('aria-pressed')).toBe('false');

    await click('device-add-printer');
    expect(container.querySelector('[data-testid="device-config-dialog"]')).not.toBeNull();
    const form = container.querySelector('[data-testid="device-config-dialog"] form') as HTMLFormElement;
    const formInputs = [...form.querySelectorAll('input')];
    expect(formInputs.findIndex((input) => input.dataset.testid === 'device-api-base-url'))
      .toBeLessThan(formInputs.findIndex((input) => input.dataset.testid === 'device-console-url'));
    expect((form.querySelector('[data-testid="device-console-url"]') as HTMLInputElement).required).toBe(false);
    const key = container.querySelector('[data-testid="device-api-key"]') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(container.textContent).not.toContain(printer.apiKey);
    setInput('device-display-name', 'Second printer');
    setInput('device-console-url', 'http://printer-two.local/console');
    setInput('device-api-base-url', 'http://printer-two.local:7125/');
    setInput('device-api-key', 'second-secret');
    await click('device-save-printer');
    expect(configuration.save).toHaveBeenCalledOnce();
    const selections = [...container.querySelectorAll('[data-testid^="device-select-"]')];
    expect(selections).toHaveLength(2);
    expect(selections.every((item) => item.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(configuration.save.mock.calls[0][0].printers).toHaveLength(2);
    expect(configuration.save.mock.calls[0][0].printers[1].apiKey).toBe('second-secret');

    await click('device-edit-p1');
    setInput('device-display-name', 'Edited workshop');
    await click('device-save-printer');
    expect(configuration.save.mock.calls.at(-1)?.[0].printers[0].displayName).toBe('Edited workshop');
  });

  it('requires delete confirmation, then disposes the selected console and shows empty state', async () => {
    const calls: string[] = [];
    const { platform, configuration } = makePlatform(calls);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>);
    });
    await click('device-select-p1');
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', `load:${printer.consoleUrl}`]);
    expect(container.querySelector('[data-testid="device-console-empty"]')).toBeNull();

    await click('device-delete-p1');
    expect(container.querySelector('[data-testid="device-delete-dialog"]')).not.toBeNull();
    expect(calls).not.toContain('dispose');
    await click('device-confirm-delete');
    expect(configuration.save.mock.calls.at(-1)?.[0].printers).toEqual([]);
    expect(calls).toContain('dispose');
    expect(container.querySelector('[data-testid="device-console-empty"]')?.textContent).toContain('Add a printer');
  });

  it('uses a card layout and persists device sidebar resizing independently', async () => {
    const calls: string[] = [];
    const { platform, preferences } = makePlatform(calls);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><DevicePanel /></PlatformProvider>);
    });

    const panel = container.querySelector('[data-testid="device-panel"]') as HTMLElement;
    const sidebar = panel.querySelector('aside') as HTMLElement;
    const console = panel.querySelector('main') as HTMLElement;
    const resizer = container.querySelector('[data-testid="device-sidebar-resizer"]') as HTMLElement;
    expect(panel.className.split(/\s+/).filter((className) => className.startsWith('gap-'))).toEqual([]);
    expect(sidebar.className).toContain('rounded-md');
    expect(sidebar.className).toContain('border');
    expect(sidebar.style.width).toBe('320px');
    expect(console.className).toContain('rounded-md');
    expect(console.className).toContain('border');
    expect(resizer.getAttribute('aria-valuenow')).toBe('320');
    expect(resizer.getAttribute('aria-valuemin')).toBe('220');
    expect(resizer.getAttribute('aria-valuemax')).toBe('560');

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(resizer.getAttribute('aria-valuenow')).toBe('336');
    await act(async () => { await Promise.resolve(); });
    expect(preferences.save).toHaveBeenCalledWith(expect.objectContaining({
      ui: { sidebarWidth: 244, deviceSidebarWidth: 336 },
    }));
  });
});
