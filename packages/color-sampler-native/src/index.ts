/** Electron main only. A missing addon is a local availability failure, not a portal probe. */
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

export type NativeScreenColorResult = { status: 'picked'; color: string } | { status: 'cancelled' } | { status: 'failed' };
export interface NativeScreenColorBinding {
  apiVersion: number;
  available: boolean;
  start(requestId: number, callback: (result: unknown) => void): boolean;
  cancel(requestId: number): void;
}
export interface NativeScreenColorSampler {
  available: boolean;
  pick(signal: AbortSignal): Promise<NativeScreenColorResult>;
  close(): void;
}

/** Binding injection also exercises late callbacks and cancellation without opening native UI. */
export function createNativeScreenColorSampler(binding: NativeScreenColorBinding): NativeScreenColorSampler {
  if (binding.apiVersion !== 1 || typeof binding.available !== 'boolean'
    || typeof binding.start !== 'function' || typeof binding.cancel !== 'function') throw new Error('Invalid screen color addon');
  let sequence = 0;
  let active: (() => void) | null = null;
  let closed = false;
  return {
    available: binding.available,
    pick(signal) {
      if (signal.aborted || closed) return Promise.resolve({ status: 'cancelled' });
      if (!binding.available || active) return Promise.resolve({ status: 'failed' });
      const id = sequence = sequence % 0xFFFFFFFF + 1;
      return new Promise(resolve => {
        let finished = false;
        const finish = (value: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', abort);
          active = null;
          if (signal.aborted) { resolve({ status: 'cancelled' }); return; }
          if (value && typeof value === 'object' && 'status' in value) {
            if (value.status === 'cancelled') { resolve({ status: 'cancelled' }); return; }
            if (value.status === 'picked' && 'color' in value && typeof value.color === 'string' && /^#[\da-f]{6}$/i.test(value.color)) {
              resolve({ status: 'picked', color: value.color.toUpperCase() }); return;
            }
          }
          resolve({ status: 'failed' });
        };
        const abort = () => {
          try { binding.cancel(id); } catch { /* Cancellation still invalidates the result. */ } finally { finish({ status: 'cancelled' }); }
        };
        active = abort;
        signal.addEventListener('abort', abort, { once: true });
        try { if (!binding.start(id, finish)) finish({ status: 'failed' }); }
        catch { finish({ status: 'failed' }); }
      });
    },
    close() { closed = true; active?.(); },
  };
}

export function loadNativeScreenColorSampler(path: string): NativeScreenColorSampler | null {
  if (!isAbsolute(path)) return null;
  try {
    const binding = createRequire(path)(path) as NativeScreenColorBinding;
    return createNativeScreenColorSampler(binding);
  } catch { return null; }
}
