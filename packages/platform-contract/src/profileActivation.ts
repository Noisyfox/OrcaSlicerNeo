import type { ProfileActivation } from '@slicer/client';

/** Validate persisted shape only. Native preparation resolves names and defaults. */
export function normalizeProfileActivation(value: unknown): ProfileActivation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'models' && key !== 'filaments') ||
      !Array.isArray(record.models) || !Array.isArray(record.filaments)) return undefined;
  const name = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const models: ProfileActivation['models'] = [];
  for (const candidate of record.models) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const item = candidate as Record<string, unknown>;
    if (Object.keys(item).some(key => !['vendor', 'model', 'nozzle_diameter'].includes(key)) ||
        !name(item.vendor) || /[\\/:\x00-\x1f\x7f]/.test(item.vendor) || ['.', '..'].includes(item.vendor) ||
        !name(item.model) || !Array.isArray(item.nozzle_diameter) ||
        item.nozzle_diameter.length === 0 || !item.nozzle_diameter.every(name)) return undefined;
    models.push({ vendor: item.vendor, model: item.model, nozzle_diameter: [...item.nozzle_diameter] });
  }
  if (!record.filaments.every(name)) return undefined;
  return { models, filaments: [...record.filaments] };
}

