import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences, type PlatformCapabilities, type PlatformMenu, type UserPreferences } from '@orca/platform-contract';
import type { FileDialogFilter } from '../../../shared/ipc';
import type { SlicerRuntime } from '@orca/platform-contract';

const MODEL_FILTERS: FileDialogFilter[] = [
  { name: 'Models', extensions: ['stl', '3mf'] },
  { name: 'All files', extensions: ['*'] },
];

const GCODE_FILTERS: FileDialogFilter[] = [
  { name: 'G-code', extensions: ['gcode'] },
];

// Menu IPC/native-menu integration is intentionally deferred to the next
// implementation step. Keep the renderer adapter type-compatible meanwhile.
const electronMenuPlaceholder: PlatformMenu = {
  syncModel() {},
  syncState() {},
  onCommand() { return () => {}; },
  execute() {},
};

/** The only renderer module allowed to know about the Electron preload API. */
export function createElectronAdapter(runtime: SlicerRuntime): PlatformCapabilities {
  const host = window.orca;
  // Keep the native path in this adapter only. The shared application receives
  // displayName and bytes, while this map remains available for future reload
  // support without leaking absolute paths into shared state.
  const importPaths = new Map<string, string>();
  let importSequence = 0;
  let inMemoryPreferences: UserPreferences = normalizeUserPreferences(DEFAULT_USER_PREFERENCES);
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
    runtime,
    profiles: { fetch: async (relativePath) => new Uint8Array(await (await fetch(relativePath)).arrayBuffer()) },
    chrome: {
      kind: 'desktop',
      platform: host.platform,
      menuMode: host.platform === 'darwin' ? 'native' : 'custom',
      dragRegion: true,
      macSafeInset: host.platform === 'darwin',
    },
    menu: electronMenuPlaceholder,
    // Source IPC is intentionally deferred with the rest of the host menu
    // implementation; this placeholder does not navigate or accept a URL.
    externalLinks: { openSource() {} },
  };
}
