import { describe, expect, it } from 'vitest';
import { isCurrentRendererSender } from './rendererGuards';

function contents() { return { isDestroyed: () => false }; }

describe('main renderer sender guard', () => {
  it('accepts only the active, live window contents', () => {
    const sender = contents();
    const other = contents();
    const window = { isDestroyed: () => false, webContents: sender };
    expect(isCurrentRendererSender(sender, window)).toBe(true);
    expect(isCurrentRendererSender(other, window)).toBe(false);
    expect(isCurrentRendererSender(sender, null)).toBe(false);
    expect(isCurrentRendererSender(sender, { ...window, isDestroyed: () => true })).toBe(false);
    expect(isCurrentRendererSender({ isDestroyed: () => true }, window)).toBe(false);
  });
});
