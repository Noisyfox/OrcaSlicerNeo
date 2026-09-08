// packages/slicer-wasm/src/client/index.ts
export { createClient } from './client';
export { startWorker, createWorkerClient } from './worker';
export type { WorkerMessage, WorkerTransport } from './worker';
export type {
  SlicerClient, OrcaModule, OrcaModuleFactory,
  InitResult, PresetInfo, PresetSelection, PresetSnapshot,
  FilamentColourProvenance, FilamentSessionSlot, FilamentNativeMapping,
  FilamentFlushingState, FilamentSessionCapabilities, FilamentAssignmentTarget,
  FilamentAssignmentProjection, FilamentAssignmentProjectionSet,
  FilamentSessionRevisions, FilamentSessionStatus, FilamentSessionSnapshot,
  FilamentSessionSnapshotError, FilamentSessionSnapshotResult,
  AtomicCommandSuccessEnvelope, AtomicCommandErrorEnvelope, AtomicCommandResult,
  FilamentMutationSummary, FilamentMutationResult, FilamentMutationResultOrError,
  FilamentCommandRequest, FilamentSlotPresetRequest, FilamentSlotColourRequest,
  FilamentSlotDeleteRequest, FilamentSlotMergeRequest,
  PlateSessionPlate, PlateSessionInstance, PlateSessionInstanceTransform, PlateSessionSnapshot,
  PlateSessionMutation, PlateSessionSnapshotError, PlateSessionSnapshotResult, PlateSessionMutationResult,
  ProjectConfigOverlay, ProjectConfigScope, ProjectConfigOverrideTarget,
  ProjectConfigOverlayResult, ProjectConfigOverlayError, ProjectConfigOverlayResultOrError,
  PresetSnapshotError, PresetSnapshotResult, SelectPresetResult,
  OptionMetadata, OptionMeta,
  LoadModelResult, ProjectLoadMode, ProjectLoadResult, ModelMeshResult, ModelObjectBuffer, ModelTransform,
  DeleteObjectsResult, DeleteVolumesResult, CloneObjectsResult,
  ReorderStructureResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, MutationResult,
  ModelStructureResult, ModelObjectStructure, ModelVolumeStructure,
  ModelInstanceStructure, VolumeType,
  SliceResultStatus, PlateOperationTarget, ClientSliceResult, ClientToolpath,
  ToolpathFeature, PreviewLayerRange, PreviewPaletteEntry, PreviewMetadata,
  PreviewToolpathMetrics, PreviewMetricKey, PreviewMetricRange,
  PreviewAnalysisSummary, PreviewFeatureStatistics, PreviewAnalysis,
  PreviewSourceKind, PreviewTextChunkRequest, PreviewTextChunk, PreviewTextLinesRequest, PreviewTextLines, PreviewSource,
  ExportGcodeResult, ExportProjectResult, CancelResult,
} from './types';
export type {
  StableObjectId, StablePartId, StableInstanceId, StablePlateId,
  HistorySelectionMode, HistorySelection, HistoryJsonValue, HistoryJsonObject,
  HistoryGizmoContext, HistoryContext, HistoryCategory, HistoryEntryCategory, HistoryKind,
  HistoryLabel, HistoryTransactionId, HistoryEntryId, HistoryJumpDirection, HistoryEntrySummary,
  HistoryStatus, HistoryErrorCode, HistoryError, RestoreSuccess, RestoreFailure,
  RestoreResult, HistoryRuntimeMethods, MockHistoryRuntime, HistoryMutation,
} from './history';
export { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_ALIGNMENT_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES, PREVIEW_TEXT_LINES_MAX } from './types';
export { createMockModule } from './testing/mock-module';
export type { MockModule, MockModuleOptions, MockSliceFixture } from './testing/mock-module';
export const CLIENT_VERSION = '0.1.0-m2';
