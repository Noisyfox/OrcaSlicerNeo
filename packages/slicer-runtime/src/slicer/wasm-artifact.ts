export type WasmArtifactVariant = 'threaded' | 'serial';

/**
 * Start with the threaded artifact when the Worker supports it, but keep the
 * serial module as a recovery path. A damaged or partially deployed threaded
 * artifact must not prevent the application from starting on a capable host.
 */
export async function loadWasmArtifact<T>(
  preferred: WasmArtifactVariant,
  load: (variant: WasmArtifactVariant) => Promise<T>,
  onThreadedFailure: (error: unknown) => void = () => {},
): Promise<{ module: T; variant: WasmArtifactVariant }> {
  if (preferred === 'serial') return { module: await load('serial'), variant: 'serial' };

  try {
    return { module: await load('threaded'), variant: 'threaded' };
  } catch (error) {
    onThreadedFailure(error);
    return { module: await load('serial'), variant: 'serial' };
  }
}
