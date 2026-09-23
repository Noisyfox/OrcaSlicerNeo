/// <reference path="../env.d.ts" />
// packages/slicer-wasm/src/client/index.ts
export { createClient, normalizeHistoryContext } from './client';
export { startWorker, createWorkerClient } from './worker';
export type { WorkerMessage, WorkerTransport } from './worker';
export type {
  SlicerClient, OrcaModule, OrcaModuleFactory,
  InitResult, FilamentCatalogItem, PresetInfo, PresetSelection, ProfileSnapshot,
  FilamentColourProvenance, FilamentSessionSlot, FilamentNativeMapping,
  FilamentFlushingState, FilamentSessionCapabilities, FilamentAssignmentTarget,
  FilamentAssignmentProjection, FilamentAssignmentProjectionSet,
  FilamentSessionRevisions, FilamentSessionStatus, FilamentSessionSnapshot,
  FilamentSessionSnapshotError, FilamentSessionSnapshotResult,
  AtomicCommandSuccessEnvelope, AtomicCommandErrorEnvelope, AtomicCommandResult,
  NativePrimeTowerProjectionStage, NativePerformanceSample, NativePerformanceProfile,
  FilamentMutationSummary, FilamentMutationResult, FilamentMutationResultOrError,
  FilamentCommandRequest, FilamentSlotPresetRequest, FilamentSlotColourRequest,
  FilamentSlotDeleteRequest, FilamentSlotMergeRequest,
  FilamentAssignmentTargetRequest, FilamentAssignmentRequest,
  FilamentRoutingTarget, FilamentRoutingProjection, FilamentRoutingTargetRequest,
  FilamentRoutingSelector, FilamentRoutingRequest,
  PlateSessionPlate, PlateSessionInstance, PlateSessionInstanceTransform, PlateSessionSnapshot,
  PlateSessionMutation, PlateSelection, PlateSessionSnapshotError, PlateSessionSnapshotResult, PlateSessionMutationResult, PlateSelectionResult,
  PrimeTowerBuildArea, PrimeTowerFootprint, PrimeTowerBand, PrimeTowerPlateProjection,
  PrimeTowerProjection, PrimeTowerProjectionError, PrimeTowerProjectionResult,
  PrimeTowerMoveRequest, PrimeTowerMoveMutation, PrimeTowerMoveResult, PrimeTowerMoveResultOrError,
  NativeScopedConfigSnapshot, NativeScopedConfigScope, NativeScopedConfigTargetIdentity, NativeScopedConfigTarget,
  NativeScopedConfigMutationOperation, NativeScopedConfigMutationRequest,
  NativeScopedConfigTargetReplacement, NativeScopedConfigFullTransport,
  NativeScopedConfigAffectedTransport, NativeScopedConfigTransport,
  NativeScopedConfigResult, NativeScopedConfigError, NativeScopedConfigResultOrError,
  ProfileSnapshotError, ProfileSnapshotResult,
  OptionMetadata, OptionMeta,
  PresetDraftKind, PresetDraftTarget, PresetDraftSnapshot, PresetDraftSnapshotResult,
  PresetDraftMutationRequest, PresetDraftMutationResult, PresetDraftMutationSuccess, PresetDraftError,
  LoadModelResult, ProjectLoadMode, ProjectLoadResult, ModelMeshResult, ModelScenePatchResult, ModelObjectBuffer, ModelRenderable, ModelGeometry, NativeModelObjectBuffer, ModelTransform, ModelTransformMutation,
  DeleteObjectsResult, DeleteVolumesResult, CloneObjectsResult,
  ReorderStructureResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, MutationResult,
  ModelStructureResult, ModelObjectStructure, ModelVolumeStructure,
  ModelInstanceStructure, VolumeType,
  SliceResultStatus, PlateOperationTarget, SliceResultReceipt, ResultReadStatus,
  ClientSliceResult, ClientToolpath,
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
  HistoryStatus, HistoryCommitResult, HistoryErrorCode, HistoryError, RestoreSuccess, RestoreFailure,
  RestoreResult, RestoreImpact, SceneDelta, HistoryTimingDiagnostic, HistoryDiagnosticLayer, HistoryReadDiagnosticLayer,
  HistoryTransportDiagnostics, HistoryRuntimeMethods, MockHistoryRuntime, HistoryMutation,
} from './history';
export { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_ALIGNMENT_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES, PREVIEW_TEXT_LINES_MAX } from './types';
export { createMockModule } from './testing/mock-module';
export type { MockModule, MockModuleOptions, MockSliceFixture } from './testing/mock-module';
export const CLIENT_VERSION = '0.1.0-m2';
