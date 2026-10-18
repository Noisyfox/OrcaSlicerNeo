// @vitest-environment jsdom
import { act, memo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { OptionStateScope } from './optionStateRegistry';
import { useOptionState } from './useOptionState';
import { editorSettingContext } from './settingConditionContext';
import type { UpdateOptionStates } from './settingConditions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const ctx = editorSettingContext(null, null, { scope: 'project' });
const rows = ['a', 'b', 'untouched'].map(key => ({ key, data: key, signature: key }));

describe('option registry publication and React subscriptions', () => {
  it('publishes atomically, notifies only changed keys, and resets omitted branches', () => {
    const scope = new OptionStateScope<string>();
    const first: UpdateOptionStates = (_, ui) => { ui.toggleLine('a', false); ui.toggleField('b', false); };
    scope.publish(rows, [ctx], first, 'first');
    const a = scope.get('a'), b = scope.get('b'), untouched = scope.get('untouched');
    const listener = vi.fn(() => expect(scope.get('b')?.readOnly).toBe(false));
    const noChange = vi.fn();
    scope.subscribe('a', listener); scope.subscribe('untouched', noChange);
    scope.publish(rows, [ctx], () => {}, 'second');
    expect(scope.get('a')).not.toBe(a);
    expect(scope.get('b')).not.toBe(b);
    expect(scope.get('untouched')).toBe(untouched);
    expect(listener).toHaveBeenCalledOnce(); expect(noChange).not.toHaveBeenCalled();
    const published = scope.get('a');
    expect(() => scope.publish(rows, [ctx], (_, ui) => { ui.toggleLine('a', false); throw new Error('calculation failed'); }, 'failed')).toThrow('calculation failed');
    expect(scope.get('a')).toBe(published);
    const other = new OptionStateScope<string>();
    other.publish(rows, [ctx], first, 'first');
    expect(scope.get('a')?.visible).toBe(true);
    expect(other.get('a')?.visible).toBe(false);
  });

  it('renders only changed options and keeps their component and DOM instances while hidden', async () => {
    const scope = new OptionStateScope<string>();
    scope.publish(rows, [ctx], () => {}, 'initial');
    const renders = new Map<string, number>(), mounts = vi.fn(), unmounts = vi.fn();
    const Row = memo(function Row({ option }: { option: string }) {
      const state = useOptionState(scope, option)!;
      renders.set(option, (renders.get(option) ?? 0) + 1);
      useEffect(() => { mounts(option); return () => unmounts(option); }, [option]);
      return <div hidden={!state.visible}><input data-option={option} defaultValue={state.data} disabled={state.readOnly} /></div>;
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<>{rows.map(row => <Row key={row.key} option={row.key} />)}</>));
      const input = container.querySelector<HTMLInputElement>('[data-option="a"]')!;
      input.value = 'uncommitted';
      const before = new Map(renders);
      await act(async () => scope.publish(rows, [ctx], (_, ui) => { ui.toggleLine('a', false); ui.toggleField('b', false); }, 'changed'));
      expect(renders.get('a')).toBe(before.get('a')! + 1);
      expect(renders.get('b')).toBe(before.get('b')! + 1);
      expect(renders.get('untouched')).toBe(before.get('untouched'));
      expect(input.parentElement!.hidden).toBe(true);
      expect(container.querySelector('[data-option="a"]')).toBe(input);
      expect(container.querySelector<HTMLInputElement>('[data-option="b"]')!.disabled).toBe(true);
      const after = new Map(renders);
      await act(async () => scope.publish(rows.map(row => ({ ...row })), [ctx], () => {}, 'restored'));
      expect(input.parentElement!.hidden).toBe(false);
      expect(input.value).toBe('uncommitted');
      expect(mounts).toHaveBeenCalledTimes(3); expect(unmounts).not.toHaveBeenCalled();
      expect(renders.get('untouched')).toBe(after.get('untouched'));
      const stable = new Map(renders);
      const noop = () => {};
      await act(async () => scope.publish(rows, [ctx], noop, 'same'));
      expect(renders).toEqual(stable);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
