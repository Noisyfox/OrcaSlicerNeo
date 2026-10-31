import { useEffect, useState } from 'react';
import { usePlatform, type PlatformCapabilities } from '@orca/platform-contract';
import { validateSynchronizationSource, type SynchronizationSource } from '@orca/printer-control';
import type { DeviceFilamentOptions, FilamentSessionSnapshot } from '@slicer/client';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { readProjectMutationReservation } from '../actions/historyMutation';
import { FilamentSwatch } from '../FilamentSwatch';
import { materialImportSources } from './materialSynchronization';

type Options = Extract<DeviceFilamentOptions, { ok: true }>;
export interface DeviceFilaments { source: SynchronizationSource; prepared: Options }
/** Read local observations and native catalogue only. No subscription or network refresh. */
export function useDeviceFilaments(snapshot: FilamentSessionSnapshot | null): DeviceFilaments | null {
  const platform = usePlatform();
  const source = useDeviceSelectionStore(s => s.materials);
  const current = useDeviceSelectionStore(s => s.currentPrinterId);
  const printer = useSettingsStore(s => s.selectedPrinter);
  const slicing = useSlicerStore(s => s.status === 'slicing');
  const serialBusy = slicing && platform.runtime.getRuntimeExecutionState().threaded === false;
  const revision = snapshot?.revisions.session;
  const [result, setResult] = useState<{ source: SynchronizationSource; printer: string; prepared: Options } | null>(null);
  useEffect(() => {
    if (!source || source.target.printerId !== current || revision === undefined || serialBusy) return;
    let active = true;
    void readProjectMutationReservation(() => platform.runtime.getDeviceFilamentOptions({ version: 1, revision,
      identity: source.identity, sources: materialImportSources(source) }))
      .then(prepared => { if (active) setResult(prepared.ok ? { source, printer, prepared } : null); })
      .catch(() => { if (active) setResult(null); });
    return () => { active = false; };
  }, [platform.runtime, source, current, revision, printer, serialBusy]);
  return source && source.target.printerId === current && result?.source === source && result.printer === printer
    && result.prepared.revision === revision ? result : null;
}

export async function selectDeviceFilament(platform: PlatformCapabilities, device: DeviceFilaments, slot: number, option: Options['options'][number]) {
  const checked = await validateSynchronizationSource(platform.printers.service, device.source);
  if (!checked.ok) throw new Error(checked.error.message);
  if (useDeviceSelectionStore.getState().currentPrinterId !== device.source.target.printerId)
    throw new Error('Device selection changed. Reopen the filament list.');
  const material = materialImportSources(device.source).find(s => s.slotId === option.slotId);
  if (!material) throw new Error('Device filament is unavailable. Reopen the filament list.');
  return platform.runtime.selectFilamentSlotPreset({ version: 1, revision: device.prepared.revision, slot, preset: option.preset,
    deviceSource: { identity: device.source.identity, material } });
}

export function renderDeviceFilamentMenu(device: DeviceFilaments | null, query: string, onSelect: (option: Options['options'][number]) => void) {
  if (!device) return null;
  const groups = new Map<string, Options['options'][number][]>();
  const order = new Map<string, number>();
  for (const option of device.prepared.options) {
    const material = device.source.materials.find(s => s.slotId === option.slotId)!;
    const group = device.source.tools.length > 1
      ? material.toolIndices.map(i => device.source.tools[i].name).join(' / ') : '';
    if (query && !`${option.label} ${material.label} ${group}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
    if (!groups.has(group)) { groups.set(group, []); order.set(group, material.toolIndices[0] ?? 0); }
    groups.get(group)!.push(option);
  }
  if (!groups.size) return null;
  return <DropdownMenuGroup data-testid="device-filament-options">
    <DropdownMenuLabel>Printer filaments</DropdownMenuLabel>
    {[...groups].sort(([a], [b]) => order.get(a)! - order.get(b)!).map(([group, options]) => <DropdownMenuGroup key={group}>
      {group && <DropdownMenuLabel className="text-muted-foreground">{group}</DropdownMenuLabel>}
      {options.map(option => {
        const material = device.source.materials.find(s => s.slotId === option.slotId)!;
        const color = material.metadata?.color;
        return <DropdownMenuItem key={option.slotId} onClick={() => onSelect(option)}
          title={`${material.label} · ${material.presence}`} aria-label={`${material.label}: ${option.label}`}>
          {color && (color.kind === 'solid' || color.rgba.length > 0) && <FilamentSwatch className="size-4 shrink-0 rounded-sm border" display={{
            mode: color.kind === 'solid' ? 'solid' : color.appearance === 'gradient' ? 'gradient' : 'multicolor',
            colors: color.kind === 'solid' ? [color.rgba] : [...color.rgba],
          }} />}
          <span className="flex min-w-0 flex-col"><span>{option.label}</span><span className="text-xs text-muted-foreground">{material.label}</span></span>
        </DropdownMenuItem>;
      })}
    </DropdownMenuGroup>)}
    <DropdownMenuSeparator />
  </DropdownMenuGroup>;
}
