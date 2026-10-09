import type { ProfileSnapshot, FilamentSessionSnapshot } from './types';
import type { HistoryStatus } from './history';

/** Global availability, independent of the project's selected presets. */
export interface ProfileActivation {
  models: Array<{ vendor: string; model: string; nozzle_diameter: string[] }>;
  filaments: string[];
}

export interface SetupWizardCatalogue {
  /** Resource vendor, never the material's display manufacturer. */
  models: Array<{ vendor: string; model: string; name: string; image: string;
    nozzle_diameter: string[]; default_materials: string[] }>;
  /** Concrete members are already filtered using Orca's explicit mapping. */
  filaments: Array<{ vendor: string; type: string; name: string;
    presets: Array<{ name: string; compatible_models: ProfileActivation['models'] }> }>;
}

export interface SetupWizardError { ok: false; error: string }
export type SetupWizardCatalogueResult = { ok: true; catalogue: SetupWizardCatalogue } | SetupWizardError;
export type SetupWizardCloseResult = { ok: true } | SetupWizardError;
export type ProfileActivationPreparationResult = { ok: true; activation: ProfileActivation } | SetupWizardError;
export type ProfileActivationApplicationResult = {
  ok: true;
  profileSnapshot: ProfileSnapshot;
  filamentSession: FilamentSessionSnapshot;
  historyStatus: HistoryStatus;
  configurationChanged: boolean;
} | SetupWizardError;

/** Preparation belongs to the open wizard. Apply only after saving its result. */
export interface SetupWizardMethods {
  openSetupWizardCatalogue(): Promise<SetupWizardCatalogueResult>;
  closeSetupWizardCatalogue(): Promise<SetupWizardCloseResult>;
  prepareProfileActivation(activation: ProfileActivation): Promise<ProfileActivationPreparationResult>;
  applyProfileActivation(): Promise<ProfileActivationApplicationResult>;
}
