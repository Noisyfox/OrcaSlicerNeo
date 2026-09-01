import models from '../../resources/handy-models.json';

/**
 * The shared app owns the user-facing handy-model catalogue. Its data files
 * remain in the pinned slicer submodule and are staged for each host from the
 * adjacent JSON manifest by `scripts/stage-handy-models.mjs`.
 */
export interface HandyModel {
  label: string;
  files: string[];
}

export const HANDY_MODELS: readonly HandyModel[] = models;
