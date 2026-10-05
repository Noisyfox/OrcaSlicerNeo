import * as THREE from 'three';
import { createPlateThumbnailScene, type PlateThumbnailPart } from './plateThumbnailScene';

export type ThumbnailRenderer = (parts: readonly PlateThumbnailPart[], size: number) => Promise<Blob>;
type Entry = { key: string; url?: string; promise: Promise<string | undefined>; };

/** One lazily created WebGL context for the entire list. */
export function createThumbnailRenderer() {
  let renderer: THREE.WebGLRenderer | undefined;
  return {
    async render(parts: readonly PlateThumbnailPart[], size: number): Promise<Blob> {
      renderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setSize(size, size, false);
      const target = new THREE.WebGLRenderTarget(size, size, { samples: Math.min(4, renderer.capabilities.maxSamples) });
      target.texture.colorSpace = THREE.SRGBColorSpace;
      const projection = createPlateThumbnailScene(parts);
      try {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.render(projection.scene, projection.camera);
        const pixels = new Uint8Array(size * size * 4);
        renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Thumbnail image encoding unavailable');
        const data = context.createImageData(size, size);
        for (let row = 0; row < size; row++) data.data.set(pixels.subarray(row * size * 4, (row + 1) * size * 4), (size - row - 1) * size * 4);
        context.putImageData(data, 0, 0);
        // Release GPU resources before asynchronous PNG encoding can outlive the owner.
        return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Thumbnail encoding failed')), 'image/png'));
      } finally {
        renderer.setRenderTarget(null);
        target.dispose();
        projection.dispose();
      }
    },
    dispose() { renderer?.dispose(); renderer?.forceContextLoss(); renderer = undefined; },
  };
}

/** Serial queue; stale encodes are never published and every owned URL is released. */
export class PlateThumbnailService {
  private entries = new Map<string, Entry>();
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(private render: ThumbnailRenderer, private urls = URL) {}
  request(plateId: string, key: string, parts: readonly PlateThumbnailPart[], size: number) {
    key = `${size}:${key}`;
    const cached = this.entries.get(plateId);
    if (cached?.key === key) return cached.promise;
    if (cached?.url) this.urls.revokeObjectURL(cached.url);
    const entry: Entry = { key, promise: Promise.resolve(undefined) };
    this.entries.set(plateId, entry);
    entry.promise = this.tail.then(async () => {
      if (this.disposed || this.entries.get(plateId) !== entry) return undefined;
      // Yield between plates so even a long visible list does not monopolize a frame.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (this.disposed || this.entries.get(plateId) !== entry) return undefined;
      const blob = await this.render(parts, size);
      if (this.disposed || this.entries.get(plateId) !== entry) return undefined;
      return entry.url = this.urls.createObjectURL(blob);
    }).catch(() => { if (this.entries.get(plateId) === entry) this.entries.delete(plateId); return undefined; });
    this.tail = entry.promise;
    return entry.promise;
  }
  retain(plateIds: readonly string[]) {
    const keep = new Set(plateIds);
    for (const [id, entry] of this.entries) if (!keep.has(id)) {
      this.remove(id);
    }
  }
  remove(plateId: string) {
    const entry = this.entries.get(plateId);
    if (entry?.url) this.urls.revokeObjectURL(entry.url);
    this.entries.delete(plateId);
  }
  dispose() { this.disposed = true; this.retain([]); }
}
