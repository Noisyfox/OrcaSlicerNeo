import type { NativeScreenColorSampler } from '@orca/color-sampler-native';

/** Called only by the bundler-gated E2E branch; absent from production artifacts. */
export function createScreenColorFixture(mode: string): NativeScreenColorSampler {
  const state = globalThis as typeof globalThis & { __orcaScreenColorFixtureCalls?: number };
  state.__orcaScreenColorFixtureCalls = 0;
  return {
    available: mode !== 'unavailable',
    async pick(signal) {
      state.__orcaScreenColorFixtureCalls!++;
      if (signal.aborted) return { status: 'cancelled' };
      if (mode === 'picked') return { status: 'picked', color: '#12ABEF' };
      if (mode === 'cancelled') return { status: 'cancelled' };
      if (mode === 'pending') return new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
      return { status: 'failed' };
    },
    close() {},
  };
}
