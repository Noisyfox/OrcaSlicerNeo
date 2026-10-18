export type SettingConditionValue = string | number | boolean | null | { readonly value: number; readonly percent: boolean };

export interface SettingValues {
  value(key: string): SettingConditionValue | undefined;
  boolean(key: string): boolean | undefined;
  number(key: string): number | undefined;
  numbers(key: string): readonly number[] | undefined;
  string(key: string): string | undefined;
}

export interface SettingConditionContext extends SettingValues {
  readonly scope: 'printer' | 'filament' | 'project' | 'object' | 'part' | 'plate';
  readonly printer: SettingValues;
  readonly project: SettingValues;
  readonly isBblPrinter: boolean | undefined;
  readonly nozzleCount: number | undefined;
}

/** A calculation pass writes presentation only; it cannot mutate configuration. */
export interface OptionToggles {
  toggleLine(keys: string | readonly string[], visible: boolean | undefined): void;
  toggleField(keys: string | readonly string[], enabled: boolean | undefined): void;
}
export type UpdateOptionStates = (context: SettingConditionContext, ui: OptionToggles) => void;

export function settingValues(read: SettingValues['value'], readNumbers?: SettingValues['numbers']): SettingValues {
  return {
    value: read,
    boolean(key) {
      const value = read(key);
      if (value === true || value === '1') return true;
      if (value === false || value === '0') return false;
      return undefined;
    },
    number(key) {
      const value = read(key);
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (value && typeof value === 'object') return Number.isFinite(value.value) ? value.value : undefined;
      if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value.trim())) return undefined;
      return Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : undefined;
    },
    numbers(key) {
      if (readNumbers) return readNumbers(key);
      const value = read(key);
      if (typeof value === 'number') return Number.isFinite(value) ? [value] : undefined;
      if (typeof value !== 'string') return undefined;
      const parts = value.split(',').map(part => part.trim());
      return parts.every(part => part !== '' && Number.isFinite(Number(part))) ? parts.map(Number) : undefined;
    },
    string(key) {
      const value = read(key);
      return typeof value === 'string' ? value : undefined;
    },
  };
}

// Three-valued boolean helpers are useful inside complete calculation functions.
export const not = (value: boolean | undefined) => value === undefined ? undefined : !value;
export const all = (...values: readonly (boolean | undefined)[]) => values.includes(false) ? false : values.includes(undefined) ? undefined : true;
export const any = (...values: readonly (boolean | undefined)[]) => values.includes(true) ? true : values.includes(undefined) ? undefined : false;
export const greaterThan = (value: number | undefined, minimum = 0) => value === undefined ? undefined : value > minimum;
export const equalTo = (value: string | undefined, expected: string) => value === undefined ? undefined : value === expected;
export const oneOf = (value: string | undefined, expected: readonly string[]) => value === undefined ? undefined : expected.includes(value);
