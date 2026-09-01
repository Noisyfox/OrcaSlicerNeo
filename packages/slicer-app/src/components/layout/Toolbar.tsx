// packages/slicer-app/src/components/layout/Toolbar.tsx
import { useState } from 'react';
import { Slice, Download, Send as SendIcon, Printer, AppWindowIcon, HouseIcon, LayersIcon, ComputerIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { exportGcode, sliceModel } from '../workspace/actions/sliceActions';
import { usePlatform } from '@orca/platform-contract';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { isAppTab, isWorkspaceTab, type AppTab } from './appTabs';

export type { AppTab } from './appTabs';

// The scene actions (Add Model / Clear Scene) live elsewhere now: Add Model
// in the gizmo toolbar and Clear Scene in the scene right-click menu (see
// doc/2026-08-22-scene-toolbar-and-context-menu.md). This row is Slice and
// Export only.
export function Toolbar({ activeTab = 'home', onTabChange, onNavigateToDevice, onSlice }: {
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
  onNavigateToDevice?: () => void;
  onSlice?: () => Promise<void>;
} = {}) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const busy = status === 'slicing';
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
      {showActions && <div className="flex items-center gap-2" data-testid="toolbar-actions">
        <Button size="xs" variant="secondary" onClick={slice} disabled={busy || !modelLoaded || hasCompletedResult} data-testid="btn-slice">
          <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
        </Button>
        <Button size="xs" variant="default" disabled={busy || exporting || !hasCompletedResult} onClick={saveExport} title="Export G-code" data-testid="btn-export">
          <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
        </Button>
        <Button size="xs" variant="secondary" disabled={busy || !hasCompletedResult} onClick={() => setSendAction('send')} title="Send G-code to printer" data-testid="btn-send">
          <SendIcon className="h-4 w-4" /> Send
        </Button>
        <Button size="xs" variant="default" disabled={busy || !hasCompletedResult} onClick={() => setSendAction('send-and-print')} title="Send G-code and start printing" data-testid="btn-send-and-print">
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
