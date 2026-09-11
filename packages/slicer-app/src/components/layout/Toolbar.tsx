// packages/slicer-app/src/components/layout/Toolbar.tsx
import { useState } from 'react';
import { Slice, Download, Send as SendIcon, Printer, AppWindowIcon, HouseIcon, LayersIcon, ComputerIcon, Undo2, Redo2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { exportGcode, sliceModel } from '../workspace/actions/sliceActions';
import { usePlatform } from '@orca/platform-contract';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { isAppTab, isPrepareTab, isWorkspaceTab, type AppTab } from './appTabs';
import { useHistoryRestoreStore } from '../../stores/useHistoryRestoreStore';
import { useHistoryNavigationStore } from '../../stores/useHistoryNavigationStore';
import type { HistoryRestoreCoordinator } from '../../history/restoreCoordinator';
import { historyNavigationDisabled, historyNextOperationLabel, projectHistoryEntries } from '../../history/historyNavigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// The scene actions (Add Model / Clear Scene) live elsewhere now: Add Model
// in the gizmo toolbar and Clear Scene in the scene right-click menu (see
// doc/2026-08-22-scene-toolbar-and-context-menu.md). This row is Slice and
// Export only.
export function Toolbar({ activeTab = 'home', onTabChange, onNavigateToDevice, onSlice, historyRestoreCoordinator }: {
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  onNavigateToDevice?: () => void;
  onSlice?: () => Promise<void>;
  historyRestoreCoordinator?: HistoryRestoreCoordinator | null;
} = {}) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const busy = status === 'slicing';
  const restoring = useHistoryRestoreStore((s) => s.phase !== 'idle');
  const historyError = useHistoryRestoreStore((s) => s.error);
  const historyStatus = useHistoryNavigationStore((s) => s.status);
  const hasCompletedResult = status === 'done';
  const [exporting, setExporting] = useState(false);
  const [sendAction, setSendAction] = useState<SendGcodeAction | null>(null);
  const showActions = isWorkspaceTab(activeTab);
  const historyNavigationAvailable = isPrepareTab(activeTab);

  const undoEntries = projectHistoryEntries(historyStatus, 'undo');
  const redoEntries = projectHistoryEntries(historyStatus, 'redo');
  const undoDisabled = !historyNavigationAvailable || historyNavigationDisabled(historyStatus, 'undo', restoring, !!historyRestoreCoordinator);
  const redoDisabled = !historyNavigationAvailable || historyNavigationDisabled(historyStatus, 'redo', restoring, !!historyRestoreCoordinator);
  const undoLabel = historyNextOperationLabel(historyStatus, 'undo');
  const redoLabel = historyNextOperationLabel(historyStatus, 'redo');

  const navigate = (direction: 'undo' | 'redo', entryId?: string) => {
    // A menu can remain mounted during a tab switch. Guard the command as
    // well as its disabled trigger so a stale menu item cannot restore outside
    // Prepare.
    if (!historyNavigationAvailable || !historyRestoreCoordinator) return;
    void historyRestoreCoordinator.restore(entryId ? { jump: entryId, direction } : direction);
  };

  async function slice() { await (onSlice?.() ?? sliceModel(platform)); }

  async function saveExport() {
    setExporting(true);
    try { await exportGcode(platform); }
    finally { setExporting(false); }
  }

  return (
    <>
    <div className="flex w-full items-center justify-between">
      <Tabs value={activeTab} onValueChange={(value) => {
        if (isAppTab(value)) onTabChange?.(value);
      }}>
        <TabsList className="px-0.5 py-0">
          <TabsTrigger value="home" id="app-tab-home" aria-controls="app-panel-home">
            <HouseIcon />
          </TabsTrigger>
          <TabsTrigger value="prepare" id="app-tab-prepare" aria-controls="app-panel-workspace">
            <AppWindowIcon />
            Prepare
          </TabsTrigger>
          <TabsTrigger value="preview" id="app-tab-preview" aria-controls="app-panel-workspace">
            <LayersIcon />
            Preview
          </TabsTrigger>
          <TabsTrigger value="device" id="app-tab-device" aria-controls="app-panel-device" data-testid="tab-device">
            <ComputerIcon />
            Device
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-0.5" data-testid="history-navigation">
        <Button
          size="xs"
          variant="secondary"
          disabled={undoDisabled}
          onClick={() => navigate('undo')}
          aria-label={undoLabel}
          title={undoLabel}
          data-testid="history-undo"
        >
          <Undo2 className="h-3 w-3" /> {undoLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-xs" variant="secondary" aria-label="Show Undo history" title="Show Undo history" />}
            disabled={undoDisabled || undoEntries.length === 0}
            data-testid="history-undo-menu-trigger"
          >
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {undoEntries.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => navigate('undo', entry.id)} data-testid={`history-undo-entry-${entry.id}`}>
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="xs"
          variant="secondary"
          disabled={redoDisabled}
          onClick={() => navigate('redo')}
          aria-label={redoLabel}
          title={redoLabel}
          data-testid="history-redo"
        >
          <Redo2 className="h-3 w-3" /> {redoLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-xs" variant="secondary" aria-label="Show Redo history" title="Show Redo history" />}
            disabled={redoDisabled || redoEntries.length === 0}
            data-testid="history-redo-menu-trigger"
          >
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {redoEntries.map((entry) => (
              <DropdownMenuItem key={entry.id} onClick={() => navigate('redo', entry.id)} data-testid={`history-redo-entry-${entry.id}`}>
                {entry.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {historyError && <span role="alert" className="ml-1 max-w-48 truncate text-[0.625rem] text-destructive" data-testid="history-restore-error" title={historyError}>{historyError}</span>}
      </div>
      {showActions && <div className="flex items-center gap-2" data-testid="toolbar-actions">
        <Button size="xs" variant="secondary" onClick={slice} disabled={busy || restoring || !modelLoaded || hasCompletedResult} data-testid="btn-slice">
          <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
        </Button>
        <Button size="xs" variant="default" disabled={busy || restoring || exporting || !hasCompletedResult} onClick={saveExport} title="Export G-code" data-testid="btn-export">
          <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
        </Button>
        <Button size="xs" variant="secondary" disabled={busy || restoring || !hasCompletedResult} onClick={() => setSendAction('send')} title="Send G-code to printer" data-testid="btn-send">
          <SendIcon className="h-4 w-4" /> Send
        </Button>
        <Button size="xs" variant="default" disabled={busy || restoring || !hasCompletedResult} onClick={() => setSendAction('send-and-print')} title="Send G-code and start printing" data-testid="btn-send-and-print">
          <Printer className="h-4 w-4" /> Send &amp; Print
        </Button>
      </div>}
    </div>
    {showActions && <SendGcodeDialog
      open={sendAction !== null}
      action={sendAction ?? 'send'}
      onClose={() => setSendAction(null)}
      onNavigateToDevice={onNavigateToDevice}
    />}
    </>
  );
}
