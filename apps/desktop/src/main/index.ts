import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type WebContents } from 'electron';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { extname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Ipc, type FileDialogFilter, type PreferencesLoadResult } from '../shared/ipc';
import type { MenuCommandId } from '../shared/ipc';
import { createPrinterConfigurationIpcHandlers } from './printerConfigurationIpc';
import { createPrinterTransportIpcHandlers } from './printerHttpTransport';
import { isCurrentRendererSender } from './rendererGuards';
import {
  createNativeMenuController,
  handleHostCommand,
  openFixedSource,
  type NativeMenuController,
} from './nativeMenu';
import { configureWebViewAttachPolicy, configureWebViewGuest } from './webviewSecurity';

// Chromium documents this as a preference for a discrete GPU when multiple
// adapters are available. It does not name or require a particular GPU; the
// normal integrated-GPU/software fallback remains available.
app.commandLine.appendSwitch('force_high_performance_gpu');

// Linux containers/VMs without a DRM/VA-API device cannot start Chromium's
// separate GPU process; Electron aborts with "GPU process isn't usable.
// Goodbye." after vaInitialize / CreateCommandBuffer failures. Run the GPU
// service in-process and use Chromium's SwiftShader WebGL backend on those
// machines so the app still launches and the 3D viewport has a software GL
// context.
if (
  process.platform === 'linux' &&
  // Dev mode always uses the Vite renderer URL. Apply the software GL path
  // there even if /dev/dri exists but VA-API is broken; also cover packaged
  // GPU-less Linux machines that have no /dev/dri at all.
  (process.env.ELECTRON_RENDERER_URL || !existsSync('/dev/dri'))
) {
  // app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-angle', 'swiftshader-webgl');
  // SwiftShader's software WebGL is treated as unsafe/blocklisted by
  // default in current Chromium; opt in and ignore the GPU blocklist so the
  // 3D viewport can get a WebGL2 context in GPU-less Linux environments.
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// The renderer origin is an in-process http server on loopback, not a custom
// scheme. Chromium hard-blocks worker scripts from file://, and since
// Electron 36 (PlzDedicatedWorker flag removed) dedicated workers always run
// out-of-process and cannot fetch their scripts from custom schemes at all
// (electron#38774) — the slicer worker, its dynamic import of the wasm
// module, and Emscripten's .wasm/.data fetches all need a real fetch origin.
// A loopback http origin is the standard pattern (VS Code et al.): bound to
// 127.0.0.1 on an ephemeral port, with the Host header validated so a
// malicious page cannot drive the server via DNS rebinding. Dev keeps the
// ELECTRON_RENDERER_URL branch (Vite dev server). See
// doc/2026-08-14-http-origin-for-workers.md.
const RENDERER_ROOT = join(__dirname, '../renderer');

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// e2e hook: Playwright cannot drive native dialogs, so with ORCA_E2E=1 the
// open/save handlers return fixed paths from the environment. Only ever set
// by the e2e launcher (playwright config / CI); never in production.
const e2eOpenPath = process.env.ORCA_E2E === '1' ? (process.env.ORCA_E2E_MODEL ?? null) : null;
const e2eSavePath = process.env.ORCA_E2E === '1' ? (process.env.ORCA_E2E_EXPORT ?? null) : null;

// M9: only the small shared UserPreferences document is persisted. Keep the
// old IPC channel names during the incremental Electron migration.
const preferencesPath = (): string => {
  if (process.env.ORCA_E2E === '1' && process.env.ORCA_E2E_PREFERENCES) {
    return process.env.ORCA_E2E_PREFERENCES;
  }
  return join(app.getPath('userData'), 'preferences.json');
};
const preferencesPersisted = (): boolean =>
  process.env.ORCA_E2E !== '1' || Boolean(process.env.ORCA_E2E_PREFERENCES);

const printerConfigurationPath = (): string =>
  process.env.ORCA_E2E_PRINTER_CONFIG ?? join(app.getPath('userData'), 'printer-config.json');

let rendererPort = 0;
let rendererServer: Server | null = null;
let mainWindow: BrowserWindow | null = null;
let nativeMenuController: NativeMenuController | null = null;

function isCurrentRenderer(sender: WebContents): boolean {
  return isCurrentRendererSender(sender, mainWindow);
}

function sendNativeMenuCommand(command: MenuCommandId): void {
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.send(Ipc.nativeMenuCommand, command);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    // Frameless everywhere — the renderer's TitleBar is the only chrome.
    // Windows/Linux get native min/max/close via the Window Controls
    // Overlay (see doc/2026-08-15-frameless-window.md); macOS keeps its
    // traffic lights ('hidden' style), positioned to sit centered in the
    // 32px (2rem) custom bar (14px lights → y = (32-14)/2).
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#181818', symbolColor: '#e6e6e6', height: 32 } }
      : { trafficLightPosition: { x: 12, y: 9 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses node builtins for file IO
      // The shared app owns the element; guests remain isolated from Node and
      // receive no preload or arbitrary host API.
      webviewTag: true,
    },
  });
  mainWindow = win;
  // `will-attach-webview` runs before a guest exists. Strip any page-supplied
  // preload and force the guest security flags before Electron creates it.
  configureWebViewAttachPolicy(win.webContents as unknown as Parameters<typeof configureWebViewAttachPolicy>[0]);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Normally `ready-to-show` is the right time to reveal the window (it
  // avoids a white flash). In software-rendered/headless-ish Linux setups it
  // can be missed even after the page loads, leaving the app running with no
  // visible window — so also fall back to showing once the page finishes
  // loading.
  let shown = false;
  const showWindow = () => {
    if (shown) return;
    shown = true;
    win.show();
  };
  win.on('ready-to-show', showWindow);
  win.webContents.on('did-finish-load', () => setTimeout(showWindow, 500));

  // Electron does not provide Chromium's browser-native editor context menu.
  // Recreate it in the host for editable controls only; renderer-owned
  // shadcn ContextMenus continue to handle model rows and the viewport.
  win.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable) return;
    event.preventDefault();
    const { editFlags } = params;
    const menu = Menu.buildFromTemplate([
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: editFlags.canPaste },
      { role: 'delete', enabled: editFlags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ]);
    menu.popup({ window: win });
  });

  // F12 / Ctrl+Shift+I opens DevTools. autoHideMenuBar leaves no way to
  // reach the default menu's toggle in the packaged app, and a detached
  // window keeps the slicer layout untouched while inspecting it.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrlShiftI = input.key === 'I' && input.control && input.shift;
    if (input.key === 'F12' || ctrlShiftI) win.webContents.openDevTools({ mode: 'detach' });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadURL(`http://127.0.0.1:${rendererPort}/index.html`);
  }
}

function registerIpc(): void {
  ipcMain.handle(Ipc.openFileDialog, async (event, filters: FileDialogFilter[]) => {
    if (e2eOpenPath !== null) return { canceled: false, path: e2eOpenPath };
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters,
    });
    return { canceled, path: canceled ? null : (filePaths[0] ?? null) };
  });

  ipcMain.handle(Ipc.saveFileDialog, async (event, defaultName: string, filters: FileDialogFilter[]) => {
    if (e2eSavePath !== null) return { canceled: false, path: e2eSavePath };
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters,
    });
    return { canceled, path: canceled ? null : (filePath ?? null) };
  });

  ipcMain.handle(Ipc.readFile, async (_event, path: string) => {
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  ipcMain.handle(Ipc.writeFile, async (_event, path: string, bytes: ArrayBuffer) => {
    await writeFile(path, Buffer.from(bytes));
  });

  ipcMain.handle(Ipc.preferencesLoad, async (): Promise<PreferencesLoadResult> => {
    if (!preferencesPersisted()) return { found: false, json: null };
    try {
      const raw = await readFile(preferencesPath(), 'utf8');
      return { found: true, json: JSON.parse(raw) };
    } catch (error) {
      // ENOENT and corrupt JSON both mean fresh preferences; keep the app
      // usable while making the failure diagnosable in the host log.
      console.error('preferences load failed; using defaults', error);
      return { found: false, json: null };
    }
  });

  ipcMain.handle(Ipc.preferencesSave, async (_event, json: unknown): Promise<void> => {
    if (!preferencesPersisted()) return;
    // Round-trip through stringify so a corrupt partial write can never be
    // served back to the bridge; atomic-ish via tmp + rename is overkill for
    // this file's size, a plain write is fine (single writer: the renderer).
    await writeFile(preferencesPath(), JSON.stringify(json, null, 2), 'utf8');
  });

  const printerConfigurationIpc = createPrinterConfigurationIpcHandlers({
    path: printerConfigurationPath,
    fs: {
      readText: (path) => readFile(path, 'utf8'),
      writeText: (path, value) => writeFile(path, value, 'utf8'),
    },
    isCurrentRenderer,
  });
  ipcMain.handle(Ipc.printerConfigurationLoad, async (event) => printerConfigurationIpc.load(event.sender));
  ipcMain.handle(Ipc.printerConfigurationSave, async (event, document: unknown): Promise<void> => {
    await printerConfigurationIpc.save(event.sender, document);
  });

  const printerTransportIpc = createPrinterTransportIpcHandlers({
    isCurrentRenderer,
    sendProgress: (sender, requestId, progress) => {
      if (isCurrentRenderer(sender as WebContents)) (sender as WebContents).send(Ipc.printerTransportProgress, requestId, progress);
    },
  });
  ipcMain.handle(Ipc.printerTransportRequest, async (event, requestId: unknown, request: unknown) =>
    printerTransportIpc.request(event.sender, requestId, request));
  ipcMain.handle(Ipc.printerTransportCancel, (event, requestId: unknown) => {
    printerTransportIpc.cancel(event.sender, requestId);
  });

  ipcMain.on(Ipc.syncMenuModel, (event, model: unknown) => {
    if (!isCurrentRenderer(event.sender)) return;
    nativeMenuController?.syncModel(model);
  });

  ipcMain.on(Ipc.syncMenuState, (event, snapshot: unknown) => {
    if (!isCurrentRenderer(event.sender)) return;
    nativeMenuController?.syncState(snapshot);
  });

  ipcMain.handle(Ipc.executeHostCommand, async (event, command: unknown): Promise<void> => {
    if (!isCurrentRenderer(event.sender)) return;
    handleHostCommand(command, () => app.quit());
  });

  ipcMain.handle(Ipc.openSource, async (event): Promise<void> => {
    if (!isCurrentRenderer(event.sender)) return;
    await openFixedSource((url) => shell.openExternal(url));
  });

}

function installNativeMenu(): void {
  nativeMenuController = createNativeMenuController({
    platform: process.platform,
    menu: {
      buildFromTemplate: (template) => Menu.buildFromTemplate(
        template as Parameters<typeof Menu.buildFromTemplate>[0],
      ),
      setApplicationMenu: (menu) => Menu.setApplicationMenu(menu as Menu | null),
    },
    onCommand: sendNativeMenuCommand,
  });
  nativeMenuController.install();
}

function setupSessionHeaders(): void {
  // COOP/COEP: same-origin isolation (SharedArrayBuffer headroom for
  // Milestone 4 threading). Applies to the renderer session — with the http
  // origin these ARE applied to every response the renderer and its worker
  // fetch (webRequest sees real http now, unlike the custom-scheme responses
  // it used to miss — electron#20730/#45168 no longer apply).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });
}

function setupWebViewGuestSecurity(): void {
  app.on('web-contents-created', (_event, contents) => {
    configureWebViewGuest(contents, (url) => shell.openExternal(url));
  });
}

// Serves out/renderer over http://127.0.0.1:<ephemeral>. Main-process fs
// reads are asar-aware, so the whole bundle (wasm/ + .data included) works
// from inside app.asar without special-casing.
function startRendererServer(): void {
  rendererServer = createServer(async (req, res) => {
    // Host validation: the only legit Host values are our own origin. A
    // rebinding page (evil.com resolving to 127.0.0.1) would send its own
    // Host and gets rejected before any file is touched.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${rendererPort}` && host !== `localhost:${rendererPort}`) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', `http://127.0.0.1:${rendererPort}`).pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    // Defense in depth: URL parsing normalizes '..', but never serve outside
    // the renderer root.
    const filePath = join(RENDERER_ROOT, pathname);
    if (filePath !== RENDERER_ROOT && !filePath.startsWith(RENDERER_ROOT + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME_BY_EXT[extname(filePath)] ?? 'application/octet-stream',
        // The renderer loads only same-origin assets + a same-origin module
        // worker; the Emscripten module instantiates wasm from inside that
        // worker (document CSP is inherited). No inline scripts in the built
        // bundle, so 'unsafe-inline' stays out of script-src here — the Vite
        // dev server has its own (looser) CSP for the react-refresh preamble.
        // This also silences Electron's "Insecure Content-Security-Policy"
        // devtools warning in the packaged app.
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          // The Vite e2e/mock renderer emits its bundled module worker as a
          // data URL. Keep this narrowly scoped to workers, not scripts.
          "font-src 'self' data:; connect-src 'self'; worker-src 'self' data:; child-src 'self' data:",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  rendererServer.listen(0, '127.0.0.1', () => {
    const address = rendererServer?.address();
    rendererPort = typeof address === 'object' && address ? address.port : 0;
    createWindow();
  });
}

app.whenReady().then(() => {
  setupSessionHeaders();
  setupWebViewGuestSecurity();
  registerIpc();
  installNativeMenu();
  startRendererServer(); // createWindow fires once the port is bound

});

// Single-window tool: closing the window quits the app on every platform,
// macOS included (no dock persistence, no activate-recreate cycle). See
// doc/2026-08-16-quit-on-window-close.md.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  rendererServer?.close();
});
