// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts
import type { Vec3 } from '../../../lib/vec3';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { glVolumeCollection } from '../GLVolume';

/** The bridge client surface commitPosition needs (slicerClient satisfies it). */
export interface OffsetClient {
  setInstanceOffset(
    objIdx: number,
    instIdx: number,
    x: number,
    y: number,
    z: number,
  ): Promise<{ ok: boolean; error?: string }>;
}

/** Commit a world offset for `objectIdx` (instance 0) through the bridge.
 *  Store updates are live during drags, so on failure the store is reset to
 *  `revertPos` (the drag-start position) before the error is reported.
 *  Returns success; on false the gizmo caller must also revert its group
 *  position. */
export async function commitPosition(
  _client: OffsetClient,
  objectIdx: number,
  instanceIdx: number,
  pos: Vec3,
  revertPos: Vec3,
  onError: (msg: string) => void,
): Promise<boolean> {
  // Local UI state only. Toolbar synchronizes the GLVolume collection before
  // slicing, mirroring the native canvas' apply-to-Model boundary.
  const volumes = glVolumeCollection.volumes.filter((v) =>
    v.buffer.objectIdx === objectIdx && v.buffer.instanceIdx === instanceIdx,
  );
  if (!volumes.length) {
    useSettingsStore.getState().setObjectOffset(objectIdx, revertPos);
    onError('selected ModelInstance no longer exists');
    return false;
  }
  volumes.forEach((v) => v.setInstanceOffset(pos));
  useSettingsStore.getState().setObjectOffset(objectIdx, pos);
  return true;
}
