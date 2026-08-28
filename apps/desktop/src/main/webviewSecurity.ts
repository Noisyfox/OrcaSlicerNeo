const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

interface GuestContents {
  getType(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
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
