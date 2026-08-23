import type { ModelInstanceStructure, ModelObjectStructure, ModelVolumeStructure, VolumeType } from '@slicer/client';
import { usePlatform } from '@orca/platform-contract';
import { useObjectListStore } from './useObjectListStore';
import {
  assembleObjectsInList,
  cloneObjectsInList,
  deleteObjectsInList,
  deleteVolumeInList,
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

function MenuItem({ label, testid, onClick, danger }: {
  label: string; testid: string; onClick: () => void; danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      onClick={onClick}
      className={`flex h-7 w-full cursor-default items-center gap-2 rounded-sm px-2 text-left text-xs/relaxed select-none outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground ${
        danger ? 'text-destructive hover:text-destructive' : ''
      }`}
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
  const structure = useObjectListStore((s) => s.structure);
  const act = (p: Promise<{ ok: boolean; error?: string }>) => { void p; onClose(); };

  let items: ReturnType<typeof MenuItem>[] = [];
  if (target.kind === 'list') {
    items = [
      <MenuItem key="assemble" label="Assemble all" testid="objectlist-assemble"
        onClick={() => act(assembleObjectsInList(runtime, structure.map((o) => o.id)))} />,
    ];
  } else if (target.kind === 'object') {
    const o = target.object;
    items = [
      <MenuItem key="assemble" label="Assemble all" testid="objectlist-assemble"
        onClick={() => act(assembleObjectsInList(runtime, structure.map((id) => id.id)))} />,
      <MenuItem key="rename" label="Rename" testid="objectlist-rename"
        onClick={() => { onRename('object', o.id, o.name); onClose(); }} />,
      <MenuItem key="printable" label={o.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setObjectPrintableInList(runtime, o.id, !o.printable))} />,
      <MenuItem key="clone" label="Clone" testid="objectlist-clone"
        onClick={() => act(cloneObjectsInList(runtime, [o.id]))} />,
      <MenuItem key="split" label="Split to objects" testid="objectlist-split-objects"
        onClick={() => act(splitObjectToObjectsInList(runtime, o.id))} />,
      <MenuItem key="separate" label="Separate instances" testid="objectlist-separate"
        onClick={() => act(separateInstancesInList(runtime, o.id, o.instances.map((i) => i.id)))} />,
      <MenuItem key="delete" label="Delete" testid="objectlist-delete" danger
        onClick={() => act(deleteObjectsInList(runtime, [o.id]))} />,
    ];
  } else if (target.kind === 'part') {
    const { object: o, volume: v } = target;
    items = [
      <MenuItem key="rename" label="Rename" testid="objectlist-rename"
        onClick={() => { onRename('part', v.id, v.name); onClose(); }} />,
      <MenuItem key="split" label="Split to parts" testid="objectlist-split-parts"
        onClick={() => act(splitVolumeToPartsInList(runtime, v.id))} />,
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
      <MenuItem key="printable" label={inst.printable ? 'Mark unprintable' : 'Mark printable'} testid="objectlist-printable"
        onClick={() => act(setInstancePrintableInList(runtime, inst.id, !inst.printable))} />,
    ];
  }

  return (
    <div role="menu" data-testid="objectlist-ctx-menu"
      className="pointer-events-auto fixed z-50 min-w-40 rounded-md border bg-card p-1 shadow-md"
      style={{ left: point.x, top: point.y }}>
      {items}
    </div>
  );
}
