import {
  normalizeUserPreferences,
  type PlatformCapabilities,
  type PlatformMenu,
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
  return {
    models: { pick: pickModel },
    exports: { save: downloadGcode },
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
    profiles: { fetch: async (relativePath) => {
      const Url = globalThis.URL;
      const href = new Url(`profiles/${relativePath}`, new Url(import.meta.env.BASE_URL, String(import.meta.url))).href;
      const response = await fetch(href);
      if (!response.ok) throw new Error(`profile asset request failed (${response.status}): ${relativePath}`);
      return new Uint8Array(await response.arrayBuffer());
    } },
    chrome: { kind: 'web', platform: navigator.platform, menuMode: 'browser' },
    menu: browserMenu,
    externalLinks: {
      openSource() {
        window.open(SOURCE_URL, '_blank', 'noopener,noreferrer');
      },
    },
  };
}

export function pickModel(): Promise<{ displayName: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.stl,.3mf,.drc'; input.hidden = true;
    const cleanup = () => input.remove();
    input.onchange = async () => { const file = input.files?.[0]; if (!file) { cleanup(); return resolve(null); } resolve({ displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }); cleanup(); };
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
    document.body.append(input); input.click();
  });
}

export async function downloadGcode(defaultName: string, bytes: Uint8Array): Promise<void> {
  const href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = href; link.download = defaultName.endsWith('.gcode') ? defaultName : `${defaultName}.gcode`; link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
