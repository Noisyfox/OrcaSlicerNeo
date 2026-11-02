/** Screen sampling only returns opaque sRGB; the editor owns alpha and drafts. */
export type ScreenColorResult =
  | { status: 'picked'; color: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

export interface ScreenColorSampler {
  pick(signal: AbortSignal): Promise<ScreenColorResult>;
}

export interface ScreenColorSources {
  native: ScreenColorSampler | null;
  browser: ScreenColorSampler | null;
}

export const NO_SCREEN_COLOR: ScreenColorSources = { native: null, browser: null };

export function normalizeScreenColorResult(value: unknown): ScreenColorResult {
  if (value && typeof value === 'object' && 'status' in value) {
    if (value.status === 'cancelled') return { status: 'cancelled' };
    if (value.status === 'picked' && 'color' in value && typeof value.color === 'string'
      && /^#[\da-f]{6}$/i.test(value.color)) return { status: 'picked', color: value.color.toUpperCase() };
  }
  return { status: 'failed' };
}

/** Create once per popup opening. A native failure never disables another opening. */
export function createScreenColorSession(sources: ScreenColorSources): ScreenColorSampler | null {
  if (!sources.native && !sources.browser) return null;
  let nativeFailed = false;
  let running = false;
  const invoke = async (sampler: ScreenColorSampler, signal: AbortSignal): Promise<ScreenColorResult> => {
    try {
      const result = await sampler.pick(signal);
      return signal.aborted ? { status: 'cancelled' } : normalizeScreenColorResult(result);
    } catch {
      return { status: signal.aborted ? 'cancelled' : 'failed' };
    }
  };
  return {
    async pick(signal) {
      if (signal.aborted) return { status: 'cancelled' };
      if (running) return { status: 'failed' };
      running = true;
      try {
        if (sources.native && !nativeFailed) {
          const result = await invoke(sources.native, signal);
          if (result.status !== 'failed') return result;
          nativeFailed = true;
        }
        // Attempt the browser fallback even if transient activation may have expired.
        if (signal.aborted) return { status: 'cancelled' };
        return sources.browser ? await invoke(sources.browser, signal) : { status: 'failed' };
      } finally {
        running = false;
      }
    },
  };
}

interface EyeDropperConstructor {
  new(): { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> };
}

/** Shared browser API adapter used by Web and the Electron renderer fallback. */
export function createBrowserScreenColorSampler(scope: {
  isSecureContext?: boolean; EyeDropper?: EyeDropperConstructor;
} = globalThis): ScreenColorSampler | null {
  const EyeDropper = scope.EyeDropper;
  if (!scope.isSecureContext || typeof EyeDropper !== 'function') return null;
  return {
    async pick(signal) {
      if (signal.aborted) return { status: 'cancelled' };
      try {
        // No asynchronous work before open(): preserve the click's user activation.
        const result = await new EyeDropper().open({ signal });
        return signal.aborted ? { status: 'cancelled' } : normalizeScreenColorResult({ status: 'picked', color: result.sRGBHex });
      } catch (error) {
        return { status: signal.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : 'failed' };
      }
    },
  };
}
