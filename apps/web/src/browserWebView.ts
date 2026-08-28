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

const WEB_IFRAME_CAPABILITIES: WebViewPanelCapabilities = Object.freeze({
  canInjectBuiltInScripts: false,
  canExposeHostApi: false,
  canExecuteJavaScript: false,
});

export interface WebViewDiagnosticLogger {
  info(message: string, details?: unknown): void;
}
export interface BrowserWebViewOptions {
  document?: Document;
  logger?: WebViewDiagnosticLogger;
}

const unsupported = (operation: string): WebViewOperationResult => ({
  status: 'unsupported',
  reason: 'capability-unavailable',
});

/**
 * A plain browser iframe. It deliberately never reads contentWindow or
 * contentDocument, so cross-origin pages remain outside the app's authority.
 */
class BrowserWebViewPanel implements WebViewPanel {
  readonly capabilities = WEB_IFRAME_CAPABILITIES;
  readonly state: WebViewPanelState = { status: 'idle', url: null, error: null };
  private readonly iframe: HTMLIFrameElement;
  private readonly events: WebViewPanelEvents;
  private readonly logger: WebViewDiagnosticLogger;
  private disposed = false;

  constructor(
    private readonly ownerDocument: Document,
    options: WebViewPanelOptions,
    events: WebViewPanelEvents,
    logger: WebViewDiagnosticLogger,
  ) {
    this.events = events;
    this.logger = logger;
    this.iframe = ownerDocument.createElement('iframe');
    // Do not add sandbox: printer consoles need their ordinary browser
    // scripts, forms, storage, downloads, and popup behavior.
    this.iframe.title = options.title ?? 'Embedded printer console';
    this.iframe.addEventListener('load', this.handleLoad);
    this.iframe.addEventListener('error', this.handleError);
  }

  mount(container: HTMLElement, options: WebViewPanelOptions): void {
    container.append(this.iframe);
    if (options.url) this.load(options.url);
  }

  load(url: string): void {
    if (this.disposed) return;
    this.updateState({ status: 'loading', url, error: null });
    // Setting src is the only navigation authority. No iframe DOM is read.
    this.iframe.src = url;
  }

  registerBuiltInScript(request: BuiltInScriptRequest): WebViewOperationResult {
    // The ID is useful diagnostics; source and context (which may contain a
    // credential) are intentionally never logged.
    this.logger.info('[webview] unsupported operation ignored: registerBuiltInScript', {
      operation: 'registerBuiltInScript',
      scriptId: request.scriptId,
    });
    return unsupported('registerBuiltInScript');
  }

  exposeHostApi(_name: string, _api: unknown): WebViewOperationResult {
    this.logger.info('[webview] unsupported operation ignored: exposeHostApi', {
      operation: 'exposeHostApi',
    });
    return unsupported('exposeHostApi');
  }

  async executeJavaScript<T = unknown>(_script: string): Promise<WebViewOperationResult<T>> {
    this.logger.info('[webview] unsupported operation ignored: executeJavaScript', {
      operation: 'executeJavaScript',
    });
    return unsupported('executeJavaScript') as WebViewOperationResult<T>;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.iframe.removeEventListener('load', this.handleLoad);
    this.iframe.removeEventListener('error', this.handleError);
    this.iframe.remove();
  }

  get element(): HTMLIFrameElement {
    return this.iframe;
  }

  private readonly handleLoad = (): void => {
    if (this.disposed) return;
    const url = this.state.url;
    this.updateState({ status: 'loaded', url, error: null });
    if (url) this.events.onNavigation?.(url);
  };

  private readonly handleError = (): void => {
    if (this.disposed) return;
    this.updateState({ status: 'error', url: this.state.url, error: 'embedded content failed to load' });
  };

  private updateState(next: WebViewPanelState): void {
    this.state.status = next.status;
    this.state.url = next.url;
    this.state.error = next.error;
    this.events.onStateChange?.({ ...this.state });
  }
}

/** Construct the Web iframe host. No support probe is performed. */
export function createBrowserWebViewHost(options: BrowserWebViewOptions = {}): WebViewHost {
  const ownerDocument = options.document ?? document;
  const logger = options.logger ?? console;
  return {
    capabilities: WEB_IFRAME_CAPABILITIES,
    mount(container, panelOptions = {}, events = {}) {
      const panel = new BrowserWebViewPanel(ownerDocument, panelOptions, events, logger);
      panel.mount(container, panelOptions);
      return panel;
    },
  };
}
