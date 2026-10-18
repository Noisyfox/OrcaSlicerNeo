import { describe, expect, it } from 'vitest';
import { all, any, not, settingValues, type SettingConditionContext } from './settingConditions';
import { OptionStateScope } from './optionStateRegistry';
import { editorSettingContext } from './settingConditionContext';
import type { ConfigEditorSnapshot } from '@slicer/client';

const context = (values: Record<string, string>): SettingConditionContext => ({
  ...settingValues(key => values[key]), printer: settingValues(() => undefined), project: settingValues(() => undefined),
  scope: 'object', isBblPrinter: undefined, nozzleCount: undefined,
});

describe('shared setting conditions', () => {
  it('runs a complete function once per target and batches multiple options', () => {
    const scope = new OptionStateScope<string>();
    let calls = 0;
    const calculate = (ctx: SettingConditionContext, ui: import('./settingConditions').OptionToggles) => {
      calls++;
      const enabled = ctx.boolean('enabled');
      ui.toggleLine(['a', 'b'], enabled);
      ui.toggleField('b', enabled);
    };
    const rows = ['a', 'b'].map(key => ({ key, data: key, signature: key }));
    scope.publish(rows, [context({ enabled: '0' })], calculate, 'off');
    expect(calls).toBe(1);
    expect(scope.get('a')?.visible).toBe(false);
    expect(scope.get('b')?.readOnly).toBe(true);
    scope.publish(rows, [context({ enabled: '0' })], calculate, 'off');
    expect(calls).toBe(1);
    scope.publish(rows, [context({ enabled: '0' }), context({ enabled: '1' })], calculate, 'mixed');
    expect(calls).toBe(3);
    expect(scope.get('b')).toMatchObject({ visible: true, readOnly: true });
  });

  it('propagates unknown without hiding or adding a read-only lock', () => {
    expect(all(undefined, false)).toBe(false);
    expect(any(undefined, true)).toBe(true);
    expect(not(undefined)).toBeUndefined();
    const scope = new OptionStateScope<string>();
    scope.publish([{ key: 'a', data: 'a', signature: 'a' }], [context({})], (ctx, ui) => {
      ui.toggleLine('a', ctx.boolean('missing'));
      ui.toggleField('a', ctx.boolean('missing'));
    }, 'unknown');
    expect(scope.get('a')).toMatchObject({ visible: true, readOnly: false });
  });

  it('uses each controlling key native mapping and preserves unavailable and nullable values', () => {
    const snapshot = {
      effectiveValues: { control: '0,1', nullable: 'nil' },
      editorSelection: { choices: [{ id: 'head' }], fieldBindings: {
        control: { kind: 'per_selection', bindings: [{ kind: 'indexed', index: 1 }] },
        nullable: { kind: 'per_selection', bindings: [{ kind: 'indexed', index: 0 }] },
      } },
      editorVectors: {
        control: { scalarType: 'bool', effectiveValues: [false, true], indexCount: 2 },
        nullable: { scalarType: 'float', effectiveValues: [null], indexCount: 1 },
      },
    } as unknown as ConfigEditorSnapshot;
    const values = editorSettingContext(snapshot, 'head', { scope: 'printer', projectValues: { control: '0', inherited: '4' } });
    expect(values.boolean('control')).toBe(true);
    expect(values.value('nullable')).toBeNull();
    expect(values.number('nullable')).toBeUndefined();
    expect(values.number('inherited')).toBeUndefined(); // A browsed preset never borrows another preset's values.
    expect(editorSettingContext(snapshot, 'head', { scope: 'object', projectValues: { inherited: '4' } }).number('inherited')).toBe(4);
    expect(editorSettingContext(snapshot, null, { scope: 'printer', projectValues: { control: '0' } }).boolean('control')).toBeUndefined();
  });
});
