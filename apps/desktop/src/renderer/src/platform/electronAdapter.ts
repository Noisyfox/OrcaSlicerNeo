import {
  DEFAULT_USER_PREFERENCES,
  MODEL_FILE_EXTENSIONS,
  normalizeUserPreferences,
  type PrinterConfigurationRepository,
  type MenuCommandId,
  type PlatformCapabilities,
  type PlatformMenu,
  type ProjectFileCapability,
  type ProjectInput,
  type ProjectOpenResult,
  type ProjectOpenBatchResult,
  type ProjectDropFile,
  type UserPreferences,
} from '@orca/platform-contract';
import {
  normalizePrinterConfigurationDocument,
  type PrinterConfigurationDocument,
} from '@orca/printer-control';
import type { FileDialogFilter } from '../../../shared/ipc';
import type { SlicerRuntime } from '@orca/platform-contract';
import { createElectronPrinterTransport } from './electronPrinterTransport';
import { createElectronWebViewHost } from './electronWebView';

const MODEL_FILTERS: FileDialogFilter[] = [
  { name: 'Models', extensions: [...MODEL_FILE_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] },
];

const GCODE_FILTERS: FileDialogFilter[] = [
  { name: 'G-code', extensions: ['gcode'] },
];

function projectBytes(input: ProjectInput): ArrayBuffer {
  return input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength,
  ) as ArrayBuffer;
}

function projectName(name: string): string {
  return name.toLowerCase().endsWith('.3mf') ? name : `${name}.3mf`;
}

/** The only renderer module allowed to know about the Electron preload API. */
export function createElectronAdapter(runtime: SlicerRuntime): PlatformCapabilities {
  const host = window.orca;
  // Keep the native path in this adapter only. The shared application receives
  // displayName and bytes, while this map remains available for future reload
  // support without leaking absolute paths into shared state.
  const importPaths = new Map<string, string>();
  let importSequence = 0;
  const projectTokens = new WeakMap<object, string>();
  const createProjectLocation = (token: string) => {
    const location = {} as import('@orca/platform-contract').OpaqueProjectLocation;
    projectTokens.set(location, token);
    return location;
  };
  const projects = {
    async open() {
      return openOne();
    },
    async openMany(): Promise<ProjectOpenBatchResult> {
      try {
        const result = await host.projects.openMany();
        if (result.canceled) return { status: 'cancelled' };
        const files = result.files;
        if (files) {
          return {
            status: 'ok',
            inputs: files.map((file) => ({
              displayName: file.displayName,
              bytes: new Uint8Array(file.bytes),
              location: createProjectLocation(file.locationToken),
            })),
          };
        }
        const one = await projectInputFrom(result);
        return one ? { status: 'ok', inputs: [one] } : { status: 'failed', error: new Error('Electron returned an invalid project input') };
      } catch (error) {
        return { status: 'failed', error };
      }
    },
    async openDropped(files: readonly ProjectDropFile[]): Promise<ProjectOpenBatchResult> {
      try {
        const paths = files.map((file) => {
          const legacyPath = (file as ProjectDropFile & { path?: unknown }).path;
          if (typeof legacyPath === 'string' && legacyPath.length > 0) return legacyPath;
          try {
            const path = host.projects.getPathForFile(file as unknown as File);
            return typeof path === 'string' && path.length > 0 ? path : null;
          } catch {
            return null;
          }
        });
        if (paths.every((path): path is string => path !== null)) {
          const result = await host.projects.openDropped(paths);
          if (result.canceled) return { status: 'cancelled' };
          if (result.files) return { status: 'ok', inputs: result.files.map((file) => ({ displayName: file.displayName, bytes: new Uint8Array(file.bytes), location: createProjectLocation(file.locationToken) })) };
        }
        return { status: 'ok', inputs: await Promise.all(files.map(async (file) => ({ displayName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))) };
      } catch (error) {
        return { status: 'failed', error };
      }
    },
  };
  async function projectInputFrom(result: Awaited<ReturnType<typeof host.projects.open>>): Promise<ProjectInput | null> {
    if (!result.bytes || !result.displayName || !result.locationToken) return null;
    return {
      displayName: result.displayName,
      bytes: new Uint8Array(result.bytes),
      location: createProjectLocation(result.locationToken),
    };
  }
  async function openOne(): Promise<ProjectOpenResult> {
      try {
        const result = await host.projects.open();
        if (result.canceled) return { status: 'cancelled' };
        const input = await projectInputFrom(result);
        if (!input) {
          return { status: 'failed', error: new Error('Electron returned an invalid project input') };
        }
        return { status: 'ok', input };
      } catch (error) {
        return { status: 'failed', error };
      }
  }
  const projectCapability: ProjectFileCapability = {
    ...projects,
    async save(input) {
      try {
        const token = input.location ? projectTokens.get(input.location as object) ?? null : null;
        const result = token
          ? await host.projects.save(token, projectName(input.displayName), projectBytes(input))
          : await host.projects.saveAs(projectName(input.displayName), projectBytes(input));
        if (result.canceled) return { status: 'cancelled' };
        if (!result.locationToken) return { status: 'failed', error: new Error('Electron did not return a project location') };
        const location = createProjectLocation(result.locationToken);
        return { status: 'ok', location };
      } catch (error) {
        return { status: 'failed', error };
      }
    },
    async saveAs(input) {
      try {
        const result = await host.projects.saveAs(projectName(input.displayName), projectBytes(input));
        if (result.canceled) return { status: 'cancelled' };
        if (!result.locationToken) return { status: 'failed', error: new Error('Electron did not return a project location') };
        return { status: 'ok', location: createProjectLocation(result.locationToken) };
      } catch (error) {
        return { status: 'failed', error };
      }
    },
  };
  let inMemoryPreferences: UserPreferences = normalizeUserPreferences(DEFAULT_USER_PREFERENCES);
  let inMemoryPrinterConfiguration: PrinterConfigurationDocument = { version: 1, printers: [] };
  const printerConfiguration: PrinterConfigurationRepository = {
    async load() {
      try {
        inMemoryPrinterConfiguration = normalizePrinterConfigurationDocument(
          await host.printers.configuration.load(),
        );
      } catch {
        inMemoryPrinterConfiguration = { version: 1, printers: [] };
      }
      return inMemoryPrinterConfiguration;
    },
    async save(document) {
      const normalized = normalizePrinterConfigurationDocument(document);
      inMemoryPrinterConfiguration = normalized;
      try {
        await host.printers.configuration.save(normalized);
      } catch {
        // Keep the normalized value available for this session if persistence
        // is unavailable; never include the document in diagnostics.
      }
    },
  };
  return {
    models: {
      async pick() {
        const { path } = await host.openFileDialog(MODEL_FILTERS);
        if (!path) return null;
        const bytes = new Uint8Array(await host.readFile(path));
        const importId = `import-${++importSequence}`;
        importPaths.set(importId, path);
        return {
          displayName: path.split(/[\\/]/).pop() ?? path,
          bytes,
        };
      },
    },
    exports: {
      async save(defaultName, bytes) {
        const { path } = await host.saveFileDialog(defaultName, GCODE_FILTERS);
        if (!path) return;
        await host.writeFile(path, bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer);
      },
    },
    projects: projectCapability,
    preferences: {
      async load() {
        try {
          const result = await host.preferences.load();
          inMemoryPreferences = normalizeUserPreferences(result.found ? result.json : null);
          return inMemoryPreferences;
        } catch (error) {
          console.error('preferences load failed; using in-memory defaults', error);
          return inMemoryPreferences;
        }
      },
      async save(value) {
        const normalized = normalizeUserPreferences(value);
        inMemoryPreferences = normalized;
        try { await host.preferences.save(normalized); }
        catch (error) { console.error('preferences save failed; keeping in-memory preferences', error); }
      },
    },
    printers: { configuration: printerConfiguration, transport: createElectronPrinterTransport(host) },
    webview: createElectronWebViewHost(),
    runtime,
    lifecycle: {
      onCloseRequest: (listener) => host.lifecycle.onCloseRequest(listener),
      respondClose: (allow) => host.lifecycle.respondClose(allow),
    },
    profiles: { fetch: async (relativePath) => {
      const response = await fetch(new URL(`profiles/${relativePath}`, document.baseURI));
      if (!response.ok) throw new Error(`profile asset request failed (${response.status}): ${relativePath}`);
      return new Uint8Array(await response.arrayBuffer());
    } },
    chrome: {
      kind: 'desktop',
      platform: host.platform,
      menuMode: host.platform === 'darwin' ? 'native' : 'custom',
      dragRegion: true,
      macSafeInset: host.platform === 'darwin',
    },
    menu: {
      syncModel: (model) => host.menu.syncModel(model),
      syncState: (snapshot) => host.menu.syncState(snapshot),
      onCommand: (listener) => host.menu.onCommand(listener),
      execute: (command: MenuCommandId) => {
        if (command === 'quit') return host.menu.executeHostCommand(command);
      },
    } satisfies PlatformMenu,
    externalLinks: { openSource: () => host.externalLinks.openSource() },
  };
}
