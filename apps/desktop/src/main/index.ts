import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { extname, join, sep } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Ipc, type FileDialogFilter } from '../shared/ipc';

// Built renderer serves from the custom app:// scheme, not file://: Chromium
// hard-blocks worker scripts from file:// (opaque origin), so a loadFile()
// app could never spawn its slicer worker. app:// is standard+secure (a real
// origin for module workers and fetch), and the handler below is asar-aware
// (Electron's fs reads inside app.asar and transparently follows
// asar.unpacked), which is why the wasm assets need no special-casing here.
// registerSchemesAsPrivileged must run before app is ready.
// Electron 32+ regression: dedicated workers fail to load from custom
// schemes (and file://) — script served, worker never runs. PlzDedicatedWorker
// launches each dedicated worker in its own process; disabling it restores
// in-process workers, which load fine from app://. (Flag removed in E36 — if
// we upgrade past E34, re-verify and drop this line when upstream fixes land.)
app.commandLine.appendSwitch('disable-features', 'PlzDedicatedWorker');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    // corsEnabled is required for worker script loading and module imports
    // over the scheme (Chromium fetches them through the CORS pipeline).
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses node builtins for file IO
    },
  });

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadURL('app://bundle/index.html');
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

  ipcMain.on(Ipc.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(Ipc.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(Ipc.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function setupSessionHeaders(): void {
  // COOP/COEP: same-origin isolation (SharedArrayBuffer headroom for
  // Milestone 4 threading). Applies to the renderer session; the
  // worker (module worker) inherits the page's headers.
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

app.whenReady().then(() => {
  // Serve the built renderer bundle over app:// (see the scheme note above).
  // Path mapping: app://bundle/<rel> → out/renderer/<rel> (wasm assets land
  // in out/renderer/wasm/ via Vite's public dir copy).
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/bundle/, '');
    const filePath = join(RENDERER_ROOT, rel);
    // Defense in depth: URL parsing normalizes '..', but never serve outside
    // the renderer root.
    if (filePath !== RENDERER_ROOT && !filePath.startsWith(RENDERER_ROOT + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: { 'content-type': MIME_BY_EXT[extname(filePath)] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  setupSessionHeaders();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
