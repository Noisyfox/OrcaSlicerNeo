import { describe, expect, it, vi } from 'vitest';
import { HIGH_PERFORMANCE_GPU_SWITCH, preferHighPerformanceGpu } from './gpuPreference';

describe('preferHighPerformanceGpu', () => {
  it('uses Electron’s supported preference switch without selecting a specific adapter', () => {
    const appendSwitch = vi.fn();

    preferHighPerformanceGpu({ appendSwitch });

    expect(appendSwitch).toHaveBeenCalledOnce();
    expect(appendSwitch).toHaveBeenCalledWith(HIGH_PERFORMANCE_GPU_SWITCH);
    expect(HIGH_PERFORMANCE_GPU_SWITCH).toBe('force_high_performance_gpu');
  });
});
