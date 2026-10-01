import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useThree } from '@react-three/fiber';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { BufferGeometry } from 'three';
import { useSettingsStore } from '@/stores/useSettingsStore';

export interface BedModel {
  path: string;
  geometry: BufferGeometry;
}

/** One geometry per scene, shared by all plates and released on replacement. */
export function useBedModel(): BedModel | null {
  const path = useSettingsStore((state) => state.bedModel);
  const { runtime } = usePlatform();
  const invalidate = useThree((state) => state.invalidate);
  const [model, setModel] = useState<BedModel | null>(null);
  useEffect(() => {
    let cancelled = false;
    let geometry: BufferGeometry | undefined;
    setModel(null);
    if (path) void runtime.readFilesystemFile(path).then((bytes) => {
      if (cancelled) return;
      const parsed = new STLLoader().parse(bytes.slice().buffer as ArrayBuffer);
      const positions = parsed.getAttribute('position');
      if (!positions || positions.count < 3 || !positions.array.every(Number.isFinite)) {
        parsed.dispose();
        throw new Error('Invalid bed STL');
      }
      geometry = parsed;
      setModel({ path, geometry: parsed });
      invalidate();
    }).catch(() => {
      // Missing/corrupt optional resources retain the generic printable bed.
      if (!cancelled) { setModel(null); invalidate(); }
    });
    return () => { cancelled = true; geometry?.dispose(); };
  }, [path, runtime, invalidate]);
  // Hide the old model immediately, even before the replacement effect runs.
  return model?.path === path ? model : null;
}
