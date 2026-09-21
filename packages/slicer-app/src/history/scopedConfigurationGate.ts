// Test-only entrypoints into the actual application mutation/restore paths.
// No retained model, geometry, or configuration state belongs in this module.
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { NativeScopedConfigMutationRequest } from '@slicer/client';
import type { HistoryRestoreCoordinator, HistoryRestoreAction } from './restoreCoordinator';
import { useHistoryRestoreStore } from '../stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '../stores/useHistoryNavigationStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProjectStore } from '../stores/useProjectStore';
import { usePlateSessionStore } from '../stores/usePlateSessionStore';
import { useObjectListStore } from '../components/workspace/objectList/useObjectListStore';
import { glVolumeCollection, waitForGLVolumeRevision } from '../components/workspace/viewport/GLVolume';
import { commitScopedConfigurationMutation } from '../components/workspace/settings/configurationActions';
import { deleteObjectsInList } from '../components/workspace/objectList/structuralActions';
import { executeProjectHistoryTransaction, historyContextForStructure, resetProjectHistory } from '../components/workspace/actions/historyMutation';
import { applyPlateSessionTransforms } from '../components/workspace/actions/syncModelTransforms';
import { captureHistoryTransportDiagnostics, useHistoryDiagnosticsStore } from './historyDiagnostics';
import { sliceModel } from '../components/workspace/actions/sliceActions';

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

export function installScopedConfigurationGate(platform: PlatformCapabilities, coordinator: HistoryRestoreCoordinator) {
  const ready = async () => {
    await waitForGLVolumeRevision(useSettingsStore.getState().modelRevision);
    await frame();
    await frame();
    if (useProjectStore.getState().projectMutationPendingCount !== 0 || useHistoryRestoreStore.getState().phase !== 'idle')
      throw new Error('history gate requires an idle editable scene');
    return performance.now();
  };
  const snapshot = () => ({
    configuration: useSettingsStore.getState().nativeScopedConfig,
    objects: useObjectListStore.getState().structure,
    plates: usePlateSessionStore.getState().snapshot,
    status: useHistoryNavigationStore.getState().status,
    glRevision: glVolumeCollection.revision,
    modelRevision: useSettingsStore.getState().modelRevision,
    volumeIds: glVolumeCollection.volumes.map((volume) => volume.id),
    transforms: glVolumeCollection.volumes.map((volume) => ({ id: volume.id,
      transform: volume.instanceTransform, volumeTransform: volume.volumeTransform })),
  });
  const diagnostics = () => {
    captureHistoryTransportDiagnostics(platform.runtime);
    const { app, client, worker } = useHistoryDiagnosticsStore.getState();
    return { app, client, worker };
  };
  const admittedSliceCount = async () => Number((await platform.runtime.getNativeHistoryDiagnostics?.())?.pendingSliceTaskCount ?? 0);
  const gate = {
    ready, snapshot, diagnostics, admittedSliceCount,
    execution: () => platform.runtime.getRuntimeExecutionState(),
    startSlice: () => { void sliceModel(platform).catch(() => undefined); },
    cancelSlice: () => platform.runtime.cancel(),
    attribution: async () => ({ memory: await platform.runtime.getRuntimeMemory(),
      native: await platform.runtime.takeNativePerformanceProfile?.(),
      archive: await platform.runtime.getNativeHistoryDiagnostics?.() }),
    resetHistory: () => resetProjectHistory(platform.runtime, historyContextForStructure()),
    configure: (request: NativeScopedConfigMutationRequest) => commitScopedConfigurationMutation(platform, request),
    delete: (objectId: number) => deleteObjectsInList(platform.runtime, [objectId]),
    move: async () => {
      const volume = glVolumeCollection.volumes[0];
      if (!volume) throw new Error('no model volume');
      const instanceTransform = structuredClone(volume.instanceTransform);
      instanceTransform.offset[0] += 1;
      return executeProjectHistoryTransaction(platform.runtime, 'Gate Move', historyContextForStructure,
        (transactionId) => platform.runtime.setModelTransforms(transactionId, [{
          objectIdx: volume.buffer.objectIdx, volumeIdx: volume.buffer.volumeIdx, instanceIdx: volume.buffer.instanceIdx,
          instanceTransform, volumeTransform: volume.volumeTransform,
        }]), historyContextForStructure,
        (result) => {
          if (!result.ok) throw new Error(result.error);
          for (const item of glVolumeCollection.volumes) {
            if (item.buffer.objectId === volume.buffer.objectId && item.buffer.instanceId === volume.buffer.instanceId)
              item.instanceTransform = structuredClone(instanceTransform);
          }
          applyPlateSessionTransforms(result.plateSession, glVolumeCollection.volumes);
          if (result.plateSession) usePlateSessionStore.getState().setSnapshot(result.plateSession);
          glVolumeCollection.publish();
        });
    },
    restore: async (action: HistoryRestoreAction, requireAdmittedSlice = false) => {
      await ready();
      // Dispatch a renderer DOM event. Start inside its listener immediately
      // before invoking the same coordinator used by toolbar/keyboard Undo.
      return new Promise((resolve, reject) => {
        const eventName = 'orca-scoped-history-gate';
        const listener = () => {
          const eventAt = performance.now();
          const execution = platform.runtime.getRuntimeExecutionState();
          const before = diagnostics();
          void (async () => {
            // This roundtrip belongs inside the timed event. It proves native
            // admission, rather than the proxy's earlier request-in-flight flag.
            const pendingSliceTaskCountAtEvent = requireAdmittedSlice ? await admittedSliceCount() : undefined;
            if (requireAdmittedSlice && !(pendingSliceTaskCountAtEvent! > 0))
              throw new Error('active-slice event requires a native-admitted pending task');
            const ok = await coordinator.restore(action);
            if (!ok) throw new Error(useHistoryRestoreStore.getState().error ?? 'restore rejected');
            // Exclude React/GL complex-model loading explicitly, even if a
            // projection implementation later resolves before GL publication.
            await waitForGLVolumeRevision(useSettingsStore.getState().modelRevision);
            const modelReadyAt = performance.now();
            const editableAt = await ready();
            resolve({ eventAt, modelReadyAt, editableAt, execution, pendingSliceTaskCountAtEvent, eventToEditableMs: editableAt - eventAt,
              postModelReadyToEditableMs: editableAt - modelReadyAt, before, after: diagnostics() });
          })().catch(reject);
        };
        document.addEventListener(eventName, listener, { once: true });
        document.dispatchEvent(new Event(eventName));
      });
    },
  };
  const target = window as unknown as { __orcaScopedConfigurationGate?: typeof gate };
  target.__orcaScopedConfigurationGate = gate;
  return () => { delete target.__orcaScopedConfigurationGate; };
}
