import { describe, expect, it, vi } from 'vitest';
import { startWebApp } from './startup';

const base = (overrides: Partial<Parameters<typeof startWebApp>[0]> = {}) => ({
  detect: () => ({ webgl2: true, wasm64: true }),
  isolated: true,
  loadRuntime: vi.fn(async () => ({ slicerClient: {} })),
  render: vi.fn(), unsupported: vi.fn(), failed: vi.fn(), ...overrides,
});

describe('Web capability gate', () => {
  it('does not import or start runtime without WebGL2', async () => {
    const deps = base({ detect: () => ({ webgl2: false, wasm64: true }) });
    await startWebApp(deps);
    expect(deps.loadRuntime).not.toHaveBeenCalled();
    expect(deps.unsupported).toHaveBeenCalledOnce();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it('does not import or start runtime without wasm64', async () => {
    const deps = base({ detect: () => ({ webgl2: true, wasm64: false }) });
    await startWebApp(deps);
    expect(deps.loadRuntime).not.toHaveBeenCalled();
    expect(deps.unsupported).toHaveBeenCalledOnce();
  });

  it('starts through the browser runtime and exposes serial fallback', async () => {
    const deps = base({ isolated: false });
    await startWebApp(deps);
    expect(deps.loadRuntime).toHaveBeenCalledOnce();
    expect(deps.render).toHaveBeenCalledWith({ slicerClient: {} }, { serialFallback: true });
  });
});
