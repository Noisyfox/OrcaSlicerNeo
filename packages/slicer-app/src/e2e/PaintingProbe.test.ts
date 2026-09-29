import { describe, expect, it } from 'vitest';
import { paintingUploadBytes } from './PaintingProbe';

describe('painting WebGL upload accounting', () => {
  it('counts bufferData allocations and typed-array slices', () => {
    expect(paintingUploadBytes('bufferData', [0, 128, 0])).toBe(128);
    expect(paintingUploadBytes('bufferData', [0, new Uint32Array(16), 0, 4, 6])).toBe(24);
    expect(paintingUploadBytes('bufferData', [0, new Uint32Array(16), 0, 4])).toBe(48);
  });

  it('uses the third argument for bufferSubData payloads', () => {
    expect(paintingUploadBytes('bufferSubData', [0, 64, new Float32Array(10)])).toBe(40);
    expect(paintingUploadBytes('bufferSubData', [0, 64, new Float32Array(10), 2, 3])).toBe(12);
  });
});
