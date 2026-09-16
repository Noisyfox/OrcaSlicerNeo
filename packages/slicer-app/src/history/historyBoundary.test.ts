import { describe, expect, it } from 'vitest';
/**
 * Native history has one application owner.  This source boundary is
 * deliberately deterministic so a new feature cannot silently recreate the
 * revision/fence choreography that caused stale filament commands.
 */
describe('application history boundary', () => {
  it('keeps native history calls inside the central coordinator', () => {
    const files = import.meta.glob('../**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const bypasses: string[] = [];
    const nativeHistoryCall = /\b(?:runtime|platform\.runtime)\.(?:runProjectHistoryTransaction|beginHistory|commitHistory|abortHistory|undoHistory|redoHistory|jumpHistory)\s*\(/;
    const manualFence = /\b(?:runtime|platform\.runtime)\.(?:getHistoryStatus|markHistorySaved|resetHistory)\s*\(/;
    const gateImport = /from\s+['"][^'"]*history\/projectMutationGate['"]/;
    const gateCall = /\b(?:acquireProjectMutationLease|enqueueProjectMutationOperation)\s*\(/;
    const gateOwners = /(?:\/components\/workspace\/actions\/historyMutation\.ts|\/stores\/useFilamentSessionStore\.ts|(?:\/|\.)projectMutationGate\.ts)$/;
    for (const [file, source] of Object.entries(files)) {
      if (/\.test\.[tj]sx?$/.test(file) || file.endsWith('/components/workspace/actions/historyMutation.ts')) continue;
      if (nativeHistoryCall.test(source) || manualFence.test(source) ||
        ((gateImport.test(source) || gateCall.test(source)) && !gateOwners.test(file))) bypasses.push(file);
    }
    expect(bypasses).toEqual([]);
  });

  it('does not poll native history from the toolbar', () => {
    const files = import.meta.glob('../components/layout/Toolbar.tsx', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const toolbar = Object.values(files)[0] ?? '';
    expect(toolbar).not.toMatch(/setInterval\s*\(/);
    expect(toolbar).not.toMatch(/syncHistoryStatus\s*\(/);
  });

  it('keeps selection and active-plate UI context out of standalone history calls', () => {
    const files = import.meta.glob('../**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const contextRecorders = Object.entries(files)
      .filter(([file]) => !/\.test\.[tj]sx?$/.test(file))
      .filter(([, source]) => /\brecord(?:Project)?HistoryContext\s*\(/.test(source))
      .map(([file]) => file);
    expect(contextRecorders).toEqual([]);
  });
});
