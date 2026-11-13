import type {
  ExternalLinks, FileDownloader, GcodeExporter, ModelImporter, PlatformCapabilities, ProfileSource,
  SlicerRuntime, UserPreferencesRepository, PrinterConfigurationRepository,
  WebViewHost, ProjectFileCapability, PlatformMemory, MdnsDiscovery, MdnsService, MdnsEvent, PrinterTransport, PrinterConfigurationDocument,
} from './index';
import type { PrinterService, PrinterDownloads } from './index';
import type { MenuCommandId, PlatformMenu } from './menu';

// Compile-only host fixtures. No implementation or host-runtime imports are allowed.
export const fakeCapabilities: PlatformCapabilities = {
  screenColor: { native: null, browser: null },
  models: { async pick() { return null; } } satisfies ModelImporter,
  exports: { async save() { return { status: 'saved' as const }; } } satisfies GcodeExporter,
  downloads: { async download() {} } satisfies FileDownloader,
  projects: {
    async open() { return { status: 'cancelled' as const }; },
    async save() { return { status: 'cancelled' as const }; },
    async saveAs() { return { status: 'cancelled' as const }; },
  } satisfies ProjectFileCapability,
  recentProjects: {
    async list() { return []; }, async thumbnail() { return null; }, async open() { return { status: 'cancelled' }; },
    async record() {}, async remove() {}, async clear() {}, async reveal() {},
  },
  preferences: { async load() { throw new Error(); }, async save() {} } satisfies UserPreferencesRepository,
  accounts: [],
  printers: {
    downloads: {} as PrinterDownloads,
    configuration: { onChanged: () => () => {}, async load() { return { version: 1 as const, printers: [] }; }, async save() {} } satisfies PrinterConfigurationRepository,
    service: {} as PrinterService,
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
  externalLinks: { openSource() {}, openHttps() {} } satisfies ExternalLinks,
};

// External consumers use the root entrypoint for all public networking/printer contracts.
const browse: MdnsDiscovery = { async *browse(_type, _options) {
  const service: MdnsService = { id: 'fixture._http._tcp.local.', serviceType: _type, name: 'fixture',
    host: 'fixture.local.', port: 80, addresses: ['127.0.0.1'], txt: { model: 'fixture' }, expiresAtMs: 1 };
  yield { type: 'upsert', service } satisfies MdnsEvent;
} };
const transport: PrinterTransport = { async request(_request) {
  return { status: 200, async json() { return {}; }, async bytes() { return new Uint8Array(); } };
} };
const document: PrinterConfigurationDocument = { version: 1, printers: [] };
void browse; void transport; void document;
