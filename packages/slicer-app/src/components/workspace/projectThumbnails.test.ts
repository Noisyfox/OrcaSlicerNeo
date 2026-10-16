import { useSettingsStore } from '../../stores/useSettingsStore';
import { glVolumeCollection } from './viewport/GLVolume';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureProjectThumbnails } from './projectThumbnails';
import { createThumbnailRenderer } from './plateThumbnailService';
import { useObjectListStore } from './objectList/useObjectListStore';
import type { SlicerClient } from '@slicer/client';
vi.mock('./plateThumbnailService', () => ({ createThumbnailRenderer: vi.fn() }));
const runtime = {
  getPlateSessionSnapshot: async () => ({ ok: true, version: 1, instances: [], currentPlateId: 'p2', plates: [
    { plateId: 'p1', origin: [0, 0, 0] }, { plateId: 'p2', origin: [300, 0, 0] },
  ] }),
  getHistoryStatus: async () => ({ revision: 42 }),
} as unknown as SlicerClient;
beforeEach(() => useObjectListStore.setState({ structure: [] }));
describe('save thumbnails', () => {
  it('renders every plate including empty and inactive plates, and disposes GPU state', async () => {
    const renderer = { renderPixels: vi.fn(() => new Uint8Array(512 * 512 * 4)), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    const request = await captureProjectThumbnails(runtime, new AbortController().signal, 42);
    expect(request.expectedRevision).toBe(42);
    expect(request.thumbnails.map(t => t.plateId)).toEqual(['p1', 'p2']);
    expect(renderer.renderPixels).toHaveBeenCalledTimes(2);
    expect(renderer.renderPixels).toHaveBeenCalledWith([], 512);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
  it('cancels between plates and disposes the renderer', async () => {
    const controller = new AbortController();
    const renderer = { renderPixels: vi.fn(() => { controller.abort(); return new Uint8Array(4); }), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    await expect(captureProjectThumbnails(runtime, controller.signal, 42)).rejects.toThrow();
    expect(renderer.renderPixels).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
  it('can cancel while waiting for the current geometry projection', async () => {
    useObjectListStore.setState({ structure: [{} as never] });
    useSettingsStore.setState({ modelRevision: glVolumeCollection.revision + 1 });
    const controller = new AbortController();
    const result = captureProjectThumbnails(runtime, controller.signal, 42);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(createThumbnailRenderer).not.toHaveBeenCalled();
  });
  it('propagates rendering failures instead of exporting stale images', async () => {
    const renderer = { renderPixels: vi.fn(() => { throw new Error('GPU unavailable'); }), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    await expect(captureProjectThumbnails(runtime, new AbortController().signal, 42)).rejects.toThrow('GPU unavailable');
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
