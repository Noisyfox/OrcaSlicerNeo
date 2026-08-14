// packages/slicer-wasm/src/client/index.ts
export { createClient } from './client';
export { startWorker, createWorkerClient } from './worker';
export type { WorkerMessage, WorkerTransport } from './worker';
export type {
  SlicerClient, OrcaModule, OrcaModuleFactory,
  InitResult, PresetInfo, PresetList, AppConfig, SelectPresetResult,
  OptionMetadata, OptionMeta,
  LoadModelResult, ModelMeshResult, ModelObjectBuffer,
  SliceResultStatus, ClientSliceResult, ClientToolpath,
  ClientSlicedMesh, ToolpathFeature, ExportGcodeResult, CancelResult,
} from './types';
export { createMockModule } from './testing/mock-module';
export type { MockModule, MockModuleOptions, MockSliceFixture } from './testing/mock-module';
export const CLIENT_VERSION = '0.1.0-m2';
