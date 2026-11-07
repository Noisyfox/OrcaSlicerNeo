import { useSettingsStore } from '../../stores/useSettingsStore';
import { glVolumeCollection } from './viewport/GLVolume';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as volumeProjection from './viewport/GLVolume';
import { captureProjectThumbnails, captureSliceThumbnail } from './projectThumbnails';
import { projectPlateThumbnail } from './plateThumbnailScene';
import { createThumbnailRenderer } from './plateThumbnailService';
import { useObjectListStore } from './objectList/useObjectListStore';
import type { SlicerClient } from '@slicer/client';
vi.mock('./plateThumbnailService', () => ({ createThumbnailRenderer: vi.fn() }));
vi.mock('./plateThumbnailScene', () => ({ projectPlateThumbnail: vi.fn(() => ({ parts: [], key: '' })) }));
const runtime = {
  getPlateSessionSnapshot: async () => ({ ok: true, version: 1, instances: [], currentPlateId: 'p2', plates: [
    { plateId: 'p1', origin: [0, 0, 0] }, { plateId: 'p2', origin: [300, 0, 0] },
  ] }),
  getHistoryStatus: async () => ({ revision: 42 }),
} as unknown as SlicerClient;
beforeEach(() => useObjectListStore.setState({ structure: [] }));
afterEach(() => vi.restoreAllMocks());
describe('save thumbnails', () => {
  it('captures only the stamped slice plate and releases its renderer', async () => {
    const waitForGeometry = vi.spyOn(volumeProjection, 'waitForGLVolumeRevision').mockResolvedValue();
    const parts = [{}] as never;
    vi.mocked(projectPlateThumbnail).mockReturnValueOnce({ parts, key: 'current' });
    const rgba = new Uint8Array(512 * 512 * 4);
    const renderer = { renderPixels: vi.fn(() => rgba), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    glVolumeCollection.clear(1);
    useSettingsStore.setState({ modelRevision: 1 });
    const scoped = { getPlateSessionSnapshot: async () => ({ ...(await runtime.getPlateSessionSnapshot()), inputRevisions: { p1: 3, p2: 4 } }) };
    expect(await captureSliceThumbnail(scoped as never, { plateId: 'p1', inputRevision: 3 })).toEqual({ width: 512, height: 512, rgba });
    expect(vi.mocked(projectPlateThumbnail).mock.calls.at(-1)?.[0]).toBe('p1');
    expect(renderer.renderPixels).toHaveBeenCalledWith(parts, 512);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(waitForGeometry).toHaveBeenCalledWith(1);
    await expect(captureSliceThumbnail(scoped as never, { plateId: 'p1', inputRevision: 2 })).rejects.toThrow('Plate inputs changed');
  });
  it('renders every plate including empty and inactive plates, and disposes GPU state', async () => {
    const renderer = { renderPixels: vi.fn(() => new Uint8Array(512 * 512 * 4)), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    const request = await captureProjectThumbnails(runtime, 42);
    expect(request.expectedRevision).toBe(42);
    expect(request.thumbnails.map(t => t.plateId)).toEqual(['p1', 'p2']);
    expect(renderer.renderPixels).toHaveBeenCalledTimes(2);
    expect(renderer.renderPixels).toHaveBeenCalledWith([], 512);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
  it('waits for the current geometry projection before rendering', async () => {
    const renderer = { renderPixels: vi.fn(() => new Uint8Array(512 * 512 * 4)), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    useObjectListStore.setState({ structure: [{} as never] });
    const revision = glVolumeCollection.revision + 1;
    useSettingsStore.setState({ modelRevision: revision });
    const result = captureProjectThumbnails(runtime, 42);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createThumbnailRenderer).not.toHaveBeenCalled();
    glVolumeCollection.clear(revision);
    expect((await result).thumbnails).toHaveLength(2);
    expect(renderer.renderPixels).toHaveBeenCalledTimes(2);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
  it('propagates rendering failures instead of exporting stale images', async () => {
    const renderer = { renderPixels: vi.fn(() => { throw new Error('GPU unavailable'); }), dispose: vi.fn(), render: vi.fn() };
    vi.mocked(createThumbnailRenderer).mockReturnValue(renderer);
    await expect(captureProjectThumbnails(runtime, 42)).rejects.toThrow('GPU unavailable');
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
