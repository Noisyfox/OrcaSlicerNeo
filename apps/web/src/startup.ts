import type { WebCapabilities } from './capabilities';

export interface WebStartupState { serialFallback: boolean; }

export interface WebStartupDeps {
  detect: () => WebCapabilities;
  isolated: boolean;
  loadRuntime: () => Promise<unknown>;
  render: (runtime: unknown, state: WebStartupState) => void;
  unsupported: (detail: string) => void;
  failed: (error: unknown) => void;
}

/** Capability gate kept separate from the DOM entry so it can be exercised
 * without starting a Worker or importing the runtime module. */
export async function startWebApp(deps: WebStartupDeps): Promise<void> {
  const capabilities = deps.detect();
  if (!capabilities.webgl2 || !capabilities.wasm64) {
    deps.unsupported('OrcaSlicerNeo Web requires WebGL 2 and wasm64 (Chrome 133 or later).');
    return;
  }
  try {
    const runtime = await deps.loadRuntime();
    // The runtime makes the same decision inside its Worker. Keep the UI
    // status tied to the capability probe (isolation plus SAB), not merely to
    // the page header, so a deliberately reduced test path reports reality.
    deps.render(runtime, { serialFallback: !capabilities.threadedWasm });
  } catch (error) {
    deps.failed(error);
  }
}
