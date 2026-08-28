import type {
  BuiltInScriptRequest,
  WebViewHost,
  WebViewPanel,
  WebViewPanelCapabilities,
  WebViewPanelEvents,
  WebViewPanelOptions,
  WebViewPanelState,
  WebViewOperationResult,
} from '@orca/platform-contract';

/** The only script shipped by the first printer-console adapter. */
export const MOONRAKER_FETCH_SCRIPT_ID = 'moonraker-fetch-v1' as const;
export const PRINTER_CONSOLE_HOST_API_NAME = 'orca-printer-console' as const;

export const ELECTRON_WEBVIEW_CAPABILITIES: WebViewPanelCapabilities = Object.freeze({
  canInjectBuiltInScripts: true,
  canExposeHostApi: true,
  canExecuteJavaScript: true,
});

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_API_KEY_LENGTH = 4096;
const MAX_HOST_API_BYTES = 16 * 1024;
const SENSITIVE_API_FIELD = /(?:api[-_]?key|token|secret|password|credential)/i;

/** URL policy shared by the renderer event guard and the main-process guest guard. */
export function isAllowedWebViewUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** API keys never enter diagnostics, URLs, or a page-visible object. */
export function validateMoonrakerApiKeyContext(value: unknown): value is { apiKey: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.apiKey !== 'string') return false;
  return record.apiKey.length > 0 && record.apiKey.length <= MAX_API_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(record.apiKey);
}

/**
 * Generate the reviewed, fixed Moonraker fetch adapter. The only dynamic value
 * is JSON-encoded data validated by validateMoonrakerApiKeyContext; callers
 * cannot supply script source.
 */
export function createMoonrakerFetchScript(apiKey: string): string {
  // JSON.stringify is used as a JavaScript string literal encoder. Replacing
  // the two Unicode line separators also protects older JS parsers.
  const encodedKey = JSON.stringify(apiKey).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(function(){
  'use strict';
  var marker = '__orcaSlicerNeoMoonrakerFetchV1';
  if (window[marker] || typeof window.fetch !== 'function' || typeof window.Headers !== 'function') return;
  var apiKey = ${encodedKey};
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    var nextInit = init ? Object.assign({}, init) : {};
    var sourceHeaders = init && init.headers;
    if (!sourceHeaders && input && typeof input === 'object' && input.headers) sourceHeaders = input.headers;
    var headers = new Headers(sourceHeaders);
    headers.set('X-API-Key', apiKey);
    nextInit.headers = headers;
    return originalFetch.call(this, input, nextInit);
  };
  try { Object.defineProperty(window, marker, { value: true, configurable: false }); } catch (_) { window[marker] = true; }
})();`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeHostApiValue(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 32 && value.every((item) => isSafeHostApiValue(item, depth + 1));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    !SENSITIVE_API_FIELD.test(key) && isSafeHostApiValue(item, depth + 1));
}

/**
 * Host API exposure is intentionally a small, data-only capability. Functions,
 * credentials, and arbitrary names are rejected; no page-to-host callback or
 * RPC bridge is created by this adapter.
 */
export function validateHostApi(name: string, api: unknown): boolean {
  if (name !== PRINTER_CONSOLE_HOST_API_NAME || !isPlainRecord(api) || !isSafeHostApiValue(api)) return false;
  const serialized = JSON.stringify(api);
  return serialized !== undefined && serialized.length <= MAX_HOST_API_BYTES;
}

function createHostApiScript(api: Record<string, unknown>): string {
  const serialized = JSON.stringify(api);
  // The wrapper is fixed code; serialized data is parsed as JSON in the guest.
  return `(function(){'use strict';var value=JSON.parse(${JSON.stringify(serialized)});Object.defineProperty(window,'__orcaSlicerNeoPrinterConsoleApi',{configurable:true,enumerable:false,writable:false,value:Object.freeze(value)});})();`;
}

interface ElectronWebViewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  reload(): void;
  executeJavaScript<T = unknown>(script: string, userGesture?: boolean): Promise<T>;
  addContentScripts(details: Array<{
    name: string;
    matches: string[];
    js: string[];
    runAt: 'document_start';
    world: 'MAIN';
  }>): Promise<string[]>;
}

const unsupported = (): WebViewOperationResult => ({
  status: 'unsupported',
  reason: 'capability-unavailable',
});

class ElectronWebViewPanel implements WebViewPanel {
  readonly capabilities = ELECTRON_WEBVIEW_CAPABILITIES;
  readonly state: WebViewPanelState = { status: 'idle', url: null, error: null };
  private readonly webview: ElectronWebViewElement;
  private readonly events: WebViewPanelEvents;
  private disposed = false;
  private attached = false;
  private attachResolve: (() => void) | null = null;
  private readonly attachReady: Promise<void>;
  private script: { id: string; source: string } | null = null;
  private hostApi: { name: string; source: string } | null = null;
  private installPromise: Promise<void> = Promise.resolve();
  private installedSignature = '';

  constructor(ownerDocument: Document, options: WebViewPanelOptions, events: WebViewPanelEvents) {
    this.events = events;
    this.webview = ownerDocument.createElement('webview') as ElectronWebViewElement;
    this.webview.title = options.title ?? 'Embedded printer console';
    // Chromium does not create a guest for a src-less webview consistently
    // (notably in headless Electron). Keep the lifecycle's blank initial
    // document explicit; the main-process attach policy permits this
    // placeholder, and load() replaces it after content-script registration.
    this.webview.setAttribute('src', 'about:blank');
    // Explicitly deny guest-created child windows. Main also installs a guest
    // setWindowOpenHandler so window.open is covered before renderer events.
    this.webview.setAttribute('allowpopups', 'false');
    this.attachReady = new Promise((resolve) => { this.attachResolve = resolve; });
    this.webview.addEventListener('did-attach', this.handleAttach);
    this.webview.addEventListener('did-start-loading', this.handleStartLoading);
    this.webview.addEventListener('did-stop-loading', this.handleStopLoading);
    this.webview.addEventListener('did-finish-load', this.handleFinishLoad);
    this.webview.addEventListener('did-fail-load', this.handleFailLoad);
    this.webview.addEventListener('did-navigate', this.handleNavigate);
    this.webview.addEventListener('did-navigate-in-page', this.handleNavigate);
    this.webview.addEventListener('will-navigate', this.handleWillNavigate);
    this.webview.addEventListener('destroyed', this.handleDestroyed);
    if (options.url) this.mountInitial(options.url);
  }

  mount(container: HTMLElement, _options: WebViewPanelOptions): void {
    container.append(this.webview);
  }

  registerBuiltInScript(request: BuiltInScriptRequest): WebViewOperationResult {
    if (request.scriptId !== MOONRAKER_FETCH_SCRIPT_ID || !validateMoonrakerApiKeyContext(request.context)) {
      return unsupported();
    }
    this.script = { id: request.scriptId, source: createMoonrakerFetchScript(request.context.apiKey) };
    this.scheduleInstall();
    return { status: 'ok' };
  }

  exposeHostApi(name: string, api: unknown): WebViewOperationResult {
    if (!validateHostApi(name, api)) return unsupported();
    this.hostApi = { name, source: createHostApiScript(api as Record<string, unknown>) };
    this.scheduleInstall();
    return { status: 'ok' };
  }

  async executeJavaScript<T = unknown>(script: string): Promise<WebViewOperationResult<T>> {
    if (this.disposed) return unsupported() as WebViewOperationResult<T>;
    try {
      await this.attachReady;
      if (this.disposed || !this.attached) return unsupported() as WebViewOperationResult<T>;
      return { status: 'ok', value: await this.webview.executeJavaScript<T>(script, false) };
    } catch {
      return { status: 'unsupported', reason: 'capability-unavailable' } as WebViewOperationResult<T>;
    }
  }

  load(url: string): void {
    if (this.disposed || !isAllowedWebViewUrl(url)) {
      if (!this.disposed) this.updateState({ status: 'error', url: null, error: 'embedded navigation was blocked' });
      return;
    }
    this.updateState({ status: 'loading', url, error: null });
    this.scheduleInstall().then(() => {
      if (!this.disposed && this.state.url === url) {
        void this.webview.loadURL(url).then(() => this.runFallbackScripts()).catch(() => {
          if (!this.disposed) this.updateState({ status: 'error', url, error: 'embedded content failed to load' });
        });
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attachResolve?.();
    this.attachResolve = null;
    this.webview.removeEventListener('did-attach', this.handleAttach);
    this.webview.removeEventListener('did-start-loading', this.handleStartLoading);
    this.webview.removeEventListener('did-stop-loading', this.handleStopLoading);
    this.webview.removeEventListener('did-finish-load', this.handleFinishLoad);
    this.webview.removeEventListener('did-fail-load', this.handleFailLoad);
    this.webview.removeEventListener('did-navigate', this.handleNavigate);
    this.webview.removeEventListener('did-navigate-in-page', this.handleNavigate);
    this.webview.removeEventListener('will-navigate', this.handleWillNavigate);
    this.webview.removeEventListener('destroyed', this.handleDestroyed);
    this.webview.remove();
  }

  private mountInitial(url: string): void {
    // mount() appends first; the initial URL is loaded from the host's normal
    // mount flow after any explicit registerBuiltInScript call.
    this.state.url = url;
  }

  private scheduleInstall(): Promise<void> {
    this.installPromise = this.installPromise.then(async () => {
      if (this.disposed) return;
      await this.attachReady;
      if (!this.attached) return;
      const scripts = [
        ...(this.script ? [{ name: this.script.id, source: this.script.source }] : []),
        ...(this.hostApi ? [{ name: this.hostApi.name, source: this.hostApi.source }] : []),
      ];
      if (scripts.length === 0) return;
      const signature = scripts.map(({ name, source }) => `${name}:${source}`).join('|');
      if (signature === this.installedSignature) return;
      await this.webview.addContentScripts(scripts.map(({ name, source }) => ({
        name,
        matches: ['http://*/*', 'https://*/*'],
        js: [source],
        runAt: 'document_start' as const,
        world: 'MAIN' as const,
      })));
      this.installedSignature = signature;
    }).catch(() => {
      // Never include script source, key, or URL in diagnostics/state.
    });
    return this.installPromise;
  }

  private readonly handleAttach = (): void => {
    this.attached = true;
    this.attachResolve?.();
    this.attachResolve = null;
  };
  private readonly handleStartLoading = (): void => {
    if (this.disposed || !this.state.url) return;
    this.updateState({ status: 'loading', url: this.state.url, error: null });
    // Electron 43's WebViewTag does not expose addContentScripts (newer
    // Electron builds do). Run the reviewed fixed source as navigation starts
    // so the guest has the wrapper before its load handler executes. The
    // preferred document-start registration remains used whenever available.
    this.runFallbackScripts();
  };

  private runFallbackScripts(): void {
    if (this.disposed || this.installedSignature) return;
    const sources = [this.script?.source, this.hostApi?.source]
      .filter((source): source is string => Boolean(source));
    for (const source of sources) void this.webview.executeJavaScript(source, false).catch(() => undefined);
  }
  private readonly handleStopLoading = (): void => { /* did-finish-load supplies the loaded state. */ };
  private readonly handleFinishLoad = (): void => {
    if (this.disposed) return;
    this.updateState({ status: 'loaded', url: this.state.url, error: null });
    if (this.state.url) this.events.onNavigation?.(this.state.url);
  };
  private readonly handleFailLoad = (): void => {
    if (!this.disposed) this.updateState({ status: 'error', url: this.state.url, error: 'embedded content failed to load' });
  };
  private readonly handleNavigate = (event: Event): void => {
    if (this.disposed) return;
    const url = (event as Event & { url?: unknown }).url;
    if (isAllowedWebViewUrl(url)) this.events.onNavigation?.(url);
  };
  private readonly handleWillNavigate = (event: Event): void => {
    const url = (event as Event & { url?: unknown }).url;
    if (!isAllowedWebViewUrl(url)) event.preventDefault();
  };
  private readonly handleDestroyed = (): void => {
    if (!this.disposed) this.updateState({ status: 'error', url: this.state.url, error: 'embedded content stopped' });
  };

  private updateState(next: WebViewPanelState): void {
    this.state.status = next.status;
    this.state.url = next.url;
    this.state.error = next.error;
    this.events.onStateChange?.({ ...this.state });
  }
}

export interface ElectronWebViewOptions { document?: Document }

export function createElectronWebViewHost(options: ElectronWebViewOptions = {}): WebViewHost {
  return {
    capabilities: ELECTRON_WEBVIEW_CAPABILITIES,
    mount(container, panelOptions = {}, events = {}) {
      // Adapter construction is also used by Node-side unit tests. Resolve
      // the DOM lazily because only an actual mount needs Electron's document.
      const ownerDocument = options.document ?? (typeof document !== 'undefined' ? document : null);
      if (!ownerDocument) throw new Error('Electron WebView requires a renderer document');
      const panel = new ElectronWebViewPanel(ownerDocument, panelOptions, events);
      panel.mount(container, panelOptions);
      if (panelOptions.url) panel.load(panelOptions.url);
      return panel;
    },
  };
}
