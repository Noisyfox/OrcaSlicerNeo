import { Undo2, Redo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup, ContextMenuItem } from '@/components/ui/context-menu';
import { usePlatform } from '@orca/platform-contract';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { historyNavigationDisabled, historyNextOperationLabel, projectHistoryEntries } from '@/history/historyNavigation';
import type { HistoryRestoreCoordinator } from '@/history/restoreCoordinator';
import { usePaintingState } from '../workspace/viewport/gizmo/painting/PaintingProvider';
import { isSerialSliceBusy } from '@/runtimeExecution';
import { isPrepareTab, type AppTab } from './appTabs';

export function HistoryNavigation({ activeTab, coordinator }: {
  activeTab: AppTab;
  coordinator?: HistoryRestoreCoordinator | null;
}) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const restoring = useHistoryRestoreStore((s) => s.phase !== 'idle');
  const error = useHistoryRestoreStore((s) => s.error);
  const history = useHistoryNavigationStore((s) => s.status);
  const painting = usePaintingState();
  const paintingPending = painting != null && painting.phase !== 'closed' && painting.phase !== 'idle';
  const unavailable = paintingPending || isSerialSliceBusy(platform.runtime, status) || !isPrepareTab(activeTab);

  return (
    <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]" data-testid="history-navigation">
      {(['undo', 'redo'] as const).map((direction) => {
        const disabled = unavailable || historyNavigationDisabled(history, direction, restoring, !!coordinator);
        const entries = projectHistoryEntries(history, direction);
        const label = historyNextOperationLabel(history, direction);
        const Icon = direction === 'undo' ? Undo2 : Redo2;
        const navigate = (entryId?: string) => {
          if (disabled || !coordinator) return;
          void coordinator.restore(entryId ? { jump: entryId, direction } : direction);
        };
        return (
          <ContextMenu key={direction} disabled={disabled || entries.length === 0}>
            <TooltipFor content={`${label} · Right-click for history`} disabled={disabled}>
              <ContextMenuTrigger
                onContextMenuCapture={(event) => {
                  if (disabled || entries.length === 0) event.preventDefault();
                }}
                render={<Button size="icon" variant="ghost" className="titlebar-action" disabled={disabled} aria-label={label} onClick={() => navigate()} data-testid={`history-${direction}`} />}
              >
                <Icon />
              </ContextMenuTrigger>
            </TooltipFor>
            <ContextMenuContent aria-label={`${direction === 'undo' ? 'Undo' : 'Redo'} history`}>
              <ContextMenuGroup>
                {entries.map((entry) => (
                  <ContextMenuItem key={entry.id} disabled={disabled} onClick={() => navigate(entry.id)} data-testid={`history-${direction}-entry-${entry.id}`}>
                    {entry.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuGroup>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      {error && <TooltipFor content={error}><span role="alert" className="ml-1 max-w-48 truncate text-[0.625rem] text-destructive" data-testid="history-restore-error">{error}</span></TooltipFor>}
    </div>
  );
}
