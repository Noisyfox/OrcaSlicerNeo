// packages/slicer-wasm/src/client/index.ts
export { createClient } from './client';
export { startWorker, createWorkerClient } from './worker';
export type { WorkerMessage, WorkerTransport } from './worker';
export type {
  SlicerClient, OrcaModule, OrcaModuleFactory,
  InitResult, PresetInfo, PresetSelection, PresetSnapshot,
  PresetSnapshotError, PresetSnapshotResult, SelectPresetResult,
  OptionMetadata, OptionMeta,
  LoadModelResult, ModelMeshResult, ModelObjectBuffer, ModelTransform,
  DeleteObjectsResult, DeleteVolumesResult, CloneObjectsResult,
  ReorderStructureResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, MutationResult,
  ModelStructureResult, ModelObjectStructure, ModelVolumeStructure,
  ModelInstanceStructure, VolumeType,
  SliceResultStatus, ClientSliceResult, ClientToolpath,
  ToolpathFeature, PreviewLayerRange, PreviewPaletteEntry, PreviewMetadata,
  PreviewToolpathMetrics, ExportGcodeResult, CancelResult,
} from './types';
export { createMockModule } from './testing/mock-module';
export type { MockModule, MockModuleOptions, MockSliceFixture } from './testing/mock-module';
export const CLIENT_VERSION = '0.1.0-m2';
