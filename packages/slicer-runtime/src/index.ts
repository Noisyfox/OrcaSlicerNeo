// Resolve the workspace client through a relative public barrel as well as
// the package's tsconfig path. This keeps consumers (including Vitest) from
// needing to know the runtime package's private alias configuration.
export * from '../../slicer-wasm/src/client/index';
export { slicerClient } from './slicer/slicerClient';
export { errorText } from './slicer/errors';
export * from './profiles';
export * from './bootstrap';
export * from './projectSession';
