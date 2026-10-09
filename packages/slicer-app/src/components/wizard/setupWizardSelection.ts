import type { ProfileActivation, SetupWizardCatalogue } from '@slicer/client';

export type WizardModel = SetupWizardCatalogue['models'][number];
export type WizardFilament = SetupWizardCatalogue['filaments'][number];
export interface FilamentFilters { model: string; type: string; manufacturer: string; text: string }
export const modelKey = (model: Pick<WizardModel, 'vendor' | 'model'>) => JSON.stringify([model.vendor, model.model]);
export const filamentKey = (group: WizardFilament) => JSON.stringify([group.vendor, group.type, group.name]);

/** Model controls represent every declared nozzle, including split catalogue fixtures. */
export function wizardModels(catalogue: SetupWizardCatalogue): WizardModel[] {
  const models = new Map<string, WizardModel>();
  for (const model of catalogue.models) {
    const key = modelKey(model), previous = models.get(key);
    models.set(key, previous ? { ...previous,
      nozzle_diameter: [...new Set([...previous.nozzle_diameter, ...model.nozzle_diameter])],
      default_materials: [...new Set([...previous.default_materials, ...model.default_materials])],
    } : { ...model });
  }
  // Orca's guide sorts only vendors, then moves Custom to the front. Stable
  // sorting retains manifest model order inside each vendor and nozzle order.
  return [...models.values()].sort((a, b) => {
    if (a.vendor === b.vendor) return 0;
    if (a.vendor === 'Custom') return -1;
    if (b.vendor === 'Custom') return 1;
    return a.vendor.localeCompare(b.vendor);
  });
}

/** Orca wizard explicit mapping, independent of workspace compatibility expressions. */
export function eligibleFilaments(catalogue: SetupWizardCatalogue, models: ProfileActivation['models']): WizardFilament[] {
  const vendors = new Set(models.map(model => model.vendor));
  return catalogue.filaments.flatMap(group => {
    const presets = group.presets.filter(preset =>
      (preset.resource_vendor === 'OrcaFilamentLibrary' || vendors.has(preset.resource_vendor)) &&
      (preset.compatible_models.length === 0 || preset.compatible_models.some(compatible => models.some(model =>
        modelKey(model) === modelKey(compatible) && model.nozzle_diameter.some(nozzle => compatible.nozzle_diameter.includes(nozzle))))));
    return presets.length ? [{ ...group, presets }] : [];
  });
}

export function printerMatches(model: WizardModel, search: string): boolean {
  const text = `${model.name}\0${model.vendor}`.toLocaleLowerCase();
  return (search.toLocaleLowerCase().match(/\S+/g) ?? []).every(word => text.includes(word));
}

export function visibleFilaments(groups: WizardFilament[], filters: FilamentFilters, models: ProfileActivation['models'], checked: ReadonlySet<string>): WizardFilament[] {
  const text = filters.text.trim().toLocaleLowerCase();
  return groups.filter(group => (!filters.type || group.type === filters.type) &&
    (!filters.manufacturer || group.vendor === filters.manufacturer) &&
    (!text || (text === '::checked' ? checked.has(filamentKey(group)) : text === '::unchecked' ? !checked.has(filamentKey(group)) : group.name.toLocaleLowerCase().includes(text))) &&
    (!filters.model || group.presets.some(preset => !preset.compatible_models.length ||
      preset.compatible_models.some(compatible => modelKey(compatible) === filters.model && models.some(model => modelKey(model) === filters.model && model.nozzle_diameter.some(nozzle => compatible.nozzle_diameter.includes(nozzle)))))));
}

export function checkedFilaments(groups: WizardFilament[], activation: ProfileActivation): Set<string> {
  return new Set(groups.filter(group => group.presets.some(preset => activation.filaments.includes(preset.name))).map(filamentKey));
}

export function activationFromSelection(catalogue: SetupWizardCatalogue, original: ProfileActivation,
  selectedModels: ReadonlySet<string>, selectedGroups: ReadonlySet<string>): ProfileActivation {
  const knownModels = wizardModels(catalogue);
  const knownKeys = new Set(knownModels.map(modelKey));
  const models = [...original.models.filter(model => !knownKeys.has(modelKey(model))),
    ...knownModels.filter(model => selectedModels.has(modelKey(model))).map(({ vendor, model, nozzle_diameter }) => ({ vendor, model, nozzle_diameter }))];
  const groups = eligibleFilaments(catalogue, models);
  const admitted = new Set(groups.flatMap(group => group.presets.map(preset => preset.name)));
  return { models, filaments: [...new Set([...original.filaments.filter(name => !admitted.has(name)),
    ...groups.filter(group => selectedGroups.has(filamentKey(group))).flatMap(group => group.presets.map(preset => preset.name))])] };
}

export function checkDefaultFilaments(groups: WizardFilament[], models: WizardModel[], checked: ReadonlySet<string>): Set<string> {
  const defaults = new Set(models.flatMap(model => model.default_materials));
  return new Set([...checked, ...groups.filter(group => group.presets.some(preset => defaults.has(preset.name))).map(filamentKey)]);
}
