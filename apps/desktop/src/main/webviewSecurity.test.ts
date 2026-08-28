import { describe, expect, it, vi } from 'vitest';
import { configureWebViewGuest, isSafeWebViewExternalUrl } from './webviewSecurity';

describe('Electron webview guest security', () => {
  it('allows only credential-free HTTP(S) external links', () => {
    expect(isSafeWebViewExternalUrl('https://printer.example/help')).toBe(true);
    expect(isSafeWebViewExternalUrl('http://127.0.0.1:7125/')).toBe(true);
    expect(isSafeWebViewExternalUrl('file:///tmp/a')).toBe(false);
    expect(isSafeWebViewExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeWebViewExternalUrl('data:text/html,hello')).toBe(false);
    expect(isSafeWebViewExternalUrl('https://user:pass@printer.example/')).toBe(false);
  });

  it('configures only webview guests, denies child windows, and opens safe URLs', async () => {
    let handler: ((details: { url: string }) => { action: 'deny' }) | undefined;
    let navigateListener: ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const contents = {
      getType: vi.fn(() => 'webview'),
      setWindowOpenHandler: vi.fn((value) => { handler = value; }),
      on: vi.fn((event: string, value: typeof navigateListener) => {
        if (event === 'will-navigate') navigateListener = value;
        return contents;
      }),
    };
    const openExternal = vi.fn(async () => {});
    expect(configureWebViewGuest(contents, openExternal)).toBe(true);
    expect(handler?.({ url: 'https://printer.example/help' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(handler?.({ url: 'file:///tmp/a' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledOnce();
    const blocked = { preventDefault: vi.fn() };
    navigateListener?.(blocked, 'data:text/html,blocked');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    const allowed = { preventDefault: vi.fn() };
    navigateListener?.(allowed, 'https://printer.example/next');
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  it('does not install guest policy on the parent renderer', () => {
    const contents = {
      getType: vi.fn(() => 'window'),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    expect(configureWebViewGuest(contents, vi.fn())).toBe(false);
    expect(contents.setWindowOpenHandler).not.toHaveBeenCalled();
    expect(contents.on).not.toHaveBeenCalled();
  });
});
