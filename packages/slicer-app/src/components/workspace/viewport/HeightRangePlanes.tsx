import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { sameBounds, useObjectListStore } from '../objectList/useObjectListStore';
import type { GLVolume } from './GLVolume';
import { useSettingsStore } from '@/stores/useSettingsStore';

export function HeightRangePlanes({ volumes }: { volumes: readonly GLVolume[] }) {
  const selection = useObjectListStore(s => s.heightRangeSelection);
  const focus = useObjectListStore(s => s.heightRangeFocus);
  const structure = useObjectListStore(s => s.structure);
  const scoped = useSettingsStore(s => s.configurationMode === 'scoped');
  const invalidate = useThree(s => s.invalidate);
  const group = useRef<THREE.Group>(null);
  const bounds = useMemo(() => new THREE.Box3(), []);
  const object = structure.find(o => o.id === selection?.objectId);
  const selected = selection?.bounds === 'all' ? focus : selection?.bounds.length === 1 ? selection.bounds[0] : null;
  const row = selected && object?.heightRanges?.find(r => sameBounds(r, selected));
  const parts = useMemo(() => {
    if (!object || !row) return [];
    const solids = new Set(object.volumes.filter(v => v.type === 'model_part').map(v => v.id));
    const instance = selection?.instanceId ?? object.instances[0]?.id;
    return volumes.filter(v => v.buffer.objectId === object.id && v.buffer.instanceId === instance && solids.has(v.buffer.volumeId));
  }, [object, selection?.instanceId, volumes, row]);
  const visible = scoped && !!row && parts.length > 0;
  useLayoutEffect(() => {
    // Returning to the owning object can keep the same selected meshes. The
    // demand-rendered canvas still needs a frame when the planes leave it.
    if (visible) return () => invalidate();
  }, [visible, invalidate]);
  useFrame(() => {
    if (!group.current) return;
    bounds.makeEmpty();
    for (const part of parts) bounds.union(part.getWorldBounds());
    group.current.visible = !bounds.isEmpty();
    if (!group.current.visible) return;
    group.current.position.set((bounds.max.x + bounds.min.x) / 2, (bounds.max.y + bounds.min.y) / 2, bounds.min.z);
    group.current.scale.set(bounds.max.x - bounds.min.x + 2, bounds.max.y - bounds.min.y + 2, 1);
  });
  if (!visible) return null;
  return <group ref={group} name="height-range-planes">
    {(['min', 'max'] as const).map(name => <mesh key={name} name={`height-range-${name}`} position-z={row[name]}
      renderOrder={40} raycast={() => undefined}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial transparent opacity={focus?.endpoint === name ? 0.5 : 0.2} color={focus?.endpoint === name ? '#f6a32c' : '#44bfc4'}
        depthWrite={false} side={THREE.DoubleSide} />
    </mesh>)}
  </group>;
}
