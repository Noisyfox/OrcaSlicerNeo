import { describe, expect, it } from 'vitest';
import { normalizeUserPreferences } from './contracts';

const activation = { models: [{ vendor: 'MissingVendor', model: 'Renamed model', nozzle_diameter: ['0.4', '0.6'] }],
  filaments: ['Old PLA @Missing printer'] };

describe('persisted profile activation', () => {
  it('round trips explicit vendor identities and stale names without source lookup', () => {
    const source = { version: 1, profileActivation: activation, selectedProfiles: { printer: 'P' },
      rememberedBedTypes: { P: 'Textured PEI Plate' }, ui: { sidebarWidth: 321 } };
    const normalized = normalizeUserPreferences(JSON.parse(JSON.stringify(source)));
    expect(normalized.profileActivation).toEqual(activation);
    expect(normalized).toMatchObject({ selectedProfiles: source.selectedProfiles,
      rememberedBedTypes: source.rememberedBedTypes, ui: source.ui });
    normalized.profileActivation!.models[0]!.nozzle_diameter.push('0.8');
    expect(activation.models[0]!.nozzle_diameter).toEqual(['0.4', '0.6']);
  });
  it.each([undefined, null, [], {}, { version: 2, ...activation },
    { models: [{ model: 'P', nozzle_diameter: ['0.4'] }], filaments: [] },
    { models: [{ vendor: 'C:', model: 'P', nozzle_diameter: ['0.4'] }], filaments: [] },
    { models: [{ vendor: '../BBL', model: 'P', nozzle_diameter: ['0.4'] }], filaments: [] },
    { models: [{ vendor: 'BBL', model: 'P', nozzle_diameter: [] }], filaments: [] },
    { models: [{ vendor: 'BBL', model: 'P', nozzle_diameter: [0.4] }], filaments: [] },
    { ...activation, filaments: [''] }, { ...activation, filaments: 'PLA' },
  ])('treats a missing or invalid record as absent, preserving other readable fields: %j', value => {
    const normalized = normalizeUserPreferences({ version: 1, profileActivation: value,
      selectedProfiles: { printer: 'P' }, ui: { sidebarWidth: 321 } });
    expect(normalized).not.toHaveProperty('profileActivation');
    expect(normalized.selectedProfiles.printer).toBe('P');
    expect(normalized.ui.sidebarWidth).toBe(321);
  });
  it('preserves an empty selection for native usable-printer detection', () => {
    expect(normalizeUserPreferences({ version: 1, profileActivation: { models: [], filaments: [] } }).profileActivation)
      .toEqual({ models: [], filaments: [] });
  });
});
