import { useLayoutEffect } from 'react';
import type { Box3 } from 'three';
import { registerOrcaE2eOwner } from './registerOrcaE2e';

interface SelectionBoundsBoxProbeProps {
  bounds: Box3 | null;
  positions: Float32Array | null;
}

export function SelectionBoundsBoxProbe({ bounds, positions }: SelectionBoundsBoxProbeProps) {
  useLayoutEffect(() => registerOrcaE2eOwner('selection-bounds-box', {
    selectionBoxWorldSegments: () => {
      if (!bounds || !positions) return null;
      return {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
        segmentCount: positions.length / 6,
      };
    },
  }), [bounds, positions]);

  return null;
}
