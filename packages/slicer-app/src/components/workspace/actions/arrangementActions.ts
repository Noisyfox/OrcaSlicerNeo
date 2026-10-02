import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ArrangementRequest } from '@slicer/client';
import { useArrangementStore, loadArrangementPreferences } from '@/stores/useArrangementStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { applyPlateSessionResponse } from '../plateSessionActions';
import { historyContextForStructure, publishNativeOperationHistory, runProjectMutationOperation } from './historyMutation';
import { closePaintingForCommand, paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

let starting = false;
export async function arrangeModels(platform: PlatformCapabilities, scene: SceneInteractionController, scope: ArrangementRequest['scope']): Promise<void> {
  if (starting || useArrangementStore.getState().active || !paintingCommandAllowed()) return;
  if (platform.runtime.getRuntimeExecutionState().serialSliceActive || scene.owner !== 'none') return;
  const snapshot = usePlateSessionStore.getState().snapshot;
  if (scope === 'current' && snapshot?.plates.find(plate => plate.plateId === snapshot.currentPlateId)?.locked) return;
  starting = true;
  try {
    await loadArrangementPreferences(platform.preferences);
    if (!await closePaintingForCommand()) return;
    scene.closeGizmo();
    await runProjectMutationOperation(async (lease) => {
      const { values } = useSettingsStore.getState();
      const { preferences, alignY } = useArrangementStore.getState();
      const mode = values.print_sequence === 'by object' ? 'byObject' : 'byLayer';
      useArrangementStore.setState({ active: true, cancellable: platform.runtime.getRuntimeExecutionState().threaded === true,
        cancelling: false, result: null, progress: 0, message: 'Preparing arrangement…' });
      try {
        const result = await platform.runtime.arrange({ scope, ...preferences[mode], alignY: !preferences[mode].rotate && alignY,
          multipleMaterials: preferences.multipleMaterials, avoidCalibration: preferences.avoidCalibration,
          context: historyContextForStructure(scene),
        }, (progress, message) => useArrangementStore.setState({ progress, message: message || 'Arranging models…' }));
        if (result.ok && result.changed) {
          if (!applyPlateSessionResponse(platform, result.plateSession)) throw new Error('Could not publish arrangement');
          useProjectStore.getState().recordPlateMutation(result.plateSession);
          await publishNativeOperationHistory(platform.runtime, lease, result.plateSession.inputRevisions);
          scene.notifyTransformsChanged();
        }
        useArrangementStore.setState({ result, progress: result.ok && !result.cancelled ? 100 : 0 });
      } finally { useArrangementStore.setState({ active: false, cancelling: false }); }
    });
  } catch (error) {
    useArrangementStore.setState({ active: false, result: { ok: false, error: String(error) } });
  } finally { starting = false; }
}

export async function cancelArrangement(platform: PlatformCapabilities): Promise<void> {
  const state = useArrangementStore.getState();
  if (!state.active || !state.cancellable || state.cancelling) return;
  useArrangementStore.setState({ cancelling: true, message: 'Cancelling arrangement…' });
  try {
    const result = await platform.runtime.cancelArrangement();
    if (!result.ok && useArrangementStore.getState().active) useArrangementStore.setState({ cancelling: false, message: result.error });
  } catch (error) { useArrangementStore.setState({ cancelling: false, message: String(error) }); }
}
