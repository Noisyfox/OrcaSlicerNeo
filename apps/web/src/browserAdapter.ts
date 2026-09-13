import {
  MODEL_FILE_ACCEPT,
  normalizeUserPreferences,
  type ProjectFileCapability,
  type ProjectInput,
  type ProjectDropFile,
  type ModelDropFile,
  type PlatformCapabilities,
  type PlatformMenu,
  type ProfileSource,
  type PrinterConfigurationRepository,
  type SlicerRuntime,
} from '@orca/platform-contract';
import {
  normalizePrinterConfigurationDocument,
  type PrinterConfigurationDocument,
} from '@orca/printer-control';
import { createBrowserPrinterTransport } from './browserPrinterTransport';
import { createBrowserWebViewHost } from './browserWebView';

export { BrowserPrinterTransport, createBrowserPrinterTransport } from './browserPrinterTransport';
export { createBrowserWebViewHost } from './browserWebView';

export const SOURCE_URL = 'https://github.com/Noisyfox/OrcaSlicerNeo';
export const PRINTER_CONFIGURATION_STORAGE_KEY = 'orca-slicer-neo:printer-configuration:v1';

const browserMenu: PlatformMenu = {
  syncModel() {},
  syncState() {},
  onCommand() { return () => {}; },
  execute() {},
};

function emptyPrinterConfigurationDocument(): PrinterConfigurationDocument {
  return { version: 1, printers: [] };
}

/** Browser storage is isolated from ordinary preferences and versioned. */
export function createBrowserPrinterConfigurationRepository(
  storage: Storage = localStorage,
): PrinterConfigurationRepository {
  let inMemory = emptyPrinterConfigurationDocument();
  return {
    async load() {
      let raw: string | null;
      try {
        raw = storage.getItem(PRINTER_CONFIGURATION_STORAGE_KEY);
      } catch {
        return inMemory;
      }
      if (raw === null) {
        inMemory = emptyPrinterConfigurationDocument();
        return inMemory;
      }
      try {
        inMemory = normalizePrinterConfigurationDocument(JSON.parse(raw));
      } catch {
        inMemory = emptyPrinterConfigurationDocument();
      }
      return inMemory;
    },
    async save(document) {
      const normalized = normalizePrinterConfigurationDocument(document);
      inMemory = normalized;
      try {
        storage.setItem(PRINTER_CONFIGURATION_STORAGE_KEY, JSON.stringify(normalized));
      } catch {
        // Storage can be disabled or out of quota; keep this session usable.
      }
    },
  };
}

export function createBrowserAdapter(runtime: SlicerRuntime): PlatformCapabilities {
  let inMemory = normalizeUserPreferences(null);
  const printerConfiguration = createBrowserPrinterConfigurationRepository();
  const projects: ProjectFileCapability = {
    async open() {
      try {
        const input = await pickProject();
        return input === null ? { status: 'cancelled' as const } : { status: 'ok' as const, input };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    async openMany() {
      try {
        const inputs = await pickProjects();
        return inputs.length === 0 ? { status: 'cancelled' as const } : { status: 'ok' as const, inputs };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    async openDropped(files: readonly ProjectDropFile[]) {
      try {
        return { status: 'ok' as const, inputs: await Promise.all(files.map(async (file) => ({ displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))) };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    async save(input) {
      try {
        await downloadProject(input);
        return { status: 'ok' as const };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
    async saveAs(input) {
      try {
        await downloadProject(input);
        return { status: 'ok' as const };
      } catch (error) {
        return { status: 'failed' as const, error };
      }
    },
  };
  return {
    models: {
      pick: pickModel,
      async importDropped(files: readonly ModelDropFile[]) {
        return Promise.all(files.map(async (file) => ({
          displayName: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })));
      },
    },
    exports: { save: downloadGcode },
    projects,
    preferences: {
      async load() {
        try {
          const raw = localStorage.getItem('orca-slicer-neo:preferences');
          inMemory = normalizeUserPreferences(raw === null ? null : JSON.parse(raw));
        } catch (error) {
          console.error('web preferences load failed; using in-memory preferences', error);
        }
        return inMemory;
      },
      async save(value) {
        inMemory = normalizeUserPreferences(value);
        try { localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify(inMemory)); }
        catch (error) { console.error('web preferences save failed; keeping in-memory preferences', error); }
      },
    },
    printers: { configuration: printerConfiguration, transport: createBrowserPrinterTransport() },
    webview: createBrowserWebViewHost(),
    runtime,
    profiles: createBrowserProfileSource(),
    chrome: { kind: 'web', platform: navigator.platform, menuMode: 'browser' },
    menu: browserMenu,
    externalLinks: {
      openSource() {
        window.open(SOURCE_URL, '_blank', 'noopener,noreferrer');
      },
    },
  };
}

/**
 * Profile packages are published beside `wasm/` at the deployment root.
 * Resolve that root from the emitted module URL so Vite's relative `./`
 * base does not accidentally resolve under the module's `assets/` folder.
 */
export function createBrowserProfileSource(
  baseUrl = import.meta.env.BASE_URL,
  moduleUrl: string | URL = String(import.meta.url),
): ProfileSource {
  let source: Promise<ProfileSource> | undefined;
  return {
    fetch: (relativePath) => {
      source ??= import('@orca/slicer-runtime').then(({ createFetchProfileSource, resolveProfileBaseUrl }) =>
        createFetchProfileSource(resolveProfileBaseUrl(baseUrl, moduleUrl)));
      return source.then((profileSource) => profileSource.fetch(relativePath));
    },
  };
}

export function pickModel(): Promise<{ displayName: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = MODEL_FILE_ACCEPT; input.hidden = true;
    const cleanup = () => input.remove();
    input.onchange = async () => { const file = input.files?.[0]; if (!file) { cleanup(); return resolve(null); } resolve({ displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); cleanup(); };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
    document.body.append(input); input.click();
  });
}

/** Browser project input is intentionally separate from the model picker. */
export function pickProject(): Promise<ProjectInput | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.3mf'; input.hidden = true;
    const cleanup = () => input.remove();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      try {
        resolve({ displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
    document.body.append(input); input.click();
  });
}

/** Multi-selection variant used by Open Project; model picker remains single-file. */
export function pickProjects(): Promise<ProjectInput[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.3mf'; input.multiple = true; input.hidden = true;
    const cleanup = () => input.remove();
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? [])
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        resolve(await Promise.all(files.map(async (file) => ({
          displayName: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }))));
      } catch (error) {
        reject(error);
      } finally {
        cleanup();
      }
    };
    input.addEventListener('cancel', () => { cleanup(); resolve([]); }, { once: true });
    document.body.append(input); input.click();
  });
}

export async function downloadProject(input: ProjectInput): Promise<void> {
  const href = URL.createObjectURL(new Blob([input.bytes.slice().buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }));
  const link = document.createElement('a'); link.href = href;
  link.download = input.displayName.toLowerCase().endsWith('.3mf') ? input.displayName : `${input.displayName}.3mf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

export async function downloadGcode(defaultName: string, bytes: Uint8Array): Promise<void> {
  const href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = href; link.download = defaultName.endsWith('.gcode') ? defaultName : `${defaultName}.gcode`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
