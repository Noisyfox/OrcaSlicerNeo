import type { OrcaModule } from './types';

/** Host setup only: mount before initialization opens logs or temporary files.
 * This is deliberately outside SlicerClient and the renderer Worker protocol.
 */
export function mountNativeTemporaryDirectory(module: OrcaModule, directory: string): void {
  if (!directory || directory.includes('\0') ||
      !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(directory))) {
    throw new Error('The native temporary directory must be an absolute host path');
  }
  const fs = module.FS;
  const nodefs = fs.filesystems?.NODEFS;
  if (!nodefs || !fs.mount || !fs.readdir) {
    throw new Error('The threaded WASM artifact does not provide NODEFS');
  }
  // Emscripten creates /tmp before resolving its module factory. Refuse to
  // hide files if a future startup change uses it before the host is ready.
  if (fs.readdir('/tmp').some((name) => name !== '.' && name !== '..')) {
    throw new Error('The temporary filesystem must be mounted before first use');
  }
  fs.mount(nodefs, { root: directory }, '/tmp');
}
