// Resolve the workspace client through a relative public barrel as well as
// the package's tsconfig path. This keeps consumers (including Vitest) from
// needing to know the runtime package's private alias configuration.
export * from './core';
export { slicerClient } from './slicer/slicerClient';
