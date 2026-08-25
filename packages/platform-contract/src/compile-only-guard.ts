import type {
  ExternalLinks, GcodeExporter, ModelImporter, PlatformCapabilities, ProfileSource,
  SlicerRuntime, UserPreferencesRepository,
} from './contracts';
import type { MenuCommandId, PlatformMenu } from './menu';

// This file is intentionally value-free. It is compiled in isolation by the
// platform-contract import guard and must remain free of host/runtime imports.
export const fakeCapabilities: PlatformCapabilities = {
  models: { async pick() { return null; } } satisfies ModelImporter,
  exports: { async save() {} } satisfies GcodeExporter,
  preferences: { async load() { throw new Error(); }, async save() {} } satisfies UserPreferencesRepository,
  runtime: {} as SlicerRuntime,
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
