import { describe, expect, it } from 'vitest';
import type { SetupWizardCatalogue, ProfileActivation } from '@slicer/client';
import { activationFromSelection, eligibleFilaments, checkedFilaments, checkDefaultFilaments, filamentKey, modelKey, printerMatches, visibleFilaments, wizardModels } from './setupWizardSelection';
const catalogue: SetupWizardCatalogue = { models: [
  { vendor: 'A', model: 'M', name: 'Model', image: '', nozzle_diameter: ['0.4', '0.6'], default_materials: ['PLA @A'] },
  { vendor: 'B', model: 'Other', name: 'Other', image: '', nozzle_diameter: ['0.4'], default_materials: [] },
], filaments: [
  { vendor: 'Maker', type: 'PLA', name: 'PLA', presets: [
    { name: 'PLA @A', resource_vendor: 'A', compatible_models: [{ vendor: 'A', model: 'M', nozzle_diameter: ['0.4'] }] },
    { name: 'PLA 0.6 @A', resource_vendor: 'A', compatible_models: [{ vendor: 'A', model: 'M', nozzle_diameter: ['0.6'] }] },
    { name: 'PLA @B', resource_vendor: 'B', compatible_models: [] },
  ] },
  { vendor: 'Generic', type: 'PETG', name: 'PETG', presets: [{ name: 'PETG @Library', resource_vendor: 'OrcaFilamentLibrary', compatible_models: [] }] },
  { vendor: 'Maker', type: 'ABS', name: 'ABS', presets: [{ name: 'ABS @A', resource_vendor: 'A', compatible_models: [{ vendor: 'A', model: 'M', nozzle_diameter: ['0.8'] }] }] },
] };
const activation: ProfileActivation = { models: [catalogue.models[0]], filaments: ['PLA @A', 'Retired'] };
describe('Orca wizard selection projection', () => {
  it('admits printer vendors plus library and explicit nozzle overlap, independent of manufacturer', () => {
    const rows = eligibleFilaments(catalogue, activation.models);
    expect(rows.map(row => row.name)).toEqual(['PLA', 'PETG']);
    expect(rows[0].presets.map(preset => preset.name)).toEqual(['PLA @A', 'PLA 0.6 @A']);
    expect(eligibleFilaments(catalogue, []).map(row => row.name)).toEqual(['PETG']);
  });
  it('checks a partial group as binary checked and submits every eligible concrete member', () => {
    const rows = eligibleFilaments(catalogue, activation.models);
    const checked = checkedFilaments(rows, activation);
    const submitted = activationFromSelection(catalogue, activation, new Set([modelKey(catalogue.models[0])]), checked);
    expect(submitted.filaments).toEqual(['Retired', 'PLA @A', 'PLA 0.6 @A']);
    expect(submitted.models[0].nozzle_diameter).toEqual(['0.4', '0.6']);
  });
  it('filters only display; visible bulk changes preserve hidden rows and defaults can recheck', () => {
    const rows = eligibleFilaments(catalogue, activation.models);
    const checked = new Set(rows.map(filamentKey));
    const visible = visibleFilaments(rows, { model: modelKey(catalogue.models[0]), type: 'PLA', manufacturer: 'Maker', text: 'pla' }, activation.models, checked);
    visible.forEach(row => checked.delete(filamentKey(row)));
    expect(checked.has(filamentKey(rows[1]))).toBe(true);
    expect(checkDefaultFilaments(rows, [catalogue.models[0]], checked).has(filamentKey(rows[0]))).toBe(true);
  });
  it('coalesces model entries while preserving all nozzle variants and stale records', () => {
    const split = { ...catalogue, models: [catalogue.models[0], { ...catalogue.models[0], nozzle_diameter: ['0.8'] }] };
    expect(wizardModels(split)[0].nozzle_diameter).toEqual(['0.4', '0.6', '0.8']);
    const stale = { vendor: 'Retired', model: 'Gone', nozzle_diameter: ['0.4'] };
    expect(activationFromSelection(catalogue, { ...activation, models: [...activation.models, stale] }, new Set(), new Set()).models).toEqual([stale]);
  });
});

it('matches Orca printer token search in any order and filament substring/selection tags', () => {
 expect(printerMatches(catalogue.models[0], 'model A')).toBe(true);
 expect(printerMatches(catalogue.models[0], 'A model')).toBe(true);
 expect(printerMatches(catalogue.models[0], 'unknown')).toBe(false);
 const rows = eligibleFilaments(catalogue, activation.models), checked = checkedFilaments(rows, activation);
 expect(visibleFilaments(rows, { model: '', type: '', manufacturer: '', text: '::checked' }, activation.models, checked).map(row => row.name)).toEqual(['PLA']);
 expect(visibleFilaments(rows, { model: '', type: '', manufacturer: '', text: '::unchecked' }, activation.models, checked).map(row => row.name)).toEqual(['PETG']);
});
