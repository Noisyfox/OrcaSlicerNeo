import { useMemo } from 'react';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';
import { lastMovePosition } from './previewSemantics';

/** Lightweight camera-facing current-move marker for Phase B. */
export function ToolpathMarker({ data }: { data: ToolpathGeometry }) {
  const { visibleLayerEnd, activeMoveEnd } = useSlicerStore((s) => s.preview);
  const position = useMemo(
    () => lastMovePosition(data, visibleLayerEnd, activeMoveEnd),
    [activeMoveEnd, data, visibleLayerEnd],
  );
  if (!position) return null;
  return (
    <sprite name="preview-nozzle-marker" position={position} scale={[7, 7, 7]} renderOrder={1100}>
      <spriteMaterial color="#f59e0b" transparent opacity={0.95} depthTest={false} depthWrite={false} />
    </sprite>
  );
}
