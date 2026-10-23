import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AccountResult } from '@orca/service-provider';
import type { BambuUtility } from './bambuUtility';
import type { LoginCompletion } from '../shared/bambuHost';

export interface BambuLoginView {
  focus(): void;
  close(): void;
  post(message: unknown): void;
}
export type LoginViewFactory = (url: string, callbacks: { message(text: string): void; external(url: string): void; closed(): void; failed(): void }) => BambuLoginView;
const unavailable = (): AccountResult<void> => ({ ok: false, error: { code: 'unavailable', message: 'Bambu login is unavailable. Please try again.' } });
const success = (): AccountResult<void> => ({ ok: true, value: undefined });
function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Invalid login URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid login URL');
  return url;
}
export const createBambuLoginView: LoginViewFactory = (url, callbacks) => {
  const origin = new URL(url).origin;
  const window = new BrowserWindow({ title: 'Bambu Lab sign in', width: 650, height: 840,
    webPreferences: { preload: join(__dirname, '../preload/bambu-login.js'), nodeIntegration: false, contextIsolation: true, sandbox: true,
      partition: `bambu-login-${randomUUID()}` } });
  // The official page parses the version up to a following space, as in Orca's WebView UA.
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} BBL-Slicer/v02.08.01.55 (${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}) BBL-Language/en`);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const receive = (event: Electron.IpcMainEvent, text: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || typeof text !== 'string' || text.length > 1024 * 1024) return;
    try { if (new URL(event.senderFrame.url).origin === origin) callbacks.message(text); } catch { /* No arbitrary frame bridge. */ }
  };
  ipcMain.on('bambu:login-message', receive);
  window.on('closed', () => { ipcMain.removeListener('bambu:login-message', receive); callbacks.closed(); });
  window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) callbacks.failed(); });
  window.webContents.on('will-navigate', (event, target) => { try { httpsUrl(target); } catch { event.preventDefault(); } });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    try { callbacks.external(httpsUrl(target).href); } catch { /* Unsupported scheme. */ }
    return { action: 'deny' };
  });
  void window.loadURL(url).catch(() => callbacks.failed());
  return {
    focus: () => { if (window.isMinimized()) window.restore(); window.show(); window.focus(); },
    close: () => window.close(),
    post: message => {
      if (!window.isDestroyed() && new URL(window.webContents.getURL()).origin === origin) window.webContents.send('bambu:login-reply', message);
    },
  };
};

interface LoginFlow { attempt: number; url: string; view: BambuLoginView | null; handoff: boolean; finishing: boolean; autotestToken: string; port: number; server: Server | null }
/** Owns the official page and loopback lifetime; closing the page never cancels a browser handoff. */
export class BambuLogin {
  private flow: LoginFlow | null = null;
  private generation = 0;
  private opening: Promise<AccountResult<void>> | null = null;
  private messages: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: Pick<BambuUtility, 'host'>, private readonly createView = createBambuLoginView,
    private readonly openExternal: (url: string) => Promise<void> = url => shell.openExternal(url)) {}
  open(): Promise<AccountResult<void>> {
    if (this.flow?.view) { this.flow.view.focus(); return Promise.resolve(success()); }
    if (!this.opening) this.opening = this.openView().finally(() => { this.opening = null; });
    return this.opening;
  }
  private async openView(): Promise<AccountResult<void>> {
    const generation = this.generation;
    try {
      const flow = this.flow ?? { ...await this.host.host('login.begin', null), view: null, handoff: false, finishing: false, autotestToken: '', port: 0, server: null };
      if (generation !== this.generation) return unavailable();
      this.flow = flow;
      flow.view = this.createView(flow.url, {
        message: text => { this.messages = this.messages.then(() => this.message(flow, text)).catch(() => this.failed(flow)); },
        external: url => { this.messages = this.messages.then(() => this.handoff(flow, url)).catch(() => this.failed(flow)); },
        closed: () => {
          flow.view = null;
          if (this.flow === flow && !flow.handoff && !flow.finishing) { this.dispose(); void this.host.host('login.cancel', { attempt: flow.attempt }).catch(() => undefined); }
        },
        failed: () => { void this.failed(flow); },
      });
      return success();
    } catch { this.dispose(); return unavailable(); }
  }
  private async failed(flow: LoginFlow) {
    if (this.flow === flow) await this.host.host('login.fail', { attempt: flow.attempt }).catch(() => undefined);
  }
  private async message(flow: LoginFlow, text: string) {
    if (this.flow !== flow || flow.finishing) return;
    const message = JSON.parse(text) as { command?: string; data?: Record<string, unknown>; sequence_id?: string };
    if (message.command === 'get_login_cmd') {
      const value = JSON.parse(await this.host.host('login.command', { attempt: flow.attempt }));
      const pkce = value?.pkce;
      const port = Number(pkce?.loopback_port ?? (typeof pkce?.redirect_uri === 'string' ? new URL(pkce.redirect_uri).port : 0));
      if (Number.isInteger(port) && port > 0 && port < 65536) flow.port = port;
      flow.view?.post(value);
    } else if (message.command === 'autotest_token' && typeof message.data?.token === 'string') flow.autotestToken = message.data.token;
    else if (message.command === 'user_ticket_login' && typeof message.data?.ticket === 'string') {
      await this.complete(flow, { kind: 'ticket', ticket: message.data.ticket, autotestToken: flow.autotestToken });
    } else if (message.command === 'user_login' && message.data) {
      await this.complete(flow, { kind: 'user', data: message.data, autotestToken: flow.autotestToken });
    } else if (message.command === 'get_localhost_url') {
      await this.loopback(flow);
      flow.view?.post({ command: 'get_localhost_url', response: { base_url: `http://localhost:${flow.port}`, result: 'success' }, sequence_id: message.sequence_id });
    } else if (message.command === 'thirdparty_login') await this.handoff(flow, message.data?.url);
    else if (message.command === 'new_webpage') await this.openExternal(httpsUrl(message.data?.url).href);
  }
  private async handoff(flow: LoginFlow, url: unknown) {
    if (this.flow !== flow || flow.finishing) return;
    const target = httpsUrl(url);
    await this.loopback(flow);
    const rewritten = target.href.replaceAll('localhost:13618', `localhost:${flow.port}`).replaceAll('127.0.0.1:13618', `127.0.0.1:${flow.port}`)
      .replaceAll('localhost%3A13618', `localhost%3A${flow.port}`).replaceAll('127.0.0.1%3A13618', `127.0.0.1%3A${flow.port}`);
    const previous = flow.handoff;
    flow.handoff = true;
    try { await this.openExternal(rewritten); }
    catch (error) { flow.handoff = previous; throw error; }
  }

  private async complete(flow: LoginFlow, completion: LoginCompletion): Promise<boolean> {
    if (this.flow !== flow || flow.finishing) return false;
    flow.finishing = true;
    try {
      const prepared = await this.host.host('login.prepare', { attempt: flow.attempt, completion });
      if (!prepared.ok || this.flow !== flow) return false;
      // Orca ends the modal before dispatching change_user and the post-login calls.
      flow.view?.close(); flow.view = null;
      const result = await this.host.host('login.complete', { attempt: flow.attempt });
      if (result.ok) this.dispose();
      return result.ok;
    } finally { flow.finishing = false; }
  }
  private async loopback(flow: LoginFlow) {
    if (flow.server) return;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' || this.flow !== flow) { response.writeHead(404).end(); return; }
      const url = new URL(request.url ?? '/', `http://localhost:${flow.port}`);
      const query = url.searchParams;
      const redirect = query.get('redirect_url');
      let destination: URL;
      try {
        destination = httpsUrl(redirect);
        if (destination.origin !== new URL(flow.url).origin) throw new Error('Unsupported redirect');
      } catch { response.writeHead(400).end('Invalid callback'); return; }
      const completion: LoginCompletion | null = query.has('ticket') ? { kind: 'ticket', ticket: query.get('ticket')! }
        : query.has('access_token') ? { kind: 'tokens', token: query.get('access_token')!, refresh: query.get('refresh_token') ?? '', expires: query.get('expires_in') ?? '', refreshExpires: query.get('refresh_expires_in') ?? '' } : null;
      if (!completion) { response.writeHead(400).end('Invalid callback'); return; }
      void this.complete(flow, completion).then(ok => {
        destination.search = new URLSearchParams({ result: ok ? 'success' : 'fail' }).toString();
        response.writeHead(302, { Location: destination.href }).end();
      }).catch(() => { response.writeHead(500).end('Login failed. Please try again.'); });
    });
    // Bind only loopback; the browser callback remains alive after the embedded view closes.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(flow.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    if (this.flow !== flow) { server.close(); throw new Error('Login cancelled'); }
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback unavailable');
    flow.port = address.port; flow.server = server;
  }
  dispose() {
    ++this.generation;
    const flow = this.flow; this.flow = null;
    if (flow) { flow.server?.close(); flow.view?.close(); flow.view = null; }
  }
}
