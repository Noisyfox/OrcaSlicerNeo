import type {
  ExternalLinks, GcodeExporter, ModelImporter, PlatformCapabilities, ProfileSource,
  SlicerRuntime, UserPreferencesRepository, PrinterConfigurationRepository,
  WebViewHost, ProjectFileCapability, PlatformMemory,
} from './contracts';
import type { MenuCommandId, PlatformMenu } from './menu';

// This file is intentionally value-free. It is compiled in isolation by the
// platform-contract import guard and must remain free of host/runtime imports.
export const fakeCapabilities: PlatformCapabilities = {
  models: { async pick() { return null; } } satisfies ModelImporter,
  exports: { async save() {} } satisfies GcodeExporter,
  projects: {
    async open() { return { status: 'cancelled' as const }; },
    async save() { return { status: 'cancelled' as const }; },
    async saveAs() { return { status: 'cancelled' as const }; },
  } satisfies ProjectFileCapability,
  preferences: { async load() { throw new Error(); }, async save() {} } satisfies UserPreferencesRepository,
  printers: {
    configuration: { async load() { return { version: 1 as const, printers: [] }; }, async save() {} } satisfies PrinterConfigurationRepository,
    transport: { async request() { return { status: 200, async json() { return {}; } }; } },
  },
  webview: {
    capabilities: { canInjectBuiltInScripts: false, canExposeHostApi: false, canExecuteJavaScript: false },
    mount() {
      return {
        capabilities: { canInjectBuiltInScripts: false, canExposeHostApi: false, canExecuteJavaScript: false },
        state: { status: 'idle' as const, url: null, error: null },
        load() {},
        registerBuiltInScript() { return { status: 'unsupported' as const, reason: 'capability-unavailable' as const }; },
        exposeHostApi() { return { status: 'unsupported' as const, reason: 'capability-unavailable' as const }; },
        async executeJavaScript() { return { status: 'unsupported' as const, reason: 'capability-unavailable' as const }; },
        dispose() {},
      };
    },
  } satisfies WebViewHost,
  runtime: {} as SlicerRuntime,
  memory: { async sample() { return { entries: [] }; } } satisfies PlatformMemory,
  profiles: { async fetch() { return new Uint8Array(); } } satisfies ProfileSource,
  chrome: { kind: 'web', menuMode: 'browser' },
  menu: {
    syncModel() {},
    syncState() {},
    onCommand() { return () => {}; },
    execute(_command: MenuCommandId) {},
  } satisfies PlatformMenu,
  externalLinks: { openSource() {} } satisfies ExternalLinks,
};
