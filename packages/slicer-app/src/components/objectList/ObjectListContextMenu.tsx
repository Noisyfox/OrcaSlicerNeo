import type { ModelInstanceStructure, ModelObjectStructure, ModelVolumeStructure, VolumeType } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
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
  label: string; testid: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-xs/relaxed select-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground ${
        danger ? 'text-destructive hover:text-destructive' : ''
      } disabled:pointer-events-none disabled:opacity-50`}
    >
      {label}
    </button>
  );
}

export function ObjectListContextMenu({ target, point, onClose, onRename }: {
  target: ObjectListCtxTarget;
  point: { x: number; y: number };
  onClose: () => void;
  onRename: (kind: 'object' | 'part', id: number, currentName: string) => void;
}) {
  const platform = usePlatform();
  const runtime = platform.runtime;
  const projection = useObjectListStore((s) => s.projection);
  const act = (p: Promise<{ ok: boolean; error?: string }>) => { void p; onClose(); };

  // "Assemble" merges the fully-selected objects only (never the whole list).
  const selectedObjectIds = [...projection.objectIds];
  const canAssemble = selectedObjectIds.length >= 2;
  const assembleItem = canAssemble ? (
    <MenuItem key="assemble" label="Assemble" testid="objectlist-assemble"
      onClick={() => act(assembleObjectsInList(runtime, selectedObjectIds))} />
  ) : null;

  let items: ReturnType<typeof MenuItem>[] = [];
  if (target.kind === 'list') {
    items = assembleItem ? [assembleItem] : [];
  } else if (target.kind === 'object') {
    const o = target.object;
    items = [
      ...(assembleItem ? [assembleItem] : []),
      <MenuItem key="rename" label="Rename" testid="objectlist-rename"
        onClick={() => { onRename('object', o.id, o.name); onClose(); }} />,
      <MenuItem key="printable" label={o.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setObjectPrintableInList(runtime, o.id, !o.printable))} />,
      <MenuItem key="clone" label="Clone" testid="objectlist-clone"
        onClick={() => act(cloneObjectsInList(runtime, [o.id]))} />,
      // Orca shows Split to objects only when the object is splittable (multiple
      // volumes, or a volume with disconnected shells).
      ...(o.volumes.length > 1 || o.volumes.some((vol) => vol.isSplittable) ? [(
        <MenuItem key="split" label="Split to objects" testid="objectlist-split-objects"
          onClick={() => act(splitObjectToObjectsInList(runtime, o.id))} />
      )] : []),
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
        onClick={() => act(deleteObjectsInList(runtime, [o.id]))} />,
    ];
  } else if (target.kind === 'part') {
    const { object: o, volume: v } = target;
    items = [
      <MenuItem key="rename" label="Rename" testid="objectlist-rename"
        onClick={() => { onRename('part', v.id, v.name); onClose(); }} />,
      // Orca shows Split to parts only for a volume with disconnected shells.
      ...(v.isSplittable ? [(
        <MenuItem key="split" label="Split to parts" testid="objectlist-split-parts"
          onClick={() => act(splitVolumeToPartsInList(runtime, v.id))} />
      )] : []),
      <MenuItem key="delete" label="Delete part" testid="objectlist-delete" danger
        onClick={() => act(deleteVolumeInList(runtime, v.id))} />,
      ...VOLUME_TYPES.filter((t) => t !== v.type).map((t) => (
        <MenuItem key={`type-${t}`} label={`Change type to ${t}`} testid={`objectlist-type-${t}`}
          onClick={() => act(changePartTypeInList(runtime, v.id, t))} />
      )),
    ];
  } else if (target.kind === 'instance') {
    const inst = target.instance;
    items = [
      // OrcaSlicer calls this "Set as an individual object": it promotes the
      // right-clicked instance into its own top-level object. Only meaningful
      // (and only possible — the Instances group is hidden for single-instance
      // objects) when the object has more than one instance.
      ...(target.object.instanceCount > 1 ? [(
        <MenuItem key="individual" label="Set as an individual object" testid="objectlist-separate"
          onClick={() => act(separateInstancesInList(runtime, target.object.id, [inst.id]))} />
      )] : []),
      <MenuItem key="printable" label={inst.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setInstancePrintableInList(runtime, inst.id, !inst.printable))} />,
    ];
  }

  // Nothing to offer (e.g. empty-space right-click without a multi-object
  // selection) — do not pop up an empty menu.
  if (items.length === 0) return null;

  return (
    <div role="menu" data-testid="objectlist-ctx-menu"
      className="pointer-events-auto fixed z-50 min-w-40 rounded-md border bg-card p-1 shadow-md"
      style={{ left: point.x, top: point.y }}>
      {items}
    </div>
  );
}
