import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Menu, Search } from 'lucide-react';
import { usePlateListViewStore } from '@/stores/usePlateListViewStore';
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
  const { searchOpen, query, toggleSearch, setQuery } = usePlateListViewStore();
  useEffect(() => () => usePlateListViewStore.getState().reset(), []);

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
    <div className="mb-2 flex items-center justify-between gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-sm" variant="secondary" aria-label="Plate menu" data-testid="plate-menu" />}><Menu /></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive" onClick={() => void deletePlate()} disabled={disabled || !canDeletePlate(plateSession)} data-testid="delete-plate">Delete current plate</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="text-sm font-medium" data-testid="current-plate-label">{plateSession.plates.length} {plateSession.plates.length === 1 ? 'Plate' : 'Plates'}</span>
      <Button size="icon-sm" variant="secondary" aria-label="Search plates" aria-expanded={searchOpen} onClick={toggleSearch} data-testid="plate-search-toggle"><Search /></Button>
    </div>
    <div className="flex gap-2 [&>button]:h-7">
      <Button size="sm" variant="secondary" onClick={() => void addPlate()} disabled={disabled || !canAddPlate(plateSession)} data-testid="add-plate">New Plate</Button>
      <ArrangeCurrentPlateButton sceneInteraction={sceneInteraction} disabled={disabled} compact />
    </div>
    {searchOpen && <Input className="mt-2 h-7" autoFocus aria-label="Filter plates" placeholder="Search plates…" value={query} onChange={event => setQuery(event.target.value)} data-testid="plate-search" />}
  </div>;
}
