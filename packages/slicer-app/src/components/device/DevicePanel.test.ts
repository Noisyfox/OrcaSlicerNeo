import { describe, expect, it, vi } from 'vitest';
import type { WebViewHost, WebViewPanel, WebViewPanelCapabilities } from '@orca/platform-contract';
import type { PrinterConfiguration } from '@orca/printer-control';
import { effectiveConsoleUrl, mountPrinterConsolePanel, panelMessage, removePrinter, savePrinterDraft, type PrinterDraft } from './DevicePanel';

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
  it('normalizes and saves multiple records without selecting one', () => {
    const draft: PrinterDraft = { ...printer, id: undefined, displayName: ' New printer ' };
    const document = savePrinterDraft([], draft, 'add', 'new-id');
    expect(document.printers).toHaveLength(1);
    expect(document.printers[0]).toMatchObject({ id: 'new-id', displayName: 'New printer', apiKey: 'secret-key' });
    expect(document).not.toHaveProperty('selectedPrinterId');
  });

  it('edits and deletes by stable id', () => {
    const edited = savePrinterDraft([printer], { ...printer, displayName: 'Edited' }, 'edit', printer.id);
    expect(edited.printers[0].displayName).toBe('Edited');
    const removed = removePrinter(edited.printers, printer.id);
    expect(removed.printers).toEqual([]);
  });

  it('uses the required mount, injection, load order and disposes', () => {
    const calls: string[] = [];
    const states: string[] = [];
    const dispose = mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, printer, (state) => states.push(state.status));
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', 'load:http://printer.local/console']);
    dispose();
    dispose();
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', 'load:http://printer.local/console', 'dispose']);
    expect(states).toEqual(['idle']);
  });

  it('uses the API base URL for the console when no console URL is configured', () => {
    const calls: string[] = [];
    const blankConsolePrinter = { ...printer, consoleUrl: '' };
    expect(effectiveConsoleUrl(blankConsolePrinter)).toBe(printer.apiBaseUrl);
    mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, blankConsolePrinter, vi.fn());
    expect(calls).toEqual(['mount', 'register:moonraker-fetch-v1', `load:${printer.apiBaseUrl}`]);
  });

  it('does not request injection when the key is empty', () => {
    const calls: string[] = [];
    mountPrinterConsolePanel(fakeHost(calls), {} as HTMLElement, { ...printer, apiKey: '' }, vi.fn());
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
