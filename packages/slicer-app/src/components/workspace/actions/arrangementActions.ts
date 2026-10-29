import type { PlatformCapabilities } from '@orca/platform-contract';
import type { ArrangementParkingReason, ArrangementRequest, ArrangementResult } from '@slicer/client';
import { useNotificationStore, type ArrangementNotification, type ArrangementNotificationUpdate } from '@/stores/useNotificationStore';
import { useArrangementStore, loadArrangementPreferences } from '@/stores/useArrangementStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { applyPlateSessionResponse } from '../plateSessionActions';
import { historyContextForStructure, publishNativeOperationHistory, runProjectMutationOperation } from './historyMutation';
import { closePaintingForCommand, paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';

let starting = false;
const PARKING_REASONS: Record<ArrangementParkingReason, string> = {
  'non-printable': 'Marked non-printable', degenerate: 'Unusable footprint',
  'too-tall': 'Exceeds print height', unfit: 'Cannot fit on a plate',
  'plate-limit': '36-plate limit reached', 'current-plate-overflow': 'No room on the current plate',
};
function arrangementOutcome(result: ArrangementResult): ArrangementNotificationUpdate {
  if (!result.ok) return { title: 'Arrangement failed', message: result.error, severity: 'error', progress: null };
  if (result.cancelled) return { title: 'Arrangement cancelled', message: 'No arrangement changes were applied.', severity: 'info', progress: null };
  const counts = new Map<ArrangementParkingReason, number>();
  for (const item of result.unplaced) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return { title: 'Arrangement complete', severity: result.unplaced.length || result.plateLimitReached ? 'warning' : 'info', progress: null,
    message: [`${result.placed} placed · ${result.unplaced.length} parked outside plates`,
      ...(result.plateLimitReached ? ['The 36-plate limit was reached.'] : []),
      ...[...counts].map(([reason, count]) => `${PARKING_REASONS[reason]}: ${count}`)].join('\n') };
}
export async function arrangeModels(platform: PlatformCapabilities, scene: SceneInteractionController, scope: ArrangementRequest['scope']): Promise<void> {
  if (starting || useArrangementStore.getState().active || !paintingCommandAllowed()) return;
  if (platform.runtime.getRuntimeExecutionState().serialSliceActive || scene.owner !== 'none') return;
  const snapshot = usePlateSessionStore.getState().snapshot;
  const notificationSession = useNotificationStore.getState().session;
  if (scope === 'current' && snapshot?.plates.find(plate => plate.plateId === snapshot.currentPlateId)?.locked) return;
  starting = true;
  let notification: ArrangementNotification | undefined;
  try {
    await loadArrangementPreferences(platform.preferences);
    if (!await closePaintingForCommand()) return;
    scene.closeGizmo();
    notification = useNotificationStore.getState().beginArrangement(snapshot?.currentPlateId ?? '');
    const token = notification;
    await runProjectMutationOperation(async (lease) => {
      const { values } = useSettingsStore.getState();
      const { preferences, alignY } = useArrangementStore.getState();
      const mode = values.print_sequence === 'by object' ? 'byObject' : 'byLayer';
      useArrangementStore.setState({ active: true, cancellable: platform.runtime.getRuntimeExecutionState().threaded === true,
        cancelling: false });
      try {
        const result = await platform.runtime.arrange({ scope, ...preferences[mode], alignY: !preferences[mode].rotate && alignY,
          multipleMaterials: preferences.multipleMaterials, avoidCalibration: preferences.avoidCalibration,
          context: historyContextForStructure(scene),
        }, (progress, message) => useNotificationStore.getState().updateArrangement(token, {
          title: 'Arranging models', severity: 'info', progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0,
          message: useArrangementStore.getState().cancelling ? 'Cancelling arrangement…' : message || 'Arranging models…',
        }));
        if (result.ok && result.changed) {
          if (!applyPlateSessionResponse(platform, result.plateSession)) throw new Error('Could not publish arrangement');
          await publishNativeOperationHistory(platform.runtime, lease, result.plateSession.inputRevisions);
          scene.notifyTransformsChanged();
        }
        useNotificationStore.getState().updateArrangement(token, arrangementOutcome(result));
      } finally { useArrangementStore.setState({ active: false, cancelling: false }); }
    });
  } catch (error) {
    useArrangementStore.setState({ active: false, cancelling: false });
    if (!notification && useNotificationStore.getState().session === notificationSession)
      notification = useNotificationStore.getState().beginArrangement(snapshot?.currentPlateId ?? '');
    if (notification) useNotificationStore.getState().updateArrangement(notification, arrangementOutcome({ ok: false, error: String(error) }));
  } finally { starting = false; }
}

export async function cancelArrangement(platform: PlatformCapabilities): Promise<void> {
  const state = useArrangementStore.getState();
  if (!state.active || !state.cancellable || state.cancelling) return;
  const notification = useNotificationStore.getState().notifications.find((n): n is ArrangementNotification =>
    n.source === 'arrangement' && n.progress !== null);
  if (!notification) return;
  const stillRunning = () => useNotificationStore.getState().notifications.some(n =>
    n.source === 'arrangement' && n.id === notification.id && n.progress !== null);
  const updateMessage = (message: string) => {
    useNotificationStore.getState().updateArrangement(notification, { message });
  };
  useArrangementStore.setState({ cancelling: true });
  updateMessage('Cancelling arrangement…');
  try {
    const result = await platform.runtime.cancelArrangement();
    if (!result.ok && useArrangementStore.getState().active && stillRunning()) {
      useArrangementStore.setState({ cancelling: false }); updateMessage(result.error);
    }
  } catch (error) {
    if (useArrangementStore.getState().active && stillRunning()) {
      useArrangementStore.setState({ cancelling: false }); updateMessage(String(error));
    }
  }
}
