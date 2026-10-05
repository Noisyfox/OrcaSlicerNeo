import { describe, expect, it } from 'vitest';
import { modelOutlineColour } from './ModelSelectionOutline';

describe('Orca selection outline contrast', () => {
  it('uses pale outlines for dark fills and blue-grey outlines for bright fills', () => {
    expect(modelOutlineColour('#008577')).toBe('#fcfcfc');
    expect(modelOutlineColour('#000000')).toBe('#fcfcfc');
    expect(modelOutlineColour('#ffffff')).toBe('#1c2a35');
    expect(modelOutlineColour('#ffff00')).toBe('#1c2a35');
  });
  it('uses the Orca 0.75 brightness threshold without treating red as a bright fill', () => {
    expect(modelOutlineColour('#bfbfbf')).toBe('#fcfcfc');
    expect(modelOutlineColour('#c0c0c0')).toBe('#1c2a35');
    expect(modelOutlineColour('#ff0000')).toBe('#fcfcfc');
  });
});
