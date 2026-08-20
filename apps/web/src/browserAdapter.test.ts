import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserAdapter, downloadGcode } from './browserAdapter';

describe('browser adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('uses a file input for model selection', async () => {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [{ name: 'cube.stl', arrayBuffer: async () => new Uint8Array([1, 2]).buffer }] });
    const click = vi.spyOn(input, 'click').mockImplementation(() => input.dispatchEvent(new Event('change')));
    vi.spyOn(document, 'createElement').mockReturnValue(input);
    const result = await createBrowserAdapter({} as never).models.pick();
    expect(click).toHaveBeenCalled();
    expect(result?.displayName).toBe('cube.stl');
    expect([...result!.bytes]).toEqual([1, 2]);
  });

  it('downloads gcode through a Blob URL', async () => {
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await downloadGcode('cube', new Uint8Array([71, 49]));
    expect(anchor.download).toBe('cube.gcode');
    expect(anchor.href).toContain('blob:test');
    expect(click).toHaveBeenCalled();
  });
});
