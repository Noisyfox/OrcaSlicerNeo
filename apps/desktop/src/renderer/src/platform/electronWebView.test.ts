import { describe, expect, it, vi } from 'vitest';
import {
  createElectronWebViewHost,
  createMoonrakerFetchScript,
  isAllowedWebViewUrl,
  MOONRAKER_FETCH_SCRIPT_ID,
  PRINTER_CONSOLE_HOST_API_NAME,
  validateHostApi,
  validateMoonrakerApiKeyContext,
} from './electronWebView';

function setupWebview() {
  const addContentScripts = vi.fn(async () => ['script-1']);
  const loadURL = vi.fn(async () => {});
  const executeJavaScript = vi.fn(async () => ({ ok: true }));
  class FakeElement {
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, EventListener[] | undefined>();
    readonly attributes = new Map<string, string>();
    title = '';
    removed = false;
    addEventListener(name: string, listener: EventListener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    removeEventListener(name: string, listener: EventListener) {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
    }
    dispatchEvent(event: Event) {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
      return true;
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    append(child: FakeElement) { this.children.push(child); }
    remove() { this.removed = true; }
  }
  const webview = new FakeElement() as FakeElement & Record<string, unknown>;
  Object.assign(webview, {
    addContentScripts,
    loadURL,
    executeJavaScript,
    reload: vi.fn(),
  });
  const ownerDocument = {
    createElement: vi.fn((name: string) => name === 'webview' ? webview : new FakeElement()),
  } as unknown as Document;
  return { webview, ownerDocument, addContentScripts, loadURL, executeJavaScript };
}

describe('Electron webview security and lifecycle', () => {
  it('accepts only credential-free HTTP(S) URLs and the exact API-key context', () => {
    expect(isAllowedWebViewUrl('https://printer.example/ui')).toBe(true);
    expect(isAllowedWebViewUrl('http://127.0.0.1:7125/')).toBe(true);
    expect(isAllowedWebViewUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedWebViewUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedWebViewUrl('https://user:pass@printer.example/')).toBe(false);
    expect(validateMoonrakerApiKeyContext({ apiKey: 'secret-key' })).toBe(true);
    expect(validateMoonrakerApiKeyContext({ apiKey: 'secret-key', extra: true })).toBe(false);
    expect(validateMoonrakerApiKeyContext({ apiKey: '' })).toBe(false);
    expect(validateMoonrakerApiKeyContext({ apiKey: 'line\nbreak' })).toBe(false);
  });

  it('generates a fixed, idempotent fetch wrapper with Request/Headers support', () => {
    const script = createMoonrakerFetchScript('secret-"-key');
    expect(script).toContain("var marker = '__orcaSlicerNeoMoonrakerFetchV1'");
    expect(script).toContain("headers.set('X-API-Key', apiKey)");
    expect(script).toContain('new Headers(sourceHeaders)');
    expect(script).not.toContain('console.log');
    expect(script).toContain('secret-\\"-key');
  });

  it('executes the wrapper while preserving Request headers and honoring explicit init headers', () => {
    class FakeHeaders {
      private readonly values = new Map<string, string>();
      constructor(input?: FakeHeaders | Record<string, string>) {
        if (input instanceof FakeHeaders) input.values.forEach((value, key) => this.values.set(key, value));
        else Object.entries(input ?? {}).forEach(([key, value]) => this.values.set(key.toLowerCase(), value));
      }
      set(name: string, value: string) { this.values.set(name.toLowerCase(), value); }
      get(name: string) { return this.values.get(name.toLowerCase()) ?? null; }
    }
    const calls: Array<{ input: unknown; init: { headers: FakeHeaders } }> = [];
    const request = { url: 'https://printer.example/api', headers: new FakeHeaders({ 'X-Trace': 'request-value', 'X-API-Key': 'old-key' }) };
    const windowObject: { fetch?: (input: unknown, init: { headers: FakeHeaders }) => void; Headers?: typeof FakeHeaders } = {
      Headers: FakeHeaders,
      fetch: (input, init) => { calls.push({ input, init }); },
    };
    const script = createMoonrakerFetchScript('new-key');
    new Function('window', 'Headers', script)(windowObject, FakeHeaders);
    windowObject.fetch!(request, undefined as never);
    expect(calls[0].input).toBe(request);
    expect(calls[0].init.headers.get('X-Trace')).toBe('request-value');
    expect(calls[0].init.headers.get('X-API-Key')).toBe('new-key');

    windowObject.fetch!(request, { headers: { 'X-Trace': 'init-value', 'X-Other': 'init-only' } } as never);
    expect(calls[1].input).toBe(request);
    expect(calls[1].init.headers.get('X-Trace')).toBe('init-value');
    expect(calls[1].init.headers.get('X-Other')).toBe('init-only');
    expect(calls[1].init.headers.get('X-API-Key')).toBe('new-key');
  });

  it('exposes only a small data-only built-in host API', () => {
    expect(validateHostApi(PRINTER_CONSOLE_HOST_API_NAME, { version: 1, status: 'ready' })).toBe(true);
    expect(validateHostApi('arbitrary', { version: 1 })).toBe(false);
    expect(validateHostApi(PRINTER_CONSOLE_HOST_API_NAME, { callback: () => {} })).toBe(false);
    expect(validateHostApi(PRINTER_CONSOLE_HOST_API_NAME, { apiKey: 'secret' })).toBe(false);
  });

  it('registers the built-in script before navigation and reports guest lifecycle', async () => {
    const { webview, ownerDocument, addContentScripts, loadURL, executeJavaScript } = setupWebview();
    const container = ownerDocument.createElement('div');
    const onStateChange = vi.fn();
    const onNavigation = vi.fn();
    const panel = createElectronWebViewHost({ document: ownerDocument }).mount(container, {}, { onStateChange, onNavigation });
    webview.dispatchEvent(new Event('did-attach'));
    expect(panel.registerBuiltInScript({ scriptId: MOONRAKER_FETCH_SCRIPT_ID, context: { apiKey: 'secret-key' } })).toEqual({ status: 'ok' });
    expect(panel.exposeHostApi(PRINTER_CONSOLE_HOST_API_NAME, { version: 1, status: 'ready' })).toEqual({ status: 'ok' });
    panel.load('https://printer.example/console');
    await vi.waitFor(() => expect(loadURL).toHaveBeenCalledWith('https://printer.example/console'));
    expect(addContentScripts).toHaveBeenCalledOnce();
    const registrations = (addContentScripts.mock.calls[0] as unknown[] | undefined)?.[0] as Array<Record<string, any>>;
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).toMatchObject({ name: MOONRAKER_FETCH_SCRIPT_ID, runAt: 'document_start', world: 'MAIN' });
    expect(registrations[0].js[0]).not.toContain('console.log');
    expect(registrations[0].js[0]).toContain('X-API-Key');
    expect(loadURL).toHaveBeenCalledWith('https://printer.example/console');
    webview.dispatchEvent(new Event('did-finish-load'));
    expect(panel.state.status).toBe('loaded');
    expect(onNavigation).toHaveBeenCalledWith('https://printer.example/console');
    await expect(panel.executeJavaScript('document.title')).resolves.toEqual({ status: 'ok', value: { ok: true } });
    expect(executeJavaScript).toHaveBeenCalledWith('document.title', false);
    panel.dispose();
    expect((webview as unknown as { removed: boolean }).removed).toBe(true);
  });

  it('rejects unknown scripts and unsafe navigations without loading them', async () => {
    const { webview, ownerDocument, loadURL } = setupWebview();
    const panel = createElectronWebViewHost({ document: ownerDocument }).mount(ownerDocument.createElement('div'));
    webview.dispatchEvent(new Event('did-attach'));
    expect(panel.registerBuiltInScript({ scriptId: 'user-script', context: { apiKey: 'secret' } })).toEqual({ status: 'unsupported', reason: 'capability-unavailable' });
    panel.load('javascript:alert(1)');
    expect(panel.state).toMatchObject({ status: 'error', url: null });
    expect(loadURL).not.toHaveBeenCalled();
  });
});
