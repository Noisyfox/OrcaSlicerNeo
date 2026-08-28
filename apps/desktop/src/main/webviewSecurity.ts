const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

interface GuestContents {
  getType(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

export interface WebViewAttachEvent {
  preventDefault(): void;
}

export interface WebViewAttachPreferences {
  preload?: string;
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  [key: string]: unknown;
}

export interface WebViewAttachParams {
  src?: unknown;
  preload?: string;
  [key: string]: unknown;
}

interface EmbedderContents {
  on(event: 'will-attach-webview', listener: (
    event: WebViewAttachEvent,
    webPreferences: WebViewAttachPreferences,
    params: WebViewAttachParams,
  ) => void): unknown;
}

/** Reject credentials and every non-http(s) protocol at the guest boundary. */
export function isSafeWebViewExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Sanitize the guest before Electron creates its renderer. This is the
 * security boundary that prevents a supplied webview preload from running
 * before the guest's nodeIntegration/contextIsolation settings take effect.
 */
export function sanitizeWebViewAttachment(
  event: WebViewAttachEvent,
  webPreferences: WebViewAttachPreferences,
  params: WebViewAttachParams,
): boolean {
  delete webPreferences.preload;
  delete params.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  if (params.src === undefined || params.src === '') return true;
  if (typeof params.src !== 'string' || !isSafeWebViewExternalUrl(params.src)) {
    event.preventDefault();
    return false;
  }
  return true;
}

/** Register the pre-creation policy on the main renderer (embedder). */
export function configureWebViewAttachPolicy(contents: EmbedderContents): void {
  contents.on('will-attach-webview', sanitizeWebViewAttachment);
}

/**
 * Install policy only on Electron webview guests. The parent renderer and its
 * own navigation are deliberately not covered by this handler.
 */
export function configureWebViewGuest(
  contents: GuestContents,
  openExternal: (url: string) => Promise<void> | void,
): boolean {
  if (contents.getType() !== 'webview') return false;
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeWebViewExternalUrl(url)) void Promise.resolve(openExternal(url)).catch(() => undefined);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isSafeWebViewExternalUrl(url)) event.preventDefault();
  });
  return true;
}
