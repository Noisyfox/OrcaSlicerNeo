import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserWebViewHost } from './browserWebView';

describe('browser WebView host', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('mounts a normal iframe without sandbox and navigates only through load', () => {
    const container = document.createElement('div');
    const onStateChange = vi.fn();
    const onNavigation = vi.fn();
    const panel = createBrowserWebViewHost().mount(container, {
      url: 'https://printer.example/console',
      title: 'Printer console',
    }, { onStateChange, onNavigation });
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBeNull();
    expect(iframe!.title).toBe('Printer console');
    expect(iframe!.getAttribute('src')).toBe('https://printer.example/console');
    expect(panel.state).toMatchObject({ status: 'loading', url: 'https://printer.example/console', error: null });

    iframe!.dispatchEvent(new Event('load'));
    expect(panel.state.status).toBe('loaded');
    expect(onNavigation).toHaveBeenCalledWith('https://printer.example/console');
    panel.load('https://printer.example/other');
    expect(iframe!.getAttribute('src')).toBe('https://printer.example/other');
    expect(panel.state.status).toBe('loading');
    expect(onStateChange).toHaveBeenCalledWith({ status: 'loading', url: 'https://printer.example/other', error: null });
  });

  it('reports load failures without exposing page details', () => {
    const info = vi.fn();
    const onStateChange = vi.fn();
    const container = document.createElement('div');
    const panel = createBrowserWebViewHost({ logger: { info } }).mount(container, { url: 'https://printer.example/console' }, { onStateChange });
    container.querySelector('iframe')!.dispatchEvent(new Event('error'));
    expect(panel.state).toEqual({ status: 'error', url: 'https://printer.example/console', error: 'embedded content failed to load' });
    expect(onStateChange).toHaveBeenLastCalledWith(panel.state);
    expect(info).not.toHaveBeenCalled();
  });

  it('safely ignores script, host API, and page-JS requests with redacted diagnostics', async () => {
    const info = vi.fn();
    const panel = createBrowserWebViewHost({ logger: { info } }).mount(document.createElement('div'));
    const apiKey = 'super-secret-api-key';
    expect(panel.capabilities).toEqual({ canInjectBuiltInScripts: false, canExposeHostApi: false, canExecuteJavaScript: false });
    expect(panel.registerBuiltInScript({ scriptId: 'moonraker-fetch-v1', context: { apiKey } })).toEqual({ status: 'unsupported', reason: 'capability-unavailable' });
    expect(panel.exposeHostApi('printer', { apiKey })).toEqual({ status: 'unsupported', reason: 'capability-unavailable' });
    await expect(panel.executeJavaScript(`window.fetch('/status', { key: '${apiKey}' })`)).resolves.toEqual({ status: 'unsupported', reason: 'capability-unavailable' });
    const diagnostics = JSON.stringify(info.mock.calls);
    expect(diagnostics).not.toContain(apiKey);
    expect(diagnostics).not.toContain('window.fetch');
    expect(diagnostics).not.toContain('https://printer.example');
    expect(info).toHaveBeenCalledTimes(3);
  });

  it('disposes the iframe and ignores later navigation', () => {
    const container = document.createElement('div');
    const panel = createBrowserWebViewHost().mount(container, { url: 'https://printer.example/console' });
    panel.dispose();
    expect(container.querySelector('iframe')).toBeNull();
    panel.load('https://printer.example/other');
    expect(panel.state.url).toBe('https://printer.example/console');
  });
});
