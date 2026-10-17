import { beforeEach, expect, it, vi } from 'vitest';
import { createThumbnailRenderer } from './plateThumbnailService';
import { createPlateThumbnailScene } from './plateThumbnailScene';
const state = vi.hoisted(() => ({ lost: false, loseOnRead: false, targetDispose: vi.fn(), sceneDispose: vi.fn() }));
vi.mock('./plateThumbnailScene', () => ({ createPlateThumbnailScene: vi.fn() }));
vi.mock('three', () => ({
  SRGBColorSpace: 'srgb',
  WebGLRenderer: class {
    capabilities = { maxSamples: 4 };
    getContext() { return { isContextLost: () => state.lost }; }
    setSize() {} setRenderTarget() {} setClearColor() {} render() {} dispose() {} forceContextLoss() {}
    readRenderTargetPixels(_target: unknown, _x: number, _y: number, _w: number, _h: number, pixels: Uint8Array) {
      pixels.fill(42); if (state.loseOnRead) state.lost = true;
    }
  },
  WebGLRenderTarget: class { texture = {}; dispose = state.targetDispose; },
}));
beforeEach(() => {
  state.lost = state.loseOnRead = false;
  vi.mocked(createPlateThumbnailScene).mockReturnValue({ scene: {} as never, camera: {} as never, dispose: state.sceneDispose });
});
it('returns pixels and releases per-image resources', () => {
  const renderer = createThumbnailRenderer();
  expect(renderer.renderPixels([], 2)).toEqual(new Uint8Array(16).fill(42));
  expect(state.targetDispose).toHaveBeenCalledOnce(); expect(state.sceneDispose).toHaveBeenCalledOnce();
  renderer.dispose();
});
it.each(['before', 'read'])('rejects context loss %s instead of saving a blank image', stage => {
  state.lost = stage === 'before'; state.loseOnRead = stage === 'read';
  const renderer = createThumbnailRenderer();
  expect(() => renderer.renderPixels([], 2)).toThrow('graphics context was lost');
  expect(state.targetDispose).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
  renderer.dispose();
});
it('releases the target when scene construction fails', () => {
  vi.mocked(createPlateThumbnailScene).mockImplementationOnce(() => { throw new Error('scene failed'); });
  const renderer = createThumbnailRenderer();
  expect(() => renderer.renderPixels([], 2)).toThrow('scene failed');
  expect(state.targetDispose).toHaveBeenCalledOnce();
  renderer.dispose();
});
