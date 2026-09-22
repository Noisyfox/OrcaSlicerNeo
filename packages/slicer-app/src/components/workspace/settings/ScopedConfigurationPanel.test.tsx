// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScopedField } from './ScopedConfigurationPanel';
import type { ScopedConfigurationField } from './scopedConfigurationProjection';

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

async function renderField(overrides: Partial<ScopedConfigurationField> = {},
  onCommit = vi.fn(async (_field: ScopedConfigurationField, value: string) => value)) {
  const field: ScopedConfigurationField = { key: 'layer_height', label: 'Layer height', category: 'Quality',
    meta: { type: 'float' } as ScopedConfigurationField['meta'], value: '0.2', mixed: false,
    source: 'object', local: true, resettable: true, ...overrides };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ScopedField field={field}
    targets={[{ scope: 'object', id: '42', label: 'Object' }]}
    onCommit={onCommit} onReset={async () => {}} />));
  const input = container.querySelector('input')!;
  await act(async () => input.focus());
  const change = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const key = async (value: string) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  });
  return { input, change, key, onCommit };
}

describe('scoped field drafts', () => {
  it('retains a complete mixed-value draft until blur commits it', async () => {
    const { input, change, onCommit } = await renderField({ mixed: true, value: null, source: 'mixed' });
    for (const value of ['0', '0.2', '0.25']) {
      await change(value);
      expect(input.value).toBe(value);
    }
    await act(async () => input.blur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.anything(), '0.25');
  });

  it.each(['percent', 'float_or_percent'])('keeps native %s units visible and editable', async (type) => {
    const { input, change, key, onCommit } = await renderField({
      meta: { type } as ScopedConfigurationField['meta'], value: '100%',
    });
    expect(input.type).toBe('text');
    expect(input.value).toBe('100%');
    await change('125%');
    await key('Enter');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expect.anything(), '125%');
  });

  it('discards Escape without committing the draft from blur', async () => {
    const { input, change, key, onCommit } = await renderField();
    await change('0.4');
    await key('Escape');
    expect(input.value).toBe('0.2');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('reconciles a normalized no-op value and suppresses unchanged Enter', async () => {
    const onCommit = vi.fn(async () => '0.2');
    const { input, change, key } = await renderField({}, onCommit);
    await change('0.200');
    await key('Enter');
    expect(input.value).toBe('0.2');
    await key('Enter');
    expect(onCommit).toHaveBeenCalledOnce();
  });
});
