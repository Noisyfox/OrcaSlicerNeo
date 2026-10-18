import type { OptionToggles, SettingConditionContext, UpdateOptionStates } from './settingConditions';

export interface OptionPresentation { readonly visible: boolean; readonly readOnly: boolean }
export interface OptionState<T> extends OptionPresentation { readonly data: T }
export interface OptionPublication<T> { readonly key: string; readonly data: T; readonly signature: string }
const DEFAULT_PRESENTATION: OptionPresentation = Object.freeze({ visible: true, readOnly: false });

/** An isolated editor namespace. All snapshots change before any subscriber is notified. */
export class OptionStateScope<T> {
  private states = new Map<string, OptionState<T>>();
  private signatures = new Map<string, string>();
  private listeners = new Map<string, Set<() => void>>();
  private conditionInput: string | undefined;
  private calculation: UpdateOptionStates | undefined;

  get = (key: string): OptionState<T> | undefined => this.states.get(key);
  subscribe = (key: string, listener: () => void) => {
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  };

  publish(rows: readonly OptionPublication<T>[], contexts: readonly SettingConditionContext[], calculate: UpdateOptionStates, input: string) {
    const conditionInput = JSON.stringify([input, rows.map(row => row.key)]);
    const recalculate = conditionInput !== this.conditionInput || calculate !== this.calculation;
    const presentations = new Map<string, OptionPresentation>();
    if (recalculate) {
      for (const context of contexts) {
        const target = new Map<string, OptionPresentation>();
        const set = (keys: string | readonly string[], property: keyof OptionPresentation, value: boolean) => {
          for (const key of typeof keys === 'string' ? [keys] : keys)
            target.set(key, { ...(target.get(key) ?? DEFAULT_PRESENTATION), [property]: value });
        };
        const ui: OptionToggles = {
          toggleLine: (keys, visible) => set(keys, 'visible', visible !== false),
          toggleField: (keys, enabled) => set(keys, 'readOnly', enabled === false),
        };
        calculate(context, ui);
        for (const { key } of rows) {
          const current = target.get(key) ?? DEFAULT_PRESENTATION;
          const previous = presentations.get(key);
          presentations.set(key, previous ? { visible: previous.visible || current.visible, readOnly: previous.readOnly || current.readOnly } : current);
        }
      }
    }
    const next = new Map<string, OptionState<T>>();
    const signatures = new Map<string, string>();
    const changed = new Set<string>();
    for (const row of rows) {
      const previous = this.states.get(row.key);
      const presentation = recalculate ? presentations.get(row.key) ?? DEFAULT_PRESENTATION : previous ?? DEFAULT_PRESENTATION;
      const sameData = previous && this.signatures.get(row.key) === row.signature;
      const same = sameData && previous.visible === presentation.visible && previous.readOnly === presentation.readOnly;
      next.set(row.key, same ? previous : { ...presentation, data: sameData ? previous.data : row.data });
      signatures.set(row.key, row.signature);
      if (!same) changed.add(row.key);
    }
    for (const key of this.states.keys()) if (!next.has(key)) changed.add(key);
    this.states = next;
    this.signatures = signatures;
    this.conditionInput = conditionInput;
    this.calculation = calculate;
    const notifications = new Set<() => void>();
    for (const key of changed) for (const listener of this.listeners.get(key) ?? []) notifications.add(listener);
    for (const listener of notifications) listener();
  }
}

/** Global directory; namespaces are retained only for mounted editor sessions. */
class OptionStateRegistry {
  private scopes = new Set<object>();
  retain(scope: object) { this.scopes.add(scope); return () => { this.scopes.delete(scope); }; }
  get size() { return this.scopes.size; }
}
export const optionStateRegistry = new OptionStateRegistry();
