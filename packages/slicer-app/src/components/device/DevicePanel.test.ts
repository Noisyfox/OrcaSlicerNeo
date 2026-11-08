import { describe, expect, it, vi } from 'vitest';
import type { WebViewHost, WebViewPanel, WebViewPanelCapabilities } from '@orca/platform-contract';
import type { PrinterConfiguration } from '@orca/printer-control';
import { mountPrinterConsolePanel, panelMessage, removePrinter } from './DevicePanel';

const capabilities: WebViewPanelCapabilities = {
  canInjectBuiltInScripts: true,
  canExposeHostApi: false,
  canExecuteJavaScript: false,
};

const printer: PrinterConfiguration = {
  id: 'p1', displayName: 'Living room', driverId: 'moonraker',
  consoleUrl: 'http://printer.local/console', apiBaseUrl: 'http://printer.local:7125/', apiKey: 'secret-key',
};

function fakeHost(calls: string[]): WebViewHost {
  const panel: WebViewPanel = {
    capabilities,
    state: { status: 'idle', url: null, error: null },
    load(url) { calls.push(`load:${url}`); },
    registerBuiltInScript(request) { calls.push(`register:${request.scriptId}`); return { status: 'ok' }; },
    exposeHostApi() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    async executeJavaScript() { return { status: 'unsupported', reason: 'capability-unavailable' }; },
    dispose() { calls.push('dispose'); },
  };
  return {
    capabilities,
    mount() { calls.push('mount'); return panel; },
  };
}

describe('Device printer configuration helpers', () => {
  it('deletes by stable id', () => {
    const removed = removePrinter([printer], printer.id);
    expect(removed.printers).toEqual([]);
  });

  it('uses the required mount, injection, load order and disposes', () => {
    const calls: string[] = [];
    const states: string[] = [];
    const dispose = mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, printer, printer.consoleUrl, (state) => states.push(state.status));
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', 'load:http://printer.local/console']);
    dispose();
    dispose();
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', 'load:http://printer.local/console', 'dispose']);
    expect(states).toEqual(['idle']);
  });

  it('uses the API base URL for the console when no console URL is configured', () => {
    const calls: string[] = [];
    const blankConsolePrinter = { ...printer, consoleUrl: '' };
    mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, blankConsolePrinter, printer.apiBaseUrl, vi.fn());
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', `load:${printer.apiBaseUrl}`]);
  });

  it('does not request injection when the key is empty', () => {
    const calls: string[] = [];
    mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, { ...printer, apiKey: '' }, printer.consoleUrl, vi.fn());
    expect(calls).toEqual(['mount', 'load:http://printer.local/console']);
  });

  it('uses generic visible status text and never echoes panel error details', () => {
    const secret = printer.apiKey;
    expect(panelMessage({ status: 'error', url: printer.consoleUrl, error: secret })).not.toContain(secret);
    expect(panelMessage({ status: 'error', url: printer.consoleUrl, error: secret })).toBe('The printer console could not be loaded.');
    expect(panelMessage({ status: 'loading', url: printer.consoleUrl, error: null })).toBe('Loading printer console…');
    expect(panelMessage({ status: 'loaded', url: printer.consoleUrl, error: null })).toBeNull();
    expect(panelMessage({ status: 'idle', url: null, error: null })).toBeNull();
  });
});
