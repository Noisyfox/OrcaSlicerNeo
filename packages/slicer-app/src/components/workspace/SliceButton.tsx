// packages/slicer-app/src/components/workspace/SliceButton.tsx
import { useEffect, useState } from 'react';
import { Download, Send as SendIcon, Printer, LoaderCircle, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Select, SelectTrigger, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cancelSlice, exportGcode, sliceModel } from './actions/sliceActions';
import { usePlatform } from '@orca/platform-contract';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { isWorkspaceTab, type AppTab } from '../layout/appTabs';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';

type OutputMode = 'export' | 'send' | 'send-and-print';
const outputModes = {
  export: { label: 'Export', description: 'Export G-code', icon: Download },
  send: { label: 'Send', description: 'Send G-code to printer', icon: SendIcon },
  'send-and-print': { label: 'Send & Print', description: 'Send G-code and start printing', icon: Printer },
} satisfies Record<OutputMode, { label: string; description: string; icon: typeof Download }>;

// Workspace actions float at the viewport's top-left corner.
export function SliceButton({ activeTab = 'home', onNavigateToDevice, onSlice }: {
  activeTab?: AppTab;
  onNavigateToDevice?: () => void;
  onSlice?: () => Promise<void>;
} = {}) {
  const platform = usePlatform();
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const percent = Math.round(Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0)));
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const busy = status === 'slicing';
  const restoring = useHistoryRestoreStore((s) => s.phase !== 'idle');
  const hasCompletedResult = status === 'done';
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => { if (!busy) setCancelling(false); }, [busy]);
  const [exporting, setExporting] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputMode>('export');
  const [sendAction, setSendAction] = useState<SendGcodeAction | null>(null);
  const showActions = isWorkspaceTab(activeTab);
  const output = outputModes[outputMode];
  const actionDisabled = busy || restoring || exporting || (!hasCompletedResult && !modelLoaded);
  const actionDescription = hasCompletedResult ? output.description : 'Slice';
  const executeOutput = () => {
    if (actionDisabled) return;
    if (!hasCompletedResult) {
      void slice();
      return;
    }
    if (outputMode === 'export') void saveExport();
    else setSendAction(outputMode);
  };
  async function slice() { await (onSlice?.() ?? sliceModel(platform)); }

  async function saveExport() {
    setExporting(true);
    try { await exportGcode(platform); }
    finally { setExporting(false); }
  }

  return (
    <>
    {showActions && <div data-testid="toolbar-actions">
      {busy ? <ButtonGroup aria-label="Slicing progress" className="gap-0.5 [&>[data-slot]]:rounded-md!">
        <Progress value={percent} aria-label="Slicing" data-testid="slice-button-progress"
          className="relative h-7 w-[150px] overflow-hidden rounded-md bg-[#285778] text-white [&>[data-slot=progress-track]]:absolute [&>[data-slot=progress-track]]:inset-0 [&>[data-slot=progress-track]]:h-full [&>[data-slot=progress-track]]:rounded-none [&>[data-slot=progress-track]]:bg-transparent [&_[data-slot=progress-indicator]]:bg-[#167ac1]">
          <span className="pointer-events-none relative z-10 flex h-full items-center gap-1 px-2 text-xs">
            {cancelling ? 'Cancelling…' : 'Slicing'} <span className="text-[10px] tabular-nums">{percent}%</span>
          </span>
        </Progress>
        <Button size="icon" className="group bg-[#167ac1] text-white hover:bg-red-600 focus-visible:bg-red-600" aria-label="Cancel slicing" title="Cancel slicing" data-testid="btn-cancel-slice" disabled={cancelling}
          onClick={async () => { setCancelling(true); if (!await cancelSlice(platform)) setCancelling(false); }}>
          <LoaderCircle className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden" />
          <X className="hidden size-4 group-hover:block group-focus-visible:block" />
        </Button>
      </ButtonGroup> : <Select value={outputMode} onValueChange={(value) => {
          if (value === 'export' || value === 'send' || value === 'send-and-print') setOutputMode(value);
        }} disabled={busy || restoring || exporting}>
          <ButtonGroup aria-label="Slice and G-code output" className="gap-0.5 [&>[data-slot]]:rounded-md!">
            <Button variant="default" className="w-[150px] justify-start" disabled={actionDisabled} onClick={executeOutput} title={actionDescription} aria-label={actionDescription} data-testid={hasCompletedResult ? `btn-${outputMode}` : 'btn-slice'}>
              {busy ? 'Slicing…' : exporting ? 'Exporting…' : hasCompletedResult ? output.label : 'Slice'}
            </Button>
            <SelectTrigger variant="action" className="size-7! shrink-0" aria-label="Choose G-code output mode" data-testid="output-mode-select" />
          </ButtonGroup>
          <SelectContent side="bottom" align="end" className="min-w-44">
            <SelectGroup>
              {(Object.keys(outputModes) as OutputMode[]).map((mode) => {
                const Icon = outputModes[mode].icon;
                return <SelectItem key={mode} value={mode} className="pr-8"><Icon />{outputModes[mode].label}</SelectItem>;
              })}
            </SelectGroup>
          </SelectContent>
        </Select>}
    </div>}
    {showActions && <SendGcodeDialog
      open={sendAction !== null}
      action={sendAction ?? 'send'}
      onClose={() => setSendAction(null)}
      onNavigateToDevice={onNavigateToDevice}
    />}
    </>
  );
}
