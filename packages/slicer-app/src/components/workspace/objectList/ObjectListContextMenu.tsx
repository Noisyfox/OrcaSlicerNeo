import type { ModelInstanceStructure, ModelObjectStructure, ModelVolumeStructure, VolumeType } from '@slicer/client';
import type { ReactNode } from 'react';
import { usePlatform } from '@orca/platform-contract';
import {
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { useObjectListStore } from './useObjectListStore';
import {
  addInstanceInList,
  assembleObjectsInList,
  cloneObjectsInList,
  deleteObjectsInList,
  deleteVolumeInList,
  removeInstanceInList,
  separateInstancesInList,
  splitObjectToObjectsInList,
  splitVolumeToPartsInList,
} from './structuralActions';
import { changePartTypeInList, setObjectPrintableInList, setInstancePrintableInList } from './actions';

export type ObjectListCtxTarget =
  | { kind: 'list' }
  | { kind: 'object'; object: ModelObjectStructure }
  | { kind: 'part'; object: ModelObjectStructure; volume: ModelVolumeStructure }
  | { kind: 'instance'; object: ModelObjectStructure; instance: ModelInstanceStructure };

const VOLUME_TYPES: VolumeType[] = [
  'model_part', 'negative_volume', 'parameter_modifier',
  'support_blocker', 'support_enforcer',
];

function MenuItem({ label, testid, onClick, danger, disabled }: {
  label: string;
  testid: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <ContextMenuItem
      data-testid={testid}
      variant={danger ? 'destructive' : 'default'}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </ContextMenuItem>
  );
}

export function ObjectListContextMenu({ target, onClose, onRename, showRename = true }: {
  target: ObjectListCtxTarget;
  onClose: () => void;
  onRename?: (kind: 'object' | 'part', id: number, currentName: string) => void;
  // Some surfaces (e.g. the scene object menu) have no rename editor; the
  // item is dropped entirely rather than shown and disabled.
  showRename?: boolean;
}) {
  const platform = usePlatform();
  const runtime = platform.runtime;
  const projection = useObjectListStore((s) => s.projection);
  const act = (p: Promise<{ ok: boolean; error?: string }>) => { void p; onClose(); };

  // "Assemble" merges the fully-selected objects only (never the whole list).
  const selectedObjectIds = [...projection.objectIds];
  const canAssemble = selectedObjectIds.length >= 2;
  // Rename targets the row's object/part, which is ambiguous while several
  // full objects are selected (Orca hides the rename item there too).
  const canRename = selectedObjectIds.length < 2;
  const assembleItem = canAssemble ? (
    <MenuItem key="assemble" label="Assemble" testid="objectlist-assemble"
      onClick={() => act(assembleObjectsInList(runtime, selectedObjectIds))} />
  ) : null;

  const items: ReactNode[] = [];
  if (target.kind === 'list') {
    if (assembleItem) items.push(assembleItem);
  } else if (target.kind === 'object') {
    const o = target.object;
    // The object menu is selection-based: Delete/Clone/printable act on the
    // whole selection — the object menu is only shown for an object that is
    // part of the selection (either the right-click just selected it, or it
    // was already selected). Fall back to the row's object alone when the
    // selection is highlighted at instance level and holds no full object
    // (projection.objectIds empty, e.g. selected via the Instances group).
    const targetObjectIds = selectedObjectIds.includes(o.id) ? selectedObjectIds : [o.id];
    if (assembleItem) items.push(assembleItem);
    if (showRename && canRename) {
      items.push(
        <MenuItem key="rename" label="Rename" testid="objectlist-rename"
          onClick={() => {
            onRename?.('object', o.id, o.name);
            onClose();
          }} />,
      );
    }
    // Printable applies to the whole selection (right-click a selected
    // member to toggle everything).
    items.push(
      <MenuItem key="printable" label={o.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setObjectPrintableInList(runtime, targetObjectIds, !o.printable))} />,
      <MenuItem key="clone" label="Clone" testid="objectlist-clone"
        onClick={() => act(cloneObjectsInList(runtime, targetObjectIds))} />,
    );
    // Orca shows Split to objects only when the object is splittable (multiple
    // volumes, or a volume with disconnected shells).
    if (o.volumes.length > 1 || o.volumes.some((vol) => vol.isSplittable)) {
      items.push(
        <MenuItem key="split" label="Split to objects" testid="objectlist-split-objects"
          onClick={() => act(splitObjectToObjectsInList(runtime, o.id))} />,
      );
    }
    items.push(
      <MenuItem key="add-instance" label="Add instance" testid="objectlist-add-instance"
        onClick={() => act(addInstanceInList(runtime, o.id))} />,
      // Remove the last instance; an object must keep at least one instance.
      <MenuItem key="remove-instance" label="Remove instance" testid="objectlist-remove-instance"
        disabled={o.instanceCount <= 1}
        onClick={() => {
          const last = o.instances[o.instances.length - 1];
          if (last) void act(removeInstanceInList(runtime, o.id, last.id));
        }} />,
      <MenuItem key="delete" label="Delete" testid="objectlist-delete" danger
        onClick={() => act(deleteObjectsInList(runtime, targetObjectIds))} />,
    );
  } else if (target.kind === 'part') {
    const { volume: v } = target;
    if (showRename && canRename) {
      items.push(
        <MenuItem key="rename" label="Rename" testid="objectlist-rename"
          onClick={() => {
            onRename?.('part', v.id, v.name);
            onClose();
          }} />,
      );
    }
    // Orca shows Split to parts only for a volume with disconnected shells.
    if (v.isSplittable) {
      items.push(
        <MenuItem key="split" label="Split to parts" testid="objectlist-split-parts"
          onClick={() => act(splitVolumeToPartsInList(runtime, v.id))} />,
      );
    }
    items.push(
      <MenuItem key="delete" label="Delete part" testid="objectlist-delete" danger
        onClick={() => act(deleteVolumeInList(runtime, v.id))} />,
      ...VOLUME_TYPES.filter((t) => t !== v.type).map((t) => (
        <MenuItem key={`type-${t}`} label={`Change type to ${t}`} testid={`objectlist-type-${t}`}
          onClick={() => act(changePartTypeInList(runtime, v.id, t))} />
      )),
    );
  } else if (target.kind === 'instance') {
    const inst = target.instance;
    const selectedInstanceIds = [...projection.instanceIds];
    // "Set as an individual object" is selection-based like the other items: it
    // promotes the clicked object's selected instances (instances of other
    // objects in a cross-object selection are left alone).
    const objectInstanceIds = selectedInstanceIds.filter((id) =>
      target.object.instances.some((i) => i.id === id));
    // OrcaSlicer calls this "Set as an individual object": it promotes the
    // selected instance(s) into their own top-level object(s). Only
    // meaningful (and only possible — the Instances group is hidden for
    // single-instance objects) when the object has more than one instance.
    if (target.object.instanceCount > 1) {
      items.push(
        <MenuItem key="individual" label="Set as an individual object" testid="objectlist-separate"
          onClick={() => act(separateInstancesInList(runtime, target.object.id,
            objectInstanceIds.length > 0 ? objectInstanceIds : [inst.id]))} />,
      );
    }
    // Same selection rule as the object row: toggle all selected instances
    // when the clicked instance is part of the selection.
    items.push(
      <MenuItem key="printable" label={inst.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setInstancePrintableInList(runtime,
          selectedInstanceIds.includes(inst.id) ? selectedInstanceIds : [inst.id], !inst.printable))} />,
    );
  }

  // Nothing to offer (e.g. empty-space right-click without a multi-object
  // selection) — do not pop up an empty menu.
  if (items.length === 0) return null;

  return (
    <ContextMenuContent data-testid="objectlist-ctx-menu" className="min-w-40">
      {items}
    </ContextMenuContent>
  );
}
