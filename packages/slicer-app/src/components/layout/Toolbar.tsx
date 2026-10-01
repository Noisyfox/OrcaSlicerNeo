// packages/slicer-app/src/components/layout/Toolbar.tsx
import { useState } from 'react';
import { Slice, Download, Send as SendIcon, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { exportGcode, sliceModel } from '../workspace/actions/sliceActions';
import { usePlatform } from '@orca/platform-contract';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { isWorkspaceTab, type AppTab } from './appTabs';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';

// The scene actions (Add Model / Clear Scene) live elsewhere now: Add Model
// in the gizmo toolbar and Clear Scene in the scene right-click menu (see
// doc/2026-08-22-scene-toolbar-and-context-menu.md). This row is Slice and
// Export only.
export function Toolbar({ activeTab = 'home', onNavigateToDevice, onSlice }: {
  activeTab?: AppTab;
  onNavigateToDevice?: () => void;
  onSlice?: () => Promise<void>;
} = {}) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const busy = status === 'slicing';
  const restoring = useHistoryRestoreStore((s) => s.phase !== 'idle');
  const hasCompletedResult = status === 'done';
  const [exporting, setExporting] = useState(false);
  const [sendAction, setSendAction] = useState<SendGcodeAction | null>(null);
  const showActions = isWorkspaceTab(activeTab);
  async function slice() { await (onSlice?.() ?? sliceModel(platform)); }

  async function saveExport() {
    setExporting(true);
    try { await exportGcode(platform); }
    finally { setExporting(false); }
  }

  return (
    <>
    <div className="flex w-full items-center justify-end">
      {showActions && <div className="flex items-center gap-2" data-testid="toolbar-actions">
        <Button size="xs" variant="secondary" onClick={slice} disabled={busy || restoring || !modelLoaded || hasCompletedResult} data-testid="btn-slice">
          <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
        </Button>
        <TooltipFor content="Export G-code" disabled={busy || restoring || exporting || !hasCompletedResult}>
          <Button size="xs" variant="default" disabled={busy || restoring || exporting || !hasCompletedResult} onClick={saveExport} data-testid="btn-export">
            <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </TooltipFor>
        <TooltipFor content="Send G-code to printer" disabled={busy || restoring || !hasCompletedResult}>
          <Button size="xs" variant="secondary" disabled={busy || restoring || !hasCompletedResult} onClick={() => setSendAction('send')} data-testid="btn-send">
            <SendIcon className="h-4 w-4" /> Send
          </Button>
        </TooltipFor>
        <TooltipFor content="Send G-code and start printing" disabled={busy || restoring || !hasCompletedResult}>
          <Button size="xs" variant="default" disabled={busy || restoring || !hasCompletedResult} onClick={() => setSendAction('send-and-print')} data-testid="btn-send-and-print">
            <Printer className="h-4 w-4" /> Send &amp; Print
          </Button>
        </TooltipFor>
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
