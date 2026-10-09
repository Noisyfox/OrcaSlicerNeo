import type { ProfileSnapshot, FilamentSessionSnapshot, PlateSessionSnapshot, NativeScopedConfigTransport } from './types';
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
  /** Display manufacturer/type/short-name groups from resolved system presets. */
  filaments: Array<{ vendor: string; type: string; name: string;
    presets: Array<{ name: string; resource_vendor: string;
      /** Empty mapping is unrestricted, matching Orca wizard behaviour. */
      compatible_models: ProfileActivation['models'] }> }>;
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
  plateSession: PlateSessionSnapshot;
  nativeScopedConfig: NativeScopedConfigTransport;
  configurationChanged: boolean;
} | SetupWizardError;

/** Preparation belongs to the open wizard. Apply only after saving its result. */
export interface SetupWizardMethods {
  openSetupWizardCatalogue(): Promise<SetupWizardCatalogueResult>;
  closeSetupWizardCatalogue(): Promise<SetupWizardCloseResult>;
  prepareProfileActivation(activation: ProfileActivation): Promise<ProfileActivationPreparationResult>;
  applyProfileActivation(): Promise<ProfileActivationApplicationResult>;
}
