export const PRINTER_CONFIGURATION_VERSION = 1 as const;
export const BUILT_IN_PRINTER_DRIVER_IDS = ['moonraker'] as const;
export type BuiltInPrinterDriverId = typeof BUILT_IN_PRINTER_DRIVER_IDS[number];
export type PrinterDriverId = BuiltInPrinterDriverId;

export interface PrinterConfiguration {
  id: string;
  displayName: string;
  driverId: PrinterDriverId;
  consoleUrl: string;
  apiBaseUrl: string;
  /** Kept complete in the configuration document; never included in errors. */
  apiKey: string;
}

export interface PrinterConfigurationDocument {
  version: typeof PRINTER_CONFIGURATION_VERSION;
  printers: PrinterConfiguration[];
}

export class PrinterConfigurationValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid printer configuration: ${issues.join('; ')}`);
    this.name = 'PrinterConfigurationValidationError';
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeUrl(value: unknown, field: string, issues: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${field} must be a non-empty URL`);
    return '';
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push(`${field} must use http or https`);
    }
    if (parsed.username || parsed.password) {
      issues.push(`${field} must not contain credentials`);
    }
    // URL.href is the canonical URL form (including a trailing slash for a
    // bare host) while retaining any configured proxy path and port.
    return parsed.href;
  } catch {
    issues.push(`${field} must be a valid http or https URL`);
    return '';
  }
}

function normalizeOptionalUrl(value: unknown, field: string, issues: string[]): string {
  // An omitted or blank console URL intentionally means "use apiBaseUrl".
  // Keep the stored value blank so editing does not silently replace the
  // user's endpoint with a derived value.
  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) return '';
  return normalizeUrl(value, field, issues);
}

/**
 * Parse, validate, and canonicalize a version-1 printer document.
 * No network request is made. A failed parse is deliberately explicit so a
 * host can discard the document without accidentally operating on bad data.
 */
export function normalizePrinterConfigurationDocument(value: unknown): PrinterConfigurationDocument {
  const issues: string[] = [];
  if (!isRecord(value) || value.version !== PRINTER_CONFIGURATION_VERSION) {
    issues.push('version must be 1');
  }
  const rawPrinters = isRecord(value) ? value.printers : undefined;
  if (!Array.isArray(rawPrinters)) {
    issues.push('printers must be an array');
  }

  const printers: PrinterConfiguration[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of (Array.isArray(rawPrinters) ? rawPrinters : []).entries()) {
    const prefix = `printers[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${prefix} must be an object`);
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) issues.push(`${prefix}.id must be a non-empty stable id`);
    else if (ids.has(id)) issues.push(`${prefix}.id must be unique`);
    else ids.add(id);

    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    if (!displayName) issues.push(`${prefix}.displayName must be a non-empty string`);

    const driverId = raw.driverId;
    if (!BUILT_IN_PRINTER_DRIVER_IDS.includes(driverId as BuiltInPrinterDriverId)) {
      issues.push(`${prefix}.driverId is not a supported built-in driver`);
    }

    const consoleUrl = normalizeOptionalUrl(raw.consoleUrl, `${prefix}.consoleUrl`, issues);
    const apiBaseUrl = normalizeUrl(raw.apiBaseUrl, `${prefix}.apiBaseUrl`, issues);
    if (typeof raw.apiKey !== 'string') issues.push(`${prefix}.apiKey must be a string`);

    if (id && displayName && BUILT_IN_PRINTER_DRIVER_IDS.includes(driverId as BuiltInPrinterDriverId)
      && apiBaseUrl && typeof raw.apiKey === 'string') {
      printers.push({
        id,
        displayName,
        driverId: driverId as PrinterDriverId,
        consoleUrl,
        apiBaseUrl,
        // Do not trim, truncate, or otherwise alter credentials.
        apiKey: raw.apiKey,
      });
    }
  }

  if (issues.length > 0) throw new PrinterConfigurationValidationError(issues);
  return { version: PRINTER_CONFIGURATION_VERSION, printers };
}

/** Alias emphasizing that this function performs validation as well as normalization. */
export const validatePrinterConfigurationDocument = normalizePrinterConfigurationDocument;

export function isPrinterConfigurationDocument(value: unknown): value is PrinterConfigurationDocument {
  try {
    normalizePrinterConfigurationDocument(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizePrinterConfiguration(value: unknown): PrinterConfiguration {
  const document = normalizePrinterConfigurationDocument({ version: 1, printers: [value] });
  return document.printers[0];
}
