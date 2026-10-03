import { useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { ArrangeCurrentPlateButton } from './arrangement/ArrangementControls';
import { runProjectHistoryMutation } from './actions/historyMutation';
import { applyPlateSessionResponse } from './plateSessionActions';
import { canAddPlate, canDeletePlate } from './viewport/plateControls';
import type { SceneInteractionController } from './viewport/SceneInteractionController';
import { beforePaintingTopologyChange, paintingCommandAllowed } from './viewport/gizmo/painting/projectCommands';
import { usePaintingPhase } from './viewport/gizmo/painting/PaintingProvider';

/** Fixed plate actions above the Plates tab's scrolling list. */
export function PlateToolbar({ sceneInteraction }: { sceneInteraction: SceneInteractionController }) {
  const platform = usePlatform();
  const plateSession = usePlateSessionStore((state) => state.snapshot);
  const [pending, setPending] = useState(false);
  const paintingPhase = usePaintingPhase();
  const disabled = pending || paintingPhase !== 'closed';

  async function addPlate() {
    if (!paintingCommandAllowed() || pending || !canAddPlate(plateSession)) return;
    setPending(true);
    try {
      await runProjectHistoryMutation(platform.runtime, 'Add Plate', () => platform.runtime.addPlate(), null, {
        contextReceipt: (result) => {
          if (!result.ok) throw new Error(result.error);
          return { structure: 'preserved', activePlateId: result.currentPlateId };
        },
        publish: async (result) => {
          if (applyPlateSessionResponse(platform, result) && result.ok) useProjectStore.getState().recordPlateMutation(result);
        },
      });
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally { setPending(false); }
  }

  async function deletePlate() {
    if (!paintingCommandAllowed() || pending || !plateSession || !canDeletePlate(plateSession)) return;
    const targetPlate = plateSession.plates.find((plate) => plate.plateId === plateSession.currentPlateId);
    if (!await beforePaintingTopologyChange({ instances: targetPlate?.instanceIds })) return;
    setPending(true);
    try {
      await runProjectHistoryMutation(platform.runtime, 'Delete Plate', () => platform.runtime.deletePlate(plateSession.currentPlateId), null, {
        publish: async (result) => {
          if (applyPlateSessionResponse(platform, result) && result.ok) useProjectStore.getState().recordPlateMutation(result);
        },
      });
    } catch (error) {
      useSlicerStore.getState().setError(String(error));
    } finally { setPending(false); }
  }

  if (!plateSession) return null;
  return <div className="py-2" data-testid="plate-controls">
    <div className="mb-2 text-center text-sm font-medium" data-testid="current-plate-label">
      {plateSession.plates.length} {plateSession.plates.length === 1 ? 'Plate' : 'Plates'}
    </div>
    <div className="grid grid-cols-3 gap-2 [&>button]:h-7">
      <Button size="sm" variant="secondary" onClick={() => void addPlate()} disabled={disabled || !canAddPlate(plateSession)} data-testid="add-plate">New Plate</Button>
      <ArrangeCurrentPlateButton sceneInteraction={sceneInteraction} disabled={disabled} compact />
      <Button size="sm" variant="secondary" onClick={() => void deletePlate()} disabled={disabled || !canDeletePlate(plateSession)} data-testid="delete-plate">Delete Plate</Button>
    </div>
  </div>;
}
