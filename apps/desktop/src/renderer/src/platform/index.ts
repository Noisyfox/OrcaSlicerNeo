import { slicerClient } from '../slicer/slicerClient';
import { createElectronAdapter } from './electronAdapter';

export const platform = createElectronAdapter(slicerClient);

export * from './contracts';
