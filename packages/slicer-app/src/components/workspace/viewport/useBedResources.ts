import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useThree } from '@react-three/fiber';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { CanvasTexture, SRGBColorSpace, type BufferGeometry } from 'three';
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

export interface BedTexture { path: string; texture: CanvasTexture }

/** Rasterize the original artwork with Orca's 2048-pixel longest-edge cap. */
export async function loadBedTexture(bytes: Uint8Array, path: string): Promise<CanvasTexture> {
  const type = /\.svg$/i.test(path) ? 'image/svg+xml' : /\.png$/i.test(path) ? 'image/png' : null;
  if (!type) throw new Error('Unsupported bed texture');
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty bed texture');
    const scale = 2048 / Math.max(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Bed texture rasterization is unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const texture = new CanvasTexture(canvas);
    texture.name = path;
    texture.colorSpace = SRGBColorSpace;
    return texture;
  } finally { URL.revokeObjectURL(url); }
}

export function useBedTexture(): BedTexture | null {
  const path = useSettingsStore((state) => state.bedTexture);
  const { runtime } = usePlatform();
  const invalidate = useThree((state) => state.invalidate);
  const [loaded, setLoaded] = useState<BedTexture | null>(null);
  useEffect(() => {
    let cancelled = false;
    let owned: CanvasTexture | undefined;
    setLoaded(null);
    if (path) void runtime.readFilesystemFile(path).then(async (bytes) => {
      if (cancelled) return;
      const texture = await loadBedTexture(bytes, path);
      if (cancelled) { texture.dispose(); return; }
      owned = texture;
      setLoaded({ path, texture });
      invalidate();
    }).catch(() => {
      if (!cancelled) { setLoaded(null); invalidate(); }
    });
    return () => { cancelled = true; owned?.dispose(); };
  }, [path, runtime, invalidate]);
  return loaded?.path === path ? loaded : null;
}
