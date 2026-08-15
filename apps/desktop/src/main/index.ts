import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { extname, join, sep } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Ipc, type FileDialogFilter, type AppConfigLoadResult } from '../shared/ipc';

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

// M4: the persisted app config (installed printers + selections) — the
// single source of truth the bridge applies at boot. Lives in userData.
// Under ORCA_E2E=1 the e2e launcher may supply ORCA_E2E_APPCONFIG for a
// hermetic file; without one, persistence is disabled (fresh config every
// run — the pre-M4 behavior, so runs never leak state into each other).
const appConfigPath = (): string => {
  if (process.env.ORCA_E2E === '1' && process.env.ORCA_E2E_APPCONFIG) {
    return process.env.ORCA_E2E_APPCONFIG;
  }
  return join(app.getPath('userData'), 'appconfig.json');
};
const appConfigPersisted = (): boolean =>
  process.env.ORCA_E2E !== '1' || Boolean(process.env.ORCA_E2E_APPCONFIG);

let rendererPort = 0;
let rendererServer: Server | null = null;

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
    // 36px custom bar (14px lights → y = (36-14)/2).
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#1a1a1a', symbolColor: '#e6e6e6', height: 36 } }
      : { trafficLightPosition: { x: 12, y: 11 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses node builtins for file IO
    },
  });

  win.on('ready-to-show', () => win.show());

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

  ipcMain.handle(Ipc.appConfigLoad, async (): Promise<AppConfigLoadResult> => {
    if (!appConfigPersisted()) return { found: false, json: null };
    try {
      const raw = await readFile(appConfigPath(), 'utf8');
      return { found: true, json: JSON.parse(raw) };
    } catch {
      // ENOENT (no config yet) and corrupt JSON both mean: fresh config.
      return { found: false, json: null };
    }
  });

  ipcMain.handle(Ipc.appConfigSave, async (_event, json: unknown): Promise<void> => {
    if (!appConfigPersisted()) return;
    // Round-trip through stringify so a corrupt partial write can never be
    // served back to the bridge; atomic-ish via tmp + rename is overkill for
    // this file's size, a plain write is fine (single writer: the renderer).
    await writeFile(appConfigPath(), JSON.stringify(json, null, 2), 'utf8');
  });

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
          "font-src 'self' data:; connect-src 'self'; worker-src 'self'",
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
  registerIpc();
  startRendererServer(); // createWindow fires once the port is bound

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  rendererServer?.close();
});
