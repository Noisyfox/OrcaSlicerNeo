import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { usePlatform } from '@orca/platform-contract';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { TooltipFor } from '@/components/ui/tooltip';
import { assignmentForRow, assignmentSlotOptions } from './filamentAssignment';
import type { FilamentSessionSnapshot, FilamentAssignmentTargetRequest } from '@slicer/client';

export function FilamentAssignmentCell({ snapshot, kind, id, assignable = true, allowDefault = false, pending = false, onAssign }: {
  snapshot: FilamentSessionSnapshot | null;
  kind: 'object' | 'part';
  id: number;
  assignable?: boolean;
  allowDefault?: boolean;
  pending?: boolean;
  onAssign?: (slot: number) => void;
}) {
  const assignment = assignmentForRow(snapshot, kind, id);
  if (!snapshot || !assignable || !assignment) return <span className="w-10 shrink-0 text-center text-xs text-muted-foreground" data-testid={`filament-cell-${kind}-${id}`}>—</span>;
  const colour = snapshot.slots.find((slot) => slot.slot === assignment.effectiveSlot)?.colour.effective;
  const rgb = colour?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i);
  const lightColour = rgb && (Number.parseInt(rgb[1], 16) * 0.299 + Number.parseInt(rgb[2], 16) * 0.587 + Number.parseInt(rgb[3], 16) * 0.114) > 150;
  const label = assignment.effectiveSlot > 0 ? `Slot ${assignment.effectiveSlot}${assignment.inherited ? ' · inherited' : ''}` : 'Default';
  const items = [
    ...(allowDefault ? [{ value: '0', label: 'Default' }] : []),
    ...assignmentSlotOptions(snapshot).map((slot) => ({
      value: String(slot),
      label: `Slot ${slot}${assignment.inherited && slot === assignment.effectiveSlot ? ' · inherited' : ''}`,
    })),
  ];
  return (
    <Select
      value={String(allowDefault ? assignment.effectiveSlot : Math.max(1, assignment.effectiveSlot))}
      items={items}
      onValueChange={(value) => value != null && onAssign?.(Number(value))}
      disabled={pending}
    >
      <TooltipFor content={label}>
        <SelectTrigger
          hideIndicator
          aria-label={`${kind === 'object' ? 'Object' : 'Part'} ${id} filament`}
          data-testid={`filament-cell-${kind}-${id}`}
          className="h-5 w-10 shrink-0 justify-center rounded-[1px] border border-input-button-foreground/40 px-0 py-0 text-xs leading-none"
          style={{ height: 20, backgroundColor: colour ?? 'var(--color-control-background)', color: lightColour ? 'var(--color-control-background)' : 'var(--color-foreground)' }}
          size="sm"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {assignment.effectiveSlot > 0 ? assignment.effectiveSlot : '—'}
        </SelectTrigger>
      </TooltipFor>
      <SelectContent
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <SelectGroup>
          {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function useFilamentAssignmentAction() {
  const platform = usePlatform();
  const run = useFilamentSessionStore((state) => state.run);
  return (slot: number, targets: readonly FilamentAssignmentTargetRequest[]) => {
    if (targets.length === 0) return Promise.resolve(null);
    return run(platform.runtime, () => {
      const current = useFilamentSessionStore.getState().snapshot;
      if (!current) return Promise.resolve({ ok: false as const, version: 1 as const, error: 'filament session unavailable', errorCode: 'runtime_unavailable' as const });
      return platform.runtime.assignFilament({ version: 1, revision: current.revisions.session, slot, targets });
    });
  };
}
