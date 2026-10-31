import { useNozzleMapping } from './nozzleMapping/useNozzleMapping';
import { useMappingCommit } from './nozzleMapping/NozzleMappingControls';
import { mappingModeLabel } from './nozzleMapping/NozzleMappingEditor';
// packages/slicer-app/src/components/workspace/SliceButton.tsx
import { useEffect, useState } from 'react';
import { ChevronDown, Download, Send as SendIcon, Printer, LoaderCircle, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { cancelSlice, exportGcode, sliceModel } from './actions/sliceActions';
import { usePlatform } from '@orca/platform-contract';
import { SendGcodeDialog, type SendGcodeAction } from '../send/SendGcodeDialog';
import { isWorkspaceTab, type AppTab } from '../layout/appTabs';
import { useHistoryRestoreStore } from '@/stores/useHistoryRestoreStore';

type OutputMode = 'export' | 'send' | 'send-and-print';
const outputModes = {
  'send-and-print': { label: 'Send & Print', description: 'Send G-code and start printing', icon: Printer },
  send: { label: 'Send', description: 'Send G-code to printer', icon: SendIcon },
  export: { label: 'Export', description: 'Export G-code', icon: Download },
} satisfies Record<OutputMode, { label: string; description: string; icon: typeof Download }>;

// Workspace actions float at the viewport's top-left corner.
export function SliceButton({ activeTab = 'home', onNavigateToDevice, onSlice }: {
  activeTab?: AppTab;
  onNavigateToDevice?: () => void;
  onSlice?: () => Promise<void>;
} = {}) {
  const platform = usePlatform();
  const mapping = useNozzleMapping(isWorkspaceTab(activeTab));
  const mappingEdit = useMappingCommit(mapping.snapshot, mapping.revision);
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
  const [outputMenuOpen, setOutputMenuOpen] = useState(false);
  const [outputMode, setOutputMode] = useState<OutputMode>('send-and-print');
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
      </ButtonGroup> : <DropdownMenu open={outputMenuOpen} onOpenChange={setOutputMenuOpen}>
          <ButtonGroup aria-label="Slice and G-code output" className="gap-0.5 [&>[data-slot]]:rounded-md!">
            <Button variant="default" className="w-[150px] justify-start" disabled={actionDisabled} onClick={executeOutput} title={actionDescription} aria-label={actionDescription} data-testid={hasCompletedResult ? `btn-${outputMode}` : 'btn-slice'}>
              {busy ? 'Slicing…' : exporting ? 'Exporting…' : hasCompletedResult ? output.label : 'Slice'}
            </Button>
            {(mapping.snapshot?.eligible || hasCompletedResult) && <DropdownMenuTrigger render={<Button size="icon-xs" className="size-7! shrink-0" />}
              disabled={busy || restoring || exporting} aria-label="Choose G-code output mode" data-testid="output-mode-select"><ChevronDown /></DropdownMenuTrigger>}
          </ButtonGroup>
          <DropdownMenuContent side="bottom" align="end" className="min-w-44">
            {mapping.snapshot?.eligible && <DropdownMenuSub>
              <DropdownMenuSubTrigger>Filament mapping</DropdownMenuSubTrigger>
              <DropdownMenuSubContent aria-label="Filament mapping">
                <DropdownMenuRadioGroup value={String(mapping.snapshot.effective.mode === 3 ? 2 : mapping.snapshot.effective.mode)} onValueChange={value => {
                  setOutputMenuOpen(false);
                  if (value === '0' || value === '1' || value === '2') void mappingEdit.commit({ kind: 'mode', mode: Number(value) as 0 | 1 | 2 });
                }}>
                {mapping.snapshot.modes.filter(m => m.mode !== 3).map(m =>
                  <DropdownMenuRadioItem key={m.mode} value={String(m.mode)} disabled={mappingEdit.disabled || !m.available} title={m.reason || undefined}>
                    {mappingModeLabel(m.mode)}
                    {!m.available ? ' (unavailable)' : ''}
                  </DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>}
            {hasCompletedResult && <DropdownMenuRadioGroup value={outputMode} onValueChange={value => {
              setOutputMenuOpen(false);
              if (value === 'export' || value === 'send' || value === 'send-and-print') setOutputMode(value);
            }}>
              {(Object.keys(outputModes) as OutputMode[]).map((mode) => {
                const Icon = outputModes[mode].icon;
                return <DropdownMenuRadioItem key={mode} value={mode}><Icon />{outputModes[mode].label}</DropdownMenuRadioItem>;
              })}
            </DropdownMenuRadioGroup>}
          </DropdownMenuContent>
        </DropdownMenu>}
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
