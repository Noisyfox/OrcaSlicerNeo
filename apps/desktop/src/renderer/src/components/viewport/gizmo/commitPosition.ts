// apps/desktop/src/renderer/src/components/viewport/gizmo/commitPosition.ts
import type { Vec3 } from '../../../lib/vec3';
import { useSettingsStore } from '../../../stores/useSettingsStore';

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
  client: OffsetClient,
  objectIdx: number,
  pos: Vec3,
  revertPos: Vec3,
  onError: (msg: string) => void,
): Promise<boolean> {
  const res = await client.setInstanceOffset(objectIdx, 0, pos[0], pos[1], pos[2]);
  if (res.ok) {
    useSettingsStore.getState().setObjectOffset(objectIdx, pos);
    return true;
  }
  useSettingsStore.getState().setObjectOffset(objectIdx, revertPos);
  onError(res.error ?? 'setInstanceOffset failed');
  return false;
}
