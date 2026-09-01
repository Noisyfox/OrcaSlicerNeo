import { describe, expect, it } from 'vitest';
import { hasEnteredPreview, isAppTab, isPrepareTab, isPreviewTab, isWorkspaceTab } from './appTabs';

describe('app tab helpers', () => {
  it('recognizes only the four supported application tabs', () => {
    expect(['home', 'prepare', 'preview', 'device'].every(isAppTab)).toBe(true);
    expect(['', 'workspace', 'print', null, 1].some(isAppTab)).toBe(false);
  });

  it('keeps the Prepare and Preview policy predicates mutually exclusive', () => {
    expect(isWorkspaceTab('prepare')).toBe(true);
    expect(isWorkspaceTab('preview')).toBe(true);
    expect(isWorkspaceTab('home')).toBe(false);
    expect(isPrepareTab('prepare')).toBe(true);
    expect(isPreviewTab('preview')).toBe(true);
    expect(isPreviewTab(null)).toBe(false);
  });

  it('recognizes only a transition into Preview', () => {
    expect(hasEnteredPreview('prepare', 'preview')).toBe(true);
    expect(hasEnteredPreview('home', 'preview')).toBe(true);
    expect(hasEnteredPreview('preview', 'preview')).toBe(false);
    expect(hasEnteredPreview('preview', 'prepare')).toBe(false);
  });
});
